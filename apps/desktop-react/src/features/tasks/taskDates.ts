/** 날짜 키는 로컬(KST 등 실행 환경) 시간대 기준 'YYYY-MM-DD' 문자열이다. 달력 계산은 UTC 연산으로 시간대 영향을 받지 않는다. */
export type DateKey = string;

const pad = (value: number) => String(value).padStart(2, '0');

export function toDateKey(date: Date): DateKey {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseKey(key: DateKey): { year: number; month: number; day: number } {
  const [year, month, day] = key.split('-').map(Number);
  return { year, month, day };
}

function utcKey(date: Date): DateKey {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function addDays(key: DateKey, amount: number): DateKey {
  const { year, month, day } = parseKey(key);
  return utcKey(new Date(Date.UTC(year, month - 1, day + amount)));
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 월 이동. 도착 월에 없는 일자는 말일로 맞춘다(1/31 + 1개월 = 2/28 또는 2/29). */
export function addMonths(key: DateKey, amount: number): DateKey {
  const { year, month, day } = parseKey(key);
  const target = new Date(Date.UTC(year, month - 1 + amount, 1));
  const targetYear = target.getUTCFullYear();
  const targetMonth = target.getUTCMonth() + 1;
  return `${targetYear}-${pad(targetMonth)}-${pad(Math.min(day, daysInMonth(targetYear, targetMonth)))}`;
}

/** 0 = 일요일 */
export function weekdayOf(key: DateKey): number {
  const { year, month, day } = parseKey(key);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function startOfWeek(key: DateKey): DateKey {
  return addDays(key, -weekdayOf(key));
}

export function startOfMonth(key: DateKey): DateKey {
  const { year, month } = parseKey(key);
  return `${year}-${pad(month)}-01`;
}

export function endOfMonth(key: DateKey): DateKey {
  const { year, month } = parseKey(key);
  return `${year}-${pad(month)}-${pad(daysInMonth(year, month))}`;
}

export interface CalendarCell {
  key: DateKey;
  day: number;
  inMonth: boolean;
}

function cellsFrom(start: DateKey, count: number, monthPrefix: string): CalendarCell[] {
  return Array.from({ length: count }, (_, index) => {
    const key = addDays(start, index);
    return { key, day: parseKey(key).day, inMonth: key.startsWith(monthPrefix) };
  });
}

/** 일요일 시작 6주(42칸) 격자. */
export function buildMonthGrid(anchor: DateKey): CalendarCell[] {
  const first = startOfMonth(anchor);
  return cellsFrom(startOfWeek(first), 42, first.slice(0, 7));
}

/** anchor가 속한 주(일~토) 7칸. inMonth는 anchor의 달 기준. */
export function buildWeek(anchor: DateKey): CalendarCell[] {
  return cellsFrom(startOfWeek(anchor), 7, anchor.slice(0, 7));
}

export function dueDateKey(dueAt: string | null | undefined): DateKey | null {
  if (!dueAt) return null;
  const date = new Date(dueAt);
  return Number.isNaN(date.getTime()) ? null : toDateKey(date);
}

/** ISO → datetime-local 입력값(로컬 시간). */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${toDateKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export const DEFAULT_DUE_TIME = '09:00';

/** 날짜만 바꾸고 기존 시각(로컬)은 유지한다. 기존 기한이 없으면 09:00. */
export function moveDueToDate(dueAt: string | null | undefined, key: DateKey): string {
  const current = isoToLocalInput(dueAt);
  const time = current ? current.slice(11) : DEFAULT_DUE_TIME;
  return new Date(`${key}T${time}`).toISOString();
}

export function dateKeyToLocalInput(key: DateKey): string {
  return `${key}T${DEFAULT_DUE_TIME}`;
}

export type RangePreset = 'today' | 'week' | 'month' | 'all';
export interface DateRangeValue { from: DateKey | null; to: DateKey | null }

export function rangeForPreset(preset: RangePreset, todayKey: DateKey): DateRangeValue {
  if (preset === 'today') return { from: todayKey, to: todayKey };
  if (preset === 'week') {
    const start = startOfWeek(todayKey);
    return { from: start, to: addDays(start, 6) };
  }
  if (preset === 'month') return { from: startOfMonth(todayKey), to: endOfMonth(todayKey) };
  return { from: null, to: null };
}

export function formatDue(iso: string | null | undefined): string {
  const local = isoToLocalInput(iso);
  return local ? local.replace('T', ' ') : '기한 없음';
}

export function formatMonthTitle(anchor: DateKey): string {
  const { year, month } = parseKey(anchor);
  return `${year}년 ${month}월`;
}

export function formatWeekTitle(anchor: DateKey): string {
  const start = startOfWeek(anchor);
  const end = addDays(start, 6);
  const a = parseKey(start);
  const b = parseKey(end);
  return `${a.year}년 ${a.month}월 ${a.day}일 – ${a.month === b.month ? '' : `${b.month}월 `}${b.day}일`;
}

export const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'] as const;
