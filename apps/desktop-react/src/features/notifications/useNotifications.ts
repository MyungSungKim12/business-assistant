import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Appointment, Customer, Task } from '../../api/schemas';
import { isRealFailure, loadAppointments, loadCustomers, loadTasks, loadWalletRecords, type WorkspaceDataApi } from '../../store/workspaceData';
import { addDays, kstDateKey } from './kstTime';
import { buildNotifications, walletRowsFrom, type NotificationItem, type NotificationSource } from './notificationModel';
import { loadReadIds, pruneReadIds, saveReadIds } from './readState';

export const REFRESH_INTERVAL_MS = 5 * 60_000;
const TICK_MS = 60_000;
/** 패널을 열 때 이 시간 안에 불러온 목록은 다시 요청하지 않는다. */
const OPEN_MAX_AGE_MS = 30_000;

export interface UseNotificationsOptions {
  api: WorkspaceDataApi;
  organizationId: string;
  userId: string;
  /** false 이면(잠금 중 등) 불러오지 않고 주기 갱신도 멈춘다. */
  enabled: boolean;
  /** 시계(테스트에서 주입). */
  now?: () => Date;
  intervalMs?: number;
}

export interface NotificationState {
  items: NotificationItem[];
  unreadCount: number;
  /** 읽지 않은 항목 중 강조 대상(임박·기한 지남 등)이 있는지 */
  hasUrgentUnread: boolean;
  loading: boolean;
  /** 일부 데이터를 불러오지 못했을 때 true(나머지 알림은 보여 준다). */
  partial: boolean;
  isRead(id: string): boolean;
  markRead(id: string): void;
  markAllRead(): void;
  /** 패널을 열 때 부른다. 최근에 불러온 값이 있으면 재사용한다. */
  refresh(force?: boolean): Promise<void>;
}

const EMPTY: NotificationSource = { appointments: [], tasks: [], customers: [], wallets: [] };

/** 기존 API로 알림 재료(예약·할 일·고객·회원권)를 불러와 알림 목록과 읽음 상태를 만든다(UX-03). */
export function useNotifications({ api, organizationId, userId, enabled, now = () => new Date(), intervalMs = REFRESH_INTERVAL_MS }: UseNotificationsOptions): NotificationState {
  const [source, setSource] = useState<NotificationSource>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [partial, setPartial] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [tick, setTick] = useState(0);
  const [read, setRead] = useState<Set<string>>(() => loadReadIds(userId));
  const alive = useRef(true);
  const nowRef = useRef(now);
  nowRef.current = now;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setRead(loadReadIds(userId)); }, [userId]);

  const refresh = useCallback(async (force = false) => {
    if (!enabled) return;
    const maxAge = force ? 0 : OPEN_MAX_AGE_MS;
    const today = kstDateKey(nowRef.current());
    setLoading(true);
    // KST 날짜 경계와 서버 날짜 해석 차이를 위해 하루씩 여유를 둔다.
    const results = await Promise.allSettled([
      loadAppointments(api, organizationId, addDays(today, -1), addDays(today, 2), maxAge),
      loadTasks(api, organizationId, maxAge),
      loadCustomers(api, organizationId, maxAge),
      loadWalletRecords(api, organizationId, maxAge),
    ]);
    if (!alive.current) return;
    const [appointments, tasks, customers, wallets] = results;
    setSource({
      appointments: appointments.status === 'fulfilled' ? (appointments.value as Appointment[]) : [],
      tasks: tasks.status === 'fulfilled' ? (tasks.value as Task[]) : [],
      customers: customers.status === 'fulfilled' ? (customers.value as Customer[]) : [],
      wallets: wallets.status === 'fulfilled' ? walletRowsFrom(wallets.value) : [],
    });
    const failed = results.some(isRealFailure);
    setPartial(failed);
    setLoaded(!failed);
    setLoading(false);
  }, [api, enabled, organizationId]);

  // 처음 한 번과 5분마다 갱신한다.
  useEffect(() => {
    if (!enabled) return undefined;
    void refresh(true);
    const timer = window.setInterval(() => { void refresh(true); }, intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, intervalMs, refresh]);

  // 임박 표시·오늘/내일 구분이 시간이 지나며 바뀌도록 1분마다 다시 계산한다.
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = window.setInterval(() => setTick((value) => value + 1), TICK_MS);
    return () => window.clearInterval(timer);
  }, [enabled]);

  // tick 은 계산을 다시 하게 하는 의존성이다.
  const items = useMemo(() => buildNotifications(source, now()), [source, tick]);

  // 첫 불러오기가 모두 성공한 뒤에만 지난 알림의 읽음 기록을 정리한다.
  useEffect(() => {
    if (!loaded || partial || loading) return;
    setRead((current) => {
      const pruned = pruneReadIds(current, items.map((item) => item.id));
      if (pruned.size === current.size) return current;
      saveReadIds(userId, pruned);
      return pruned;
    });
  }, [items, loaded, loading, partial, userId]);

  const markRead = useCallback((id: string) => {
    setRead((current) => {
      if (current.has(id)) return current;
      const next = new Set(current).add(id);
      saveReadIds(userId, next);
      return next;
    });
  }, [userId]);

  const markAllRead = useCallback(() => {
    setRead((current) => {
      const next = new Set([...current, ...items.map((item) => item.id)]);
      saveReadIds(userId, next);
      return next;
    });
  }, [items, userId]);

  const unread = items.filter((item) => !read.has(item.id));
  return {
    items, unreadCount: unread.length, hasUrgentUnread: unread.some((item) => item.urgent),
    loading, partial, isRead: (id) => read.has(id), markRead, markAllRead, refresh,
  };
}
