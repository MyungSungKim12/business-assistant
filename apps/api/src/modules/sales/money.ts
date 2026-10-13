/**
 * 금액은 JS 부동소수 오차를 피하기 위해 "전" 단위 BigInt로만 계산한다.
 * numeric(14,2) 컬럼은 PostgREST가 JSON 숫자로 돌려주므로, 숫자는 소수 2자리 문자열을 거쳐 정수 단위로 바꾼다.
 */
export class MoneyError extends Error {}

export type MoneyInput = string | number;

export function toCents(value: MoneyInput): bigint {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) >= 1e15) throw new MoneyError('Invalid amount');
    text = value.toFixed(2);
  } else {
    text = value.trim();
  }
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new MoneyError('Invalid amount');
  const [, sign, whole, fraction = ''] = match;
  if (/[1-9]/.test(fraction.slice(2))) throw new MoneyError('Too many decimal places');
  const cents = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, '0'));
  return sign ? -cents : cents;
}

export function formatFixed(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  return `${negative ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/** 소수 2자리 고정 문자열(장바구니 금액). */
export function fixedMoney(value: MoneyInput): string { return formatFixed(toCents(value)); }

/** 원 단위 금액: 정수면 소수점 없이, 아니면 소수 2자리. */
export function wonMoney(value: MoneyInput): string {
  const cents = toCents(value);
  return cents % 100n === 0n ? String(cents / 100n) : formatFixed(cents);
}

export function isWholeWon(value: MoneyInput): boolean { return toCents(value) % 100n === 0n; }
