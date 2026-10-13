import type { ServerConfig } from '../../config.js';
import { ApiFailure } from '../../errors.js';

/**
 * 매출 모듈 전용 PostgREST/RPC 호출기.
 * Python 어댑터와 같이 PostgreSQL 오류 코드(P0001 충돌, P0002 없음, 42501 권한, 22023/23514/22P02 검증)로 상태를 정한다.
 * 원문 메시지와 개인정보는 응답에 싣지 않는다.
 */
export type Query = Record<string, string>;
export type SalesHttp = ReturnType<typeof createSalesHttp>;

export const SALES_UNAVAILABLE = 'Sale cart service unavailable';

const codeStatus: Record<string, [number, string]> = {
  P0001: [409, 'Sale cart conflict; reload before retrying'],
  '23505': [409, 'Sale cart conflict; reload before retrying'],
  P0002: [404, 'Visit, cart, line, customer or draft not found'],
  '42501': [403, 'Sale cart access permission required'],
  '22023': [422, 'Invalid sale cart request'],
  '23514': [422, 'Invalid sale cart request'],
  '22P02': [422, 'Invalid sale cart request'],
};

export function createSalesHttp(config: ServerConfig, fetcher: typeof fetch = fetch, unavailable = SALES_UNAVAILABLE) {
  async function send(token: string, method: 'GET' | 'POST', path: string, query: Query, body?: unknown): Promise<unknown> {
    const url = new URL(path, config.APP_SUPABASE_URL);
    url.search = new URLSearchParams(query).toString();
    try {
      const response = await fetcher(url, {
        method,
        headers: { apikey: config.APP_SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      const text = await response.text();
      let data: unknown = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      if (!response.ok) {
        const code = typeof data === 'object' && data && 'code' in data ? (data as { code: unknown }).code : undefined;
        const mapped = typeof code === 'string' ? codeStatus[code] : undefined;
        if (mapped) throw new ApiFailure(mapped[0], mapped[1]);
        if (response.status === 401) throw new ApiFailure(401, 'Not authenticated');
        if (response.status === 403) throw new ApiFailure(403, 'Access denied');
        throw new ApiFailure(503, unavailable);
      }
      if (data === null && text) throw new ApiFailure(503, unavailable);
      return data;
    } catch (error) {
      if (error instanceof ApiFailure) throw error;
      throw new ApiFailure(503, unavailable);
    }
  }
  return {
    unavailable,
    get: (token: string, table: string, query: Query) => send(token, 'GET', `/rest/v1/${table}`, query),
    rpc: (token: string, name: string, args: Record<string, unknown>) => send(token, 'POST', `/rest/v1/rpc/${name}`, {}, args),
  };
}
