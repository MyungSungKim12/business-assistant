/** 한국 표준시(KST, UTC+9) 기준 날짜 계산. 서버 날짜(YYYY-MM-DD)와 ISO 시각을 같은 기준으로 비교한다. */
const KST_OFFSET_MS = 9 * 3600_000;
const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const isDateOnly = (value: string | null | undefined): value is string => !!value && DATE_ONLY.test(value);

/** ISO 시각(또는 Date)의 KST 날짜(YYYY-MM-DD). 해석할 수 없으면 빈 문자열. */
export function kstDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** ISO 시각의 KST 표기(YYYY-MM-DD HH:mm). 해석할 수 없으면 원문을 돌려준다. */
export function kstDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Date(date.getTime() + KST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

export const kstToday = (now: Date = new Date()): string => kstDate(now);

const dayNumber = (date: string): number => {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / DAY_MS;
};

/** to - from 을 일 단위로 계산한다(두 값 모두 YYYY-MM-DD). */
export const daysBetween = (from: string, to: string): number => Math.round(dayNumber(to) - dayNumber(from));
