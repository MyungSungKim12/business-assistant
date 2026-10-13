import type { Appointment, Customer, Task } from '../../api/schemas';
import { cents, centsToText, formatWon } from '../sales/format';
import type { Transaction } from '../sales/types';

/** 대시보드 계산 함수 모음. 모두 순수 함수이며 시각은 항상 인자로 받는다(시간대·현재 시각에 의존하지 않는다). */

const KST_OFFSET_MS = 9 * 3_600_000;
const DAY_MS = 86_400_000;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** 재고 부족 기본 기준. 상품에 안전재고(low_stock_threshold)가 없으면(null·구버전 서버) 이 값을 쓴다. */
export const LOW_STOCK_THRESHOLD = 5;
export const VISIT_WINDOW_DAYS = 7;
export const WALLET_WINDOW_DAYS = 30;
export const CHART_DAYS = 14;

/** KST 기준 YYYY-MM-DD. 해석할 수 없는 값이면 null. */
export function kstDateKey(value: Date | string | number): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** KST 기준 HH:mm. */
export function kstTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--:--';
  return new Date(date.getTime() + KST_OFFSET_MS).toISOString().slice(11, 16);
}

export function addDaysKey(key: string, days: number): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function monthStartKey(key: string): string {
  return `${key.slice(0, 7)}-01`;
}

/** "2026년 10월 13일 (화)" */
export function formatKstHeading(now: Date): string {
  const key = kstDateKey(now);
  if (!key) return '';
  const weekday = WEEKDAYS[new Date(`${key}T00:00:00Z`).getUTCDay()];
  return `${key.slice(0, 4)}년 ${Number(key.slice(5, 7))}월 ${Number(key.slice(8, 10))}일 (${weekday})`;
}

export function groupDigits(value: number): string {
  return Math.trunc(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "M/D" 라벨. */
export function shortDate(key: string): string {
  return `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`;
}

/* ---------- 예약 ---------- */

export const appointmentStatusLabel: Record<string, string> = {
  reserved: '예약', confirmed: '확정', checked_in: '방문', completed: '완료', canceled: '취소', no_show: '노쇼',
};

export function appointmentsOnDay(items: Appointment[], dayKey: string): Appointment[] {
  return items
    .filter((item) => kstDateKey(item.start_at) === dayKey)
    .sort((a, b) => a.start_at.localeCompare(b.start_at));
}

export interface AppointmentSummary { total: number; open: number; done: number; canceled: number }

/** 취소·노쇼는 total에서 제외한다. 완료는 done, 그 밖의 진행 대상은 open. */
export function summarizeAppointments(items: Appointment[]): AppointmentSummary {
  let open = 0;
  let done = 0;
  let canceled = 0;
  for (const item of items) {
    if (item.status === 'completed') done += 1;
    else if (item.status === 'canceled' || item.status === 'no_show') canceled += 1;
    else open += 1;
  }
  return { total: open + done, open, done, canceled };
}

/* ---------- 할 일 ---------- */

const priorityRank: Record<string, number> = { high: 0, normal: 1, low: 2 };

export interface TaskBuckets {
  overdue: Task[];
  today: Task[];
  week: Task[];
  later: number;
  active: number;
}

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => (a.due_at ?? '').localeCompare(b.due_at ?? '') || (priorityRank[a.priority] ?? 1) - (priorityRank[b.priority] ?? 1));
}

/** 미완료(open·in_progress) 할 일을 KST 날짜 기준으로 기한 지남/오늘/7일 이내/그 이후·기한 없음으로 나눈다. */
export function bucketTasks(tasks: Task[], todayKey: string): TaskBuckets {
  const weekEnd = addDaysKey(todayKey, 7);
  const overdue: Task[] = [];
  const today: Task[] = [];
  const week: Task[] = [];
  let later = 0;
  let active = 0;
  for (const task of tasks) {
    if (task.status !== 'open' && task.status !== 'in_progress') continue;
    active += 1;
    const due = task.due_at ? kstDateKey(task.due_at) : null;
    if (!due) later += 1;
    else if (due < todayKey) overdue.push(task);
    else if (due === todayKey) today.push(task);
    else if (due <= weekEnd) week.push(task);
    else later += 1;
  }
  return { overdue: sortTasks(overdue), today: sortTasks(today), week: sortTasks(week), later, active };
}

/* ---------- 고객 ---------- */

export function activeCustomers(customers: Customer[]): Customer[] {
  return customers.filter((customer) => customer.status !== 'archived');
}

/** 오늘부터 days일 이내(포함)의 다음 방문 예정 고객. 날짜순. */
export function upcomingVisits(customers: Customer[], todayKey: string, days = VISIT_WINDOW_DAYS): Customer[] {
  const end = addDaysKey(todayKey, days);
  return activeCustomers(customers)
    .filter((customer) => {
      const date = customer.next_visit_date?.slice(0, 10);
      return Boolean(date) && date! >= todayKey && date! <= end;
    })
    .sort((a, b) => a.next_visit_date!.slice(0, 10).localeCompare(b.next_visit_date!.slice(0, 10)) || a.name.localeCompare(b.name, 'ko'));
}

/** 고객 API는 등록일을 주지 않으므로 마지막 방문일이 최근인 고객을 보여 준다. */
export function recentVisitors(customers: Customer[], limit = 5): Customer[] {
  return activeCustomers(customers)
    .filter((customer) => Boolean(customer.last_visit_date))
    .sort((a, b) => b.last_visit_date!.slice(0, 10).localeCompare(a.last_visit_date!.slice(0, 10)) || a.name.localeCompare(b.name, 'ko'))
    .slice(0, limit);
}

