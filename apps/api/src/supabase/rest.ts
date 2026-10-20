import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { ApiFailure } from '../errors.js';

/**
 * 사용자 토큰으로 Supabase PostgREST/RPC를 호출하는 공통 도우미.
 * 새 모듈은 이 도우미를 쓰고, 상태 코드 매핑(401/403/404/409/422, 그 외 503)을 한곳에서 맞춘다.
 * RLS가 조직 격리를 보장하지만, 모듈은 반환 행의 organization_id를 `assertOrganization`으로 다시 확인한다.
 */
export type Rest = ReturnType<typeof createRest>;
export type Query = Record<string, string>;

export function createRest(config: ServerConfig, fetcher: typeof fetch = fetch, unavailable = 'Service unavailable') {
  const headers = (token: string, write: boolean, extra: Record<string, string> = {}) => ({
    apikey: config.APP_SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
    ...(write ? { Prefer: 'return=representation' } : {}), ...extra,
  });

  function failure(status: number, body: unknown): ApiFailure {
    if (status === 401) return new ApiFailure(401, 'Not authenticated');
    if (status === 403) return new ApiFailure(403, 'Access denied');
    if (status === 404) return new ApiFailure(404, 'Not found');
    if (status === 409) return new ApiFailure(409, 'Record conflict');
    const message = typeof body === 'object' && body && 'message' in body ? String((body as { message: unknown }).message) : '';
    // 업무 규칙 위반(RPC에서 raise exception)은 422로 돌려준다. 메시지 원문은 노출하지 않는다.
    if (status === 400 || status === 422 || /violates|invalid|P0001/i.test(message)) return new ApiFailure(422, 'Invalid request');
    return new ApiFailure(503, unavailable);
  }

  async function send(token: string, method: string, path: string, query: Query, body?: unknown, extra: Record<string, string> = {}, options: { onResponse?: (response: Response) => void; signal?: AbortSignal } = {}): Promise<unknown> {
    const url = new URL(path, config.APP_SUPABASE_URL);
    url.search = new URLSearchParams(query).toString();
    try {
      const response = await fetcher(url, {
        method, headers: headers(token, method !== 'GET', extra), body: body === undefined ? undefined : JSON.stringify(body),
        signal: options.signal ?? AbortSignal.timeout(10_000), redirect: 'error',
      });
      const text = await response.text();
      const data: unknown = text ? JSON.parse(text) : null;
      if (!response.ok) throw failure(response.status, data);
      options.onResponse?.(response);
      return data;
    } catch (error) {
      if (error instanceof ApiFailure) throw error;
      throw new ApiFailure(503, unavailable);
    }
  }

  return {
    /** 기존 배열 계약용 완전 조회. count가 없거나 중간 실패하면 부분 목록을 반환하지 않는다. */
    async selectAll<T extends { id: string }>(token: string, table: string, query: Query, schema: z.ZodType<T>): Promise<T[]> {
      const fail = () => new ApiFailure(503, unavailable);
      // 마지막 정렬 키가 유일해야 같은 시각·이름의 행도 순서가 안정적이다.
      if (!/(^|,)id\.(asc|desc)$/.test(query.order ?? '') || query.limit !== undefined || query.offset !== undefined) throw fail();
      const rows: T[] = [], seen = new Set<string>();
      const deadline = Date.now() + 30_000;
      let expectedTotal: number | undefined;
      for (let page = 0; page < 100; page++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw fail();
        let range: string | null = null;
        const payload = await send(token, 'GET', `/rest/v1/${table}`, { ...query, limit: '250', offset: String(rows.length) }, undefined, { Prefer: 'count=exact' }, {
          signal: AbortSignal.timeout(Math.min(10_000, remaining)), onResponse: response => { range = response.headers.get('content-range'); },
        });
        const parsed = z.array(schema).safeParse(payload);
        const match = /^(?:(\d+)-(\d+)|\*)\/(\d+)$/.exec(range ?? '');
        if (!parsed.success || !match) throw fail();
        const total = Number(match[3]);
        if (!Number.isSafeInteger(total) || total > 20_000 || (expectedTotal !== undefined && total !== expectedTotal)) throw fail();
        expectedTotal = total;
        const batch = parsed.data;
        if (total === 0) {
          if (rows.length !== 0 || batch.length !== 0 || match[1] !== undefined) throw fail();
          return [];
        }
        const start = Number(match[1]), end = Number(match[2]);
        if (!batch.length || batch.length > 250 || start !== rows.length || end !== start + batch.length - 1 || end >= total) throw fail();
        for (const row of batch) {
          if (!row.id || seen.has(row.id)) throw fail();
          seen.add(row.id);
          rows.push(row);
        }
        if (rows.length === total) return rows;
      }
      throw fail();
    },
    /** GET /rest/v1/{table} — 배열 응답을 스키마로 검증한다. */
    async select<T>(token: string, table: string, query: Query, schema: z.ZodType<T>): Promise<T[]> {
      const parsed = z.array(schema).safeParse(await send(token, 'GET', `/rest/v1/${table}`, query));
      if (!parsed.success) throw new ApiFailure(503, unavailable);
      return parsed.data;
    },
    async insert<T>(token: string, table: string, row: unknown, schema: z.ZodType<T>, query: Query = { select: '*' }): Promise<T> {
      const parsed = z.array(schema).safeParse(await send(token, 'POST', `/rest/v1/${table}`, query, row));
      if (!parsed.success || !parsed.data[0]) throw new ApiFailure(503, unavailable);
      return parsed.data[0];
    },
    /** PATCH 후 첫 행을 돌려준다. 일치하는 행이 없으면 null. */
    async update<T>(token: string, table: string, query: Query, patch: unknown, schema: z.ZodType<T>): Promise<T | null> {
      const parsed = z.array(schema).safeParse(await send(token, 'PATCH', `/rest/v1/${table}`, { select: '*', ...query }, patch));
      if (!parsed.success) throw new ApiFailure(503, unavailable);
      return parsed.data[0] ?? null;
    },
    async remove(token: string, table: string, query: Query): Promise<void> { await send(token, 'DELETE', `/rest/v1/${table}`, query); },
    /** POST /rest/v1/rpc/{name} — 반환 형식은 호출자가 스키마로 검증한다. */
    async rpc<T>(token: string, name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
      const parsed = schema.safeParse(await send(token, 'POST', `/rest/v1/rpc/${name}`, {}, args));
      if (!parsed.success) throw new ApiFailure(503, unavailable);
      return parsed.data;
    },
    async userId(token: string): Promise<string> {
      const parsed = z.object({ id: z.uuid() }).safeParse(await send(token, 'GET', '/auth/v1/user', {}));
      if (!parsed.success) throw new ApiFailure(503, unavailable);
      return parsed.data.id;
    },
  };
}

/** 반환 행이 요청한 조직의 것인지 확인한다. 다르면 서버 오류로 취급한다. */
export function assertOrganization<T extends { organization_id?: unknown }>(rows: T[], organizationId: string, unavailable = 'Service unavailable'): T[] {
  if (rows.some((row) => row.organization_id !== organizationId)) throw new ApiFailure(503, unavailable);
  return rows;
}
