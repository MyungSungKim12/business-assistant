/**
 * 예약 화면의 한국 표준시(KST, UTC+9) 날짜·시간 계산. 한국은 서머타임이 없어 고정 +9시간으로 계산하며,
 * 실행 환경의 시간대와 무관하게 같은 결과를 낸다(모두 UTC 연산).
 */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const pad = (value: number) => String(value).padStart(2, '0');
const weekdayNames = ['일', '월', '화', '수', '목', '금', '토'];

/** 'YYYY-MM-DD' 날짜 키를 해당 날짜 UTC 자정의 ms로 바꾼다(달력 산술용). */
function keyToUtcMs(dateKey: string): number {
  const [year, month, day] = dateKey.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

function utcMsToKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** 순간(ms 또는 ISO)을 KST 벽시계 기준 [날짜 키, 그날 0시부터의 분]으로 바꾼다. */
export function kstParts(instant: number | string): { date: string; minutes: number } {
  const ms = (typeof instant === 'number' ? instant : new Date(instant).getTime()) + KST_OFFSET_MS;
  const date = new Date(ms);
  return { date: utcMsToKey(ms), minutes: date.getUTCHours() * 60 + date.getUTCMinutes() };
}

export const kstDateKey = (instant: number | string) => kstParts(instant).date;

/** 지금(또는 주어진 순간)의 KST 날짜 키. */
export const todayKstKey = (now: number = Date.now()) => kstDateKey(now);

/** 해당 KST 날짜의 0시 순간(ms). */
export const kstDayStartMs = (dateKey: string) => keyToUtcMs(dateKey) - KST_OFFSET_MS;

/** 날짜 키에 일수를 더한다(음수 가능). 월·연 경계를 넘는다. */
export function addDays(dateKey: string, days: number): string {
  return utcMsToKey(keyToUtcMs(dateKey) + days * DAY_MS);
}

/** 0=일 … 6=토. */
export const weekdayOf = (dateKey: string) => new Date(keyToUtcMs(dateKey)).getUTCDay();

/** 그 주의 월요일 날짜 키(주는 월요일에 시작). */
export function weekStartOf(dateKey: string): string {
  const offset = (weekdayOf(dateKey) + 6) % 7;
  return addDays(dateKey, -offset);
}

/** 월~일 7개 날짜 키. */
export function weekDaysOf(dateKey: string): string[] {
  const start = weekStartOf(dateKey);
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

export const isDateKey = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && utcMsToKey(keyToUtcMs(value)) === value;

/** 분(0~1440)을 'HH:mm'으로. */
export const formatMinutes = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

/** 순간을 KST 'HH:mm'으로. */
export const formatKstTime = (instant: number | string) => formatMinutes(kstParts(instant).minutes);

/** 'M월 D일 (요일)'. */
export function formatDateLabel(dateKey: string): string {
  const [, month, day] = dateKey.split('-').map(Number);
  return `${month}월 ${day}일 (${weekdayNames[weekdayOf(dateKey)]})`;
}

export const weekdayLabel = (dateKey: string) => weekdayNames[weekdayOf(dateKey)];

/** 주 범위 표시: 'M월 D일 ~ M월 D일'. */
export function formatWeekLabel(dateKey: string): string {
  const days = weekDaysOf(dateKey);
  const [, startMonth, startDay] = days[0].split('-').map(Number);
  const [, endMonth, endDay] = days[6].split('-').map(Number);
  return `${startMonth}월 ${startDay}일 ~ ${endMonth}월 ${endDay}일`;
}

/** datetime-local 값('YYYY-MM-DDTHH:mm')을 KST 오프셋이 붙은 ISO 문자열로. */
export function kstIso(local: string): string {
  return `${local.length === 16 ? `${local}:00` : local}+09:00`;
}

/** 순간을 datetime-local 값(KST 벽시계)으로. */
export function toKstLocalInput(instant: number | string): string {
  const parts = kstParts(instant);
  return `${parts.date}T${formatMinutes(parts.minutes)}`;
}

/** 날짜 키와 분을 datetime-local 값으로. */
export const localInputAt = (dateKey: string, minutes: number) => `${dateKey}T${formatMinutes(minutes)}`;

export interface DayInterval {
  startMin: number;
  endMin: number;
  bufferEndMin: number;
  clippedStart: boolean;
  clippedEnd: boolean;
}

/**
 * 예약이 특정 KST 날짜와 겹치는 구간을 그날 0시 기준 분으로 돌려준다. 겹치지 않으면 null.
 * 자정을 넘는 예약은 그날 범위(0~1440)로 잘라 돌려주고, 잘렸는지도 알린다.
 * 여유 시간은 종료 뒤에 붙는 것으로 보되, 다음 날로 넘어가면 그날 끝(24:00)에서 자른다.
 */
export function intervalOnDay(startIso: string, endIso: string, bufferMinutes: number, dateKey: string): DayInterval | null {
  const dayStart = kstDayStartMs(dateKey);
  const dayEnd = dayStart + DAY_MS;
  const startMs = new Date(startIso).getTime();
  const endMs = Math.max(new Date(endIso).getTime(), startMs);
  const bufferEndMs = endMs + Math.max(0, bufferMinutes) * MINUTE_MS;
  if (startMs >= dayEnd) return null;
  if (Math.max(endMs, startMs + 1) <= dayStart) return null;
  return {
    startMin: Math.max(0, Math.round((startMs - dayStart) / MINUTE_MS)),
    endMin: Math.min(1440, Math.round((endMs - dayStart) / MINUTE_MS)),
    bufferEndMin: Math.min(1440, Math.round((bufferEndMs - dayStart) / MINUTE_MS)),
    clippedStart: startMs < dayStart,
    clippedEnd: endMs > dayEnd,
  };
}