/* ---------- 수입·지출 ---------- */

export interface MoneyTotals { income: bigint; expense: bigint; net: bigint }

/** from~to(양끝 포함, YYYY-MM-DD 문자열 비교) 거래의 합계. 금액은 "전" 단위 BigInt. 보관된 거래는 제외한다. */
export function sumTransactions(transactions: Transaction[], from: string, to: string): MoneyTotals {
  let income = 0n;
  let expense = 0n;
  for (const transaction of transactions) {
    if (transaction.is_archived) continue;
    const date = transaction.transaction_date.slice(0, 10);
    if (date < from || date > to) continue;
    const amount = cents(transaction.amount);
    if (amount === null) continue;
    if (transaction.transaction_type === 'income') income += amount;
    else expense += amount;
  }
  return { income, expense, net: income - expense };
}

export function monthTotals(transactions: Transaction[], todayKey: string): MoneyTotals {
  return sumTransactions(transactions, monthStartKey(todayKey), todayKey);
}

export function wonOf(total: bigint): string {
  return formatWon(centsToText(total));
}

export interface DayBar { date: string; income: number; expense: number }

/** 오늘로 끝나는 최근 days일의 일별 수입·지출(원 단위 숫자). 거래가 없는 날도 0으로 채운다. */
export function dailySeries(transactions: Transaction[], todayKey: string, days = CHART_DAYS): DayBar[] {
  const bars: DayBar[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = addDaysKey(todayKey, -offset);
    const totals = sumTransactions(transactions, date, date);
    bars.push({ date, income: Number(totals.income / 100n), expense: Number(totals.expense / 100n) });
  }
  return bars;
}

/** 축 최댓값: 1·2·5·10 × 10^n 중 값을 덮는 가장 작은 수. 값이 없으면 기본 100,000. */
export function niceMax(value: number): number {
  if (!(value > 0)) return 100_000;
  const base = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) {
    if (value <= step * base) return step * base;
  }
  return 10 * base;
}

/** 축 라벨용 축약 금액: 0, 5만, 1,000만 */
export function compactWon(value: number): string {
  if (value === 0) return '0';
  if (value >= 100_000_000) return `${groupDigits(value / 100_000_000)}억`;
  if (value >= 10_000) return `${groupDigits(value / 10_000)}만`;
  return groupDigits(value);
}

/* ---------- 미수금·재고·회원권 ---------- */

/** 조직 전체 미수 요약(서버 합계)을 카드용 값으로 바꾼다. 해석할 수 없는 금액은 0으로 본다. */
export function receivableSummary(summary: { total_due: string; receivable_count: number }): { total: bigint; count: number } {
  return { total: cents(summary.total_due) ?? 0n, count: summary.receivable_count };
}

export function receivableTotal(rows: Array<{ due_amount: string }>): { total: bigint; count: number } {
  let total = 0n;
  let count = 0;
  for (const row of rows) {
    const due = cents(row.due_amount);
    if (due !== null && due > 0n) {
      total += due;
      count += 1;
    }
  }
  return { total, count };
}

export interface StockItem {
  id: string; name: string; kind: string; is_active: boolean; stock_quantity: number; unit_name?: string;
  /** 상품별 안전재고. 없으면(null·미지정) 기본 기준을 쓴다. */
  low_stock_threshold?: number | null;
}

/** 상품의 재고 부족 기준: 상품별 값이 있으면 그 값, 없으면 fallback(기본 5). */
export function stockThreshold(product: Pick<StockItem, 'low_stock_threshold'>, fallback = LOW_STOCK_THRESHOLD): number {
  return product.low_stock_threshold ?? fallback;
}

/** 활성 상품 중 재고가 상품별 기준(없으면 fallback) 이하인 것을 적은 순으로. */
export function lowStock(products: StockItem[], fallback = LOW_STOCK_THRESHOLD): StockItem[] {
  return products
    .filter((product) => product.is_active && product.kind === 'product' && product.stock_quantity <= stockThreshold(product, fallback))
    .sort((a, b) => a.stock_quantity - b.stock_quantity || a.name.localeCompare(b.name, 'ko'));
}

export interface WalletRow {
  id: string;
  customer_id?: string;
  name_snapshot?: string;
  expires_on?: string | null;
  lifecycle_status?: string;
  money_balance?: string | number;
  count_balance?: string | number;
}

export interface ExpiringWallet extends WalletRow { daysLeft: number; expires_on: string }

/** 오늘부터 days일 이내에 만료되는 지갑(잔액이 남은 것만). 만료 임박 순. */
export function expiringWallets(wallets: WalletRow[], todayKey: string, days = WALLET_WINDOW_DAYS): ExpiringWallet[] {
  const end = addDaysKey(todayKey, days);
  const todayTime = Date.parse(`${todayKey}T00:00:00Z`);
  const result: ExpiringWallet[] = [];
  for (const wallet of wallets) {
    const expires = wallet.expires_on?.slice(0, 10);
    if (!expires || expires < todayKey || expires > end) continue;
    const hasBalance = Number(wallet.money_balance ?? 0) > 0 || Number(wallet.count_balance ?? 0) > 0;
    if (!hasBalance) continue;
    result.push({ ...wallet, expires_on: expires, daysLeft: Math.round((Date.parse(`${expires}T00:00:00Z`) - todayTime) / DAY_MS) });
  }
  return result.sort((a, b) => a.daysLeft - b.daysLeft);
}
