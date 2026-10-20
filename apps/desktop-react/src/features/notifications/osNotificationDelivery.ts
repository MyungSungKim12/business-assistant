import { useEffect, useRef } from 'react';
import type { Platform } from '../../platform/types';
import type { NotificationItem } from './notificationModel';

const STORAGE_PREFIX = 'business-assistant.os-notifications.sent.';
const MAX_SENT_IDS = 500;

export function osNotificationStorageKey(userId: string, organizationId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(userId)}.${encodeURIComponent(organizationId)}`;
}

export function pendingOsNotifications(items: NotificationItem[], sentIds: ReadonlySet<string>, now: Date): NotificationItem[] {
  return items.filter((item) => {
    if (item.kind !== 'appointment' && item.kind !== 'task') return false;
    if (!item.osNotifyAt || sentIds.has(item.id)) return false;
    const notifyAt = Date.parse(item.osNotifyAt);
    return Number.isFinite(notifyAt) && notifyAt <= now.getTime();
  });
}

export function notificationMessage(item: NotificationItem): { title: string; body: string } {
  return item.kind === 'appointment'
    ? { title: '예약 임박', body: '예약이 1시간 이내에 시작합니다. 앱에서 확인하세요.' }
    : { title: '할 일 기한', body: '마감 시각이 되었습니다. 앱에서 확인하세요.' };
}

function readSentIds(key: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(parsed) ? new Set(parsed.filter((value): value is string => typeof value === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function saveSentIds(key: string, sentIds: ReadonlySet<string>): void {
  try { localStorage.setItem(key, JSON.stringify([...sentIds].slice(-MAX_SENT_IDS))); } catch { /* 다음 앱 실행에서만 중복 방지가 풀릴 수 있다. */ }
}

export interface UseOsNotificationDeliveryOptions {
  items: NotificationItem[];
  ready: boolean;
  enabled: boolean;
  userId: string;
  organizationId: string;
  platform: Platform;
}

/** OS 권한을 명시적으로 켠 경우에만 예약·기한 알림을 전달한다. 첫 동기화는 과거 알림 폭주를 막기 위해 기준점으로만 사용한다. */
export function useOsNotificationDelivery({ items, ready, enabled, userId, organizationId, platform }: UseOsNotificationDeliveryOptions): void {
  const currentScope = userId && organizationId ? osNotificationStorageKey(userId, organizationId) : '';
  const initializedScope = useRef('');
  const sentIds = useRef<Set<string>>(new Set());
  const delivering = useRef(false);

  useEffect(() => {
    if (!ready || !currentScope) return;
    if (!enabled || !platform.sendOsNotification) {
      initializedScope.current = '';
      return;
    }

    if (initializedScope.current !== currentScope) {
      const saved = readSentIds(currentScope);
      // 이미 존재하던 알림은 설정을 켠 순간이나 앱 시작 시 배너로 쏟아내지 않는다.
      for (const item of pendingOsNotifications(items, saved, new Date())) saved.add(item.id);
      sentIds.current = saved;
      initializedScope.current = currentScope;
      saveSentIds(currentScope, saved);
      return;
    }

    const pending = pendingOsNotifications(items, sentIds.current, new Date());
    if (!pending.length || delivering.current) return;
    delivering.current = true;
    void (async () => {
      try {
        for (const item of pending) {
          const message = notificationMessage(item);
          try {
            await platform.sendOsNotification?.(message.title, message.body);
            sentIds.current.add(item.id);
            saveSentIds(currentScope, sentIds.current);
          } catch (error) {
            platform.log?.('WARN', `OS 알림을 표시하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } finally { delivering.current = false; }
    })();
  }, [currentScope, enabled, items, platform, ready]);
}

