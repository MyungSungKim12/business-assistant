import type { ServerConfig } from '../../config.js';
import { ApiFailure } from '../../errors.js';

/** 도메인별 오류 문구. 원문 오류는 응답에 싣지 않는다. */
export type ErrorMessages = { conflict?: string; notFound?: string; forbidden?: string; invalid: string; unavailable: string };
export type RequestOptions = {
  query?: Record<string, string>;
  body?: unknown;
  /** 쓰기 요청이 변경된 행을 돌려받도록 한다(PostgREST Prefer). */
  representation?: boolean;
  /** PostgreSQL 오류 코드(P0001 등)를 도메인 상태로 매핑한다(RPC·동의·발급). */
  mapCodes?: boolean;
  /** 코드 없는 400을 422로 취급한다(테이블 쓰기·RPC 입력 거부). */
  badRequestIsInvalid?: boolean;
  /** Prefer 헤더를 직접 지정한다(예: 중복 무시 삽입). representation 보다 우선한다. */
  prefer?: string;
};

const codeStatus: Record<string, 'conflict' | 'notFound' | 'forbidden' | 'invalid'> = {
  P0001: 'conflict', P0002: 'notFound', '42501': 'forbidden', '22023': 'invalid', '23514': 'invalid', '22P02': 'invalid',
};
const fallback = { conflict: 409, notFound: 404, forbidden: 403, invalid: 422 } as const;

function preferHeader(options: RequestOptions): Record<string, string> {
  if (options.prefer) return { Prefer: options.prefer };
  return options.representation ? { Prefer: 'return=representation' } : {};
}

export function createDocumentHttp(config: ServerConfig, fetcher: typeof fetch = fetch) {
  const base = config.APP_SUPABASE_URL.replace(/\/+$/, '');
  const headers = (token: string, extra: Record<string, string> = {}) => ({
    apikey: config.APP_SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra,
  });

  function failure(status: number, body: unknown, messages: ErrorMessages, options: RequestOptions): ApiFailure {
    if (status === 401) return new ApiFailure(401, 'Not authenticated');
    const code = typeof body === 'object' && body && 'code' in body ? (body as { code: unknown }).code : undefined;
    if (options.mapCodes && typeof code === 'string' && code in codeStatus) {
      const kind = codeStatus[code];
      return new ApiFailure(fallback[kind], messages[kind] ?? messages.invalid);
    }
    if (status === 400 && options.badRequestIsInvalid) return new ApiFailure(422, messages.invalid);
    return new ApiFailure(503, messages.unavailable);
  }

  /** 사용자 토큰으로 PostgREST/RPC/Auth를 호출하고 JSON 본문을 돌려준다. */
  async function request(token: string, method: string, path: string, messages: ErrorMessages, options: RequestOptions = {}): Promise<unknown> {
    const url = new URL(path, base + '/');
    url.search = new URLSearchParams(options.query ?? {}).toString();
    try {
      const response = await fetcher(url, {
        method, headers: headers(token, preferHeader(options)),
        body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: AbortSignal.timeout(10_000), redirect: 'error',
      });
      const text = await response.text();
      let data: unknown = null;
      try { data = text ? JSON.parse(text) : null; } catch { if (response.ok) throw new ApiFailure(503, messages.unavailable); }
      if (!response.ok) throw failure(response.status, data, messages, options);
      return data;
    } catch (error) {
      if (error instanceof ApiFailure) throw error;
      throw new ApiFailure(503, messages.unavailable);
    }
  }

  async function userId(token: string, messages: ErrorMessages): Promise<string> {
    const data = await request(token, 'GET', '/auth/v1/user', messages);
    const id = typeof data === 'object' && data && 'id' in data ? (data as { id: unknown }).id : undefined;
    if (typeof id !== 'string') throw new ApiFailure(503, messages.unavailable);
    return id;
  }

  /** 서명 URL 응답에서 URL을 꺼내 절대 주소로 만든다(Python SupabaseStorageAdapter와 동일). */
  async function signedUrl(token: string, path: string, body: unknown, messages: ErrorMessages): Promise<string> {
    const data = await request(token, 'POST', `/storage/v1/${path}`, messages, { body });
    const record = typeof data === 'object' && data ? (data as Record<string, unknown>) : {};
    const signed = [record.signedURL, record.signedUrl, record.url].find((value) => typeof value === 'string' && value !== '');
    if (typeof signed !== 'string') throw new ApiFailure(503, messages.unavailable);
    return /^https?:/i.test(signed) ? signed : `${base}/storage/v1${signed}`;
  }

  return { request, userId, signedUrl };
}
export type DocumentHttp = ReturnType<typeof createDocumentHttp>;
