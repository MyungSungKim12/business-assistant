import { z } from 'zod';
import type { Appointment, Customer, Task } from '../../api/schemas';
import type { MenuId } from '../shell/TopBar';
import { addDays, daysBetween, isLeapYear, kstDateKey, kstTimeLabel, monthDay } from './kstTime';

export type NotificationKind = 'appointment' | 'task' | 'birthday' | 'wallet';

export interface NotificationItem {
  /** 읽음 처리에 쓰는 안정된 ID(같은 사건이면 새로 불러와도 같다). */
  id: string;
  kind: NotificationKind;
  title: string;
  detail: string;
  /** 1시간 이내 임박 예약, 기한이 지난 할 일처럼 눈에 띄게 보여 줄 항목 */
  urgent: boolean;
  /** 클릭하면 이동할 메뉴 */
  menu: MenuId;
  /** 정렬 기준(작을수록 먼저). */
  sortKey: string;
  /** OS 알림 전달 시각. OS 알림 대상이 아니면 null 또는 생략한다. */
  osNotifyAt?: string | null;
}

export interface WalletRow {
  id: string;
  customer_id?: string;
  name_snapshot?: string;
  expires_on?: string | null;
  expires_at?: string | null;
  lifecycle_status?: string;
  money_balance?: string | number;
  count_balance?: string | number;
}

export interface NotificationSource {
  appointments: Appointment[];
  tasks: Task[];
  customers: Customer[];
  wallets: WalletRow[];
}

export const IMMINENT_MINUTES = 60;
export const WALLET_WINDOW_DAYS = 30;
export const BIRTHDAY_WINDOW_DAYS = 7;
const UPCOMING_STATUSES = new Set(['reserved', 'confirmed']);
const OPEN_TASK_STATUSES = new Set(['open', 'in_progress']);

type CustomerMap = Map<string, Customer>;

/** 고객 이름을 찾고, 없으면 '고객'. */
const customerName = (customers: CustomerMap, id: string): string => customers.get(id)?.name || '고객';

/** 오늘·내일 예약(예정·확정). 시작까지 1시간 이내이면 임박(urgent). */
export function appointmentNotifications(appointments: Appointment[], customers: CustomerMap, now: Date): NotificationItem[] {
  const today = kstDateKey(now);
  const tomorrow = addDays(today, 1);
  const items: NotificationItem[] = [];
  for (const appointment of appointments) {
    if (!UPCOMING_STATUSES.has(appointment.status)) continue;
    const start = new Date(appointment.start_at);
    if (Number.isNaN(start.getTime()) || start.getTime() < now.getTime()) continue;
    const day = kstDateKey(start);
    if (day !== today && day !== tomorrow) continue;
    const minutes = Math.ceil((start.getTime() - now.getTime()) / 60_000);
    const urgent = minutes <= IMMINENT_MINUTES;
    items.push({
      id: `appointment:${appointment.id}:${appointment.start_at}`,
      kind: 'appointment',
      title: `${day === today ? '오늘' : '내일'} ${kstTimeLabel(start)} ${customerName(customers, appointment.customer_id)}`,
      detail: urgent ? `${minutes}분 후 · ${appointment.service_name_snapshot}` : appointment.service_name_snapshot,
      urgent,
      menu: 'appointments',
      sortKey: `1-${appointment.start_at}`,
      osNotifyAt: new Date(start.getTime() - IMMINENT_MINUTES * 60_000).toISOString(),
    });
  }
  return items;
}

/** 기한이 지났거나 오늘까지인 미완료 할 일. */
export function taskNotifications(tasks: Task[], now: Date, userId?: string): NotificationItem[] {
  const today = kstDateKey(now);
  const items: NotificationItem[] = [];
  for (const task of tasks) {
    if (userId && (task.assignee_id ?? task.created_by) !== userId) continue;
    if (!OPEN_TASK_STATUSES.has(task.status) || !task.due_at) continue;
    const due = kstDateKey(task.due_at);
    if (!due || due > today) continue;
    const overdue = due < today;
    items.push({
      id: `task:${task.id}:${due}`,
      kind: 'task',
      title: task.title,
      detail: overdue ? `기한 ${daysBetween(due, today)}일 지남 (${due})` : `오늘 마감 ${kstTimeLabel(task.due_at)}`,
      urgent: overdue,
      menu: 'tasks',
      sortKey: `2-${due}`,
      osNotifyAt: task.due_at,
    });
  }
  return items;
}

