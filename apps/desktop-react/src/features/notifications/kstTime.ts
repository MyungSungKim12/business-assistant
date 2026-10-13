/** 한국 표준시(KST, UTC+9) 기준 날짜·시각 계산. 알림·검색에서 now 를 주입해 쓴다. */
const KST_OFFSET_MS = 9 * 3_600_000;
const DAY_MS = 86_400_000;

function asDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/** 값(ISO 문자열 또는 Date)의 KST 날짜 YYYY-MM-DD. 해석할 수 없으면 빈 문자열. */
export function kstDateKey(value: string | Date): string {
  const date = asDate(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 값의 KST 시각 HH:mm. */
export function kstTimeLabel(value: string | Date): string {
  const date = asDate(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() + KST_OFFSET_MS).toISOString().slice(11, 16);
}

/** YYYY-MM-DD 에 일수를 더한다. */
export function addDays(key: string, days: number): string {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS).toISOString().slice(0, 10);
}

/** to - from 일수. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** YYYY-MM-DD 의 MM-DD. */
export const monthDay = (key: string): string => key.slice(5, 10);

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}
