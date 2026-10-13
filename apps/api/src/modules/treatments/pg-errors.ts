import { ApiFailure } from '../../errors.js';

/** PostgreSQL/PostgREST 오류 코드 묶음. Python 어댑터의 매핑을 그대로 옮겼다. */
export type PgErrorCodes = { conflict: string[]; notFound: string[]; denied: string[]; invalid: string[] };

export const treatmentErrorCodes: PgErrorCodes = {
  conflict: ['P0001'], notFound: ['P0002'], denied: ['42501'], invalid: ['22023', '22007', '22008', '22P02', '23514', '22003'],
};
export const saleDraftErrorCodes: PgErrorCodes = {
  conflict: ['P0001'], notFound: ['P0002'], denied: ['42501'], invalid: ['22023', '23514', '22P02'],
};

/**
 * createRest는 HTTP 상태로만 오류를 구분하므로, RPC가 raise exception으로 돌려준 SQLSTATE(code)를
 * 상태(409/404/403/422)로 바꿔 전달한다. 모르는 코드는 502(최종 503)로 취급하고 원문 본문은 버린다.
 */
export function withPgErrorCodes(fetcher: typeof fetch, codes: PgErrorCodes): typeof fetch {
  return async (input, init) => {
    const response = await fetcher(input, init);
    if (response.ok || response.status === 401) return response;
    let code = '';
    try {
      const body: unknown = JSON.parse(await response.text());
      if (typeof body === 'object' && body && 'code' in body && typeof body.code === 'string') code = body.code;
    } catch { /* 본문이 JSON이 아니면 알 수 없는 오류 */ }
    const status = codes.conflict.includes(code) ? 409 : codes.notFound.includes(code) ? 404 : codes.denied.includes(code) ? 403 : codes.invalid.includes(code) ? 422 : 502;
    return new Response('{}', { status, headers: { 'content-type': 'application/json' } });
  };
}

/** createRest의 일반 문구를 모듈별 문구(Python과 같은 detail)로 바꾼다. 401과 알 수 없는 상태는 그대로 둔다. */
export async function withMessages<T>(work: () => Promise<T>, messages: Partial<Record<number, string>>): Promise<T> {
  try { return await work(); } catch (error) {
    const detail = error instanceof ApiFailure ? messages[error.status] : undefined;
    if (error instanceof ApiFailure && detail) throw new ApiFailure(error.status, detail);
    throw error;
  }
}
