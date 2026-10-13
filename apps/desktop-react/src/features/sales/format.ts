import { ApiError } from '../../api/errors';

/** 금액 문자열을 "전" 단위 BigInt로 바꾼다. 잘못된 값이면 null. */
export function cents(value: unknown): bigint | null {
  const text = typeof value === 'number' ? value.toFixed(2) : typeof value === 'string' ? value.trim() : '';
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const fraction = (match[3] ?? '').padEnd(2, '0');
  if (/[1-9]/.test(fraction.slice(2))) return null;
  const total = BigInt(match[2]) * 100n + BigInt(fraction.slice(0, 2));
  return match[1] ? -total : total;
}

function group(whole: bigint): string { return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

/** 12000 → "12,000원", 12000.5 → "12,000.50원". 해석할 수 없으면 "금액 확인 필요". */
export function formatWon(value: unknown): string {
  const total = cents(value);
  if (total === null) return '금액 확인 필요';
  const negative = total < 0n;
  const abs = negative ? -total : total;
  const fraction = abs % 100n === 0n ? '' : `.${String(abs % 100n).padStart(2, '0')}`;
  return `${negative ? '-' : ''}${group(abs / 100n)}${fraction}원`;
}

/** 합계를 "정수.소수2" 또는 정수 문자열로 돌려준다(서버 전송용). */
export function centsToText(total: bigint): string {
  const negative = total < 0n;
  const abs = negative ? -total : total;
  return `${negative ? '-' : ''}${abs / 100n}${abs % 100n === 0n ? '' : `.${String(abs % 100n).padStart(2, '0')}`}`;
}

export const wonInteger = /^[1-9][0-9]{0,11}$/;
export const wholeAmount = /^(0|[1-9][0-9]{0,11})$/;
export const moneyText = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/;

export function newOperationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
}

export function kst(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const shifted = new Date(date.getTime() + 9 * 3600_000);
  return shifted.toISOString().slice(0, 16).replace('T', ' ');
}

export function today(): string {
  const shifted = new Date(Date.now() + 9 * 3600_000);
  return shifted.toISOString().slice(0, 10);
}

/** 서버가 확정적으로 거절한 상태(요청이 처리되지 않았음이 확실한 경우). */
export const definitive = new Set([400, 401, 403, 404, 409, 422]);

export function isDefinitive(error: unknown): boolean { return error instanceof ApiError && definitive.has(error.status); }

export const MONTH_CLOSED_CODE = 'FINANCE_MONTH_CLOSED';

/** 월 마감된 달의 장부에 걸린 거절이면 서버가 준 한국어 안내를, 아니면 null. */
export function monthClosedMessage(error: unknown): string | null {
  return error instanceof ApiError && error.status === 409 && error.code === MONTH_CLOSED_CODE ? error.message : null;
}

export function errorMessage(error: unknown, subject = '요청'): string {
  const closed = monthClosedMessage(error);
  if (closed) return closed;
  if (error instanceof ApiError) {
    switch (error.status) {
      case 409: return '다른 변경과 충돌했습니다. 입력은 유지했습니다. 자료를 새로고침한 뒤 다시 확인하세요.';
      case 422: case 400: return '입력값을 확인하세요. 작성 내용은 유지했습니다.';
      case 401: return '로그인이 만료되었습니다. 작성 내용을 확인한 뒤 다시 로그인하세요.';
      case 403: return '이 작업에 필요한 권한이 없습니다. 작성 내용은 유지했습니다.';
      case 404: return '대상을 찾을 수 없습니다. 자료를 새로고침해 주세요.';
      default: break;
    }
  }
  return `${subject}을 완료하지 못했습니다. 화면의 기존 내용은 유지됩니다. 같은 요청을 다시 시도하세요.`;
}

export const visitStatusLabel: Record<string, string> = { open: '진행 중', checkout_ready: '결제 대기', closed: '수납 완료', canceled: '취소' };
export const methodLabel: Record<string, string> = { cash: '현금', card: '카드', transfer: '이체', wallet: '회원권' };