/** 오늘부터 7일(오늘 포함) 안에 생일인 고객. 2/29 생일은 평년에 2/28 로 본다. */
export function birthdayNotifications(customers: Customer[], now: Date): NotificationItem[] {
  const today = kstDateKey(now);
  const items: NotificationItem[] = [];
  for (const customer of customers) {
    if (customer.status === 'archived' || !customer.birth_date) continue;
    const birth = monthDay(customer.birth_date);
    if (!/^\d{2}-\d{2}$/.test(birth)) continue;
    for (let offset = 0; offset < BIRTHDAY_WINDOW_DAYS; offset += 1) {
      const day = addDays(today, offset);
      const leapFallback = birth === '02-29' && monthDay(day) === '02-28' && !isLeapYear(Number(day.slice(0, 4)));
      if (monthDay(day) !== birth && !leapFallback) continue;
      items.push({
        id: `birthday:${customer.id}:${day.slice(0, 4)}`,
        kind: 'birthday',
        title: `${customer.name} 고객 생일`,
        detail: offset === 0 ? '오늘' : `${Number(day.slice(5, 7))}월 ${Number(day.slice(8, 10))}일 (${offset}일 후)`,
        urgent: offset === 0,
        menu: 'customers',
        sortKey: `3-${day}`,
      });
      break;
    }
  }
  return items;
}

/** 오늘부터 30일 안에 만료되는 회원권(잔액·횟수가 남은 것만). */
export function walletNotifications(wallets: WalletRow[], customers: CustomerMap, now: Date): NotificationItem[] {
  const today = kstDateKey(now);
  const end = addDays(today, WALLET_WINDOW_DAYS);
  const items: NotificationItem[] = [];
  for (const wallet of wallets) {
    const expires = (wallet.expires_on ?? wallet.expires_at)?.slice(0, 10);
    if (!expires || expires < today || expires > end) continue;
    if (Number(wallet.money_balance ?? 0) <= 0 && Number(wallet.count_balance ?? 0) <= 0) continue;
    const left = daysBetween(today, expires);
    const owner = wallet.customer_id ? customerName(customers, wallet.customer_id) : '';
    items.push({
      id: `wallet:${wallet.id}:${expires}`,
      kind: 'wallet',
      title: `${owner ? `${owner} · ` : ''}${wallet.name_snapshot || '회원권'}`,
      detail: left === 0 ? `오늘 만료 (${expires})` : `${left}일 후 만료 (${expires})`,
      urgent: left <= 7,
      menu: 'memberships',
      sortKey: `4-${expires}`,
    });
  }
  return items;
}

export const KIND_LABELS: Record<NotificationKind, string> = { appointment: '예약', task: '할 일', birthday: '생일', wallet: '회원권' };
const KIND_ORDER: Record<NotificationKind, number> = { appointment: 0, task: 1, birthday: 2, wallet: 3 };

/** 모든 알림을 모아 종류·시각 순으로 정렬한다. 순수 함수(now 주입). */
export function buildNotifications(source: NotificationSource, now: Date, userId?: string): NotificationItem[] {
  const customers: CustomerMap = new Map(source.customers.map((customer) => [customer.id, customer]));
  return [
    ...appointmentNotifications(source.appointments, customers, now),
    ...taskNotifications(source.tasks, now, userId),
    ...birthdayNotifications(source.customers, now),
    ...walletNotifications(source.wallets, customers, now),
  ].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.sortKey.localeCompare(b.sortKey) || a.id.localeCompare(b.id));
}

const walletRowSchema = z.object({
  id: z.string(),
  customer_id: z.string().optional(),
  name_snapshot: z.string().optional(),
  expires_on: z.string().nullable().optional(),
  expires_at: z.string().nullable().optional(),
  lifecycle_status: z.string().optional(),
  money_balance: z.union([z.string(), z.number()]).optional(),
  count_balance: z.union([z.string(), z.number()]).optional(),
});

/** 운영 기록(memberships)에서 알림 계산에 필요한 지갑 필드만 읽는다. 형식이 맞지 않는 행은 건너뛴다. */
export function walletRowsFrom(records: Array<Record<string, unknown>>): WalletRow[] {
  return records.flatMap((record) => {
    const parsed = walletRowSchema.safeParse(record);
    return parsed.success ? [parsed.data] : [];
  });
}
