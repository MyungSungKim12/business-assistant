import { ApiFailure } from '../../errors.js';

/**
 * 월 마감(042) 트리거·RPC가 raise exception 하는 메시지를 한국어 안내와 오류 코드로 바꾼다.
 * 원문 메시지는 응답에 싣지 않는다. 같은 P0001이라도 다른 충돌과 구분하기 위해 메시지 원문으로만 판별한다.
 */
export const MONTH_CLOSED_CODE = 'FINANCE_MONTH_CLOSED';
export const MONTH_CLOSED_DETAIL = '마감된 달의 거래는 등록·수정(보관 포함)할 수 없습니다. 관리자가 월 마감을 재오픈한 뒤 다시 시도하세요.';
export const MONTH_ALREADY_CLOSED_DETAIL = '이미 마감된 달입니다. 화면을 새로고침해 마감 상태를 확인하세요.';
export const MONTH_NOT_CLOSED_DETAIL = '마감 상태가 아닌 달입니다. 화면을 새로고침해 마감 상태를 확인하세요.';

type Rule = { pattern: RegExp; failure: () => ApiFailure };
const rules: Rule[] = [
  { pattern: /finance month is closed/i, failure: () => new ApiFailure(409, MONTH_CLOSED_DETAIL, { code: MONTH_CLOSED_CODE }) },
  { pattern: /finance month already closed/i, failure: () => new ApiFailure(409, MONTH_ALREADY_CLOSED_DETAIL, { code: 'FINANCE_MONTH_ALREADY_CLOSED' }) },
  { pattern: /finance month is not closed/i, failure: () => new ApiFailure(404, MONTH_NOT_CLOSED_DETAIL, { code: 'FINANCE_MONTH_NOT_CLOSED' }) },
];

export function monthClosedFailure(body: string): ApiFailure | undefined {
  let message = '';
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed && 'message' in parsed) message = String((parsed as { message: unknown }).message);
  } catch { return undefined; }
  return rules.find((rule) => rule.pattern.test(message))?.failure();
}

/** 응답 본문을 한 번 살펴 월 마감 오류면 ApiFailure를 던지는 fetch 래퍼. 그 밖의 응답은 그대로 돌려준다. */
export function withMonthClosedErrors(fetcher: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await fetcher(input, init);
    if (response.status < 400 || response.status >= 500) return response;
    const failure = monthClosedFailure(await response.clone().text());
    if (failure) throw failure;
    return response;
  }) as typeof fetch;
}
