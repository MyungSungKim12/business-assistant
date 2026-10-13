import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { ApiFailure } from '../errors.js';
import type { OperationsGateway } from '../routes/operations.js';

export function createOperationsGateway(config: ServerConfig, fetcher: typeof fetch = fetch): OperationsGateway {
  const headers = (token: string, write = false) => ({ apikey: config.APP_SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(write ? { Prefer: 'return=representation' } : {}) });
  async function userId(token: string) {
    try {
      const response = await fetcher(new URL('/auth/v1/user', config.APP_SUPABASE_URL), { headers: headers(token), signal: AbortSignal.timeout(10_000), redirect: 'error' });
      const parsed = z.object({ id: z.uuid() }).safeParse(await response.json());
      if (!response.ok || !parsed.success) throw new ApiFailure(response.status === 401 ? 401 : 503, response.status === 401 ? 'Not authenticated' : 'Operation service unavailable');
      return parsed.data.id;
    } catch (error) { if (error instanceof ApiFailure) throw error; throw new ApiFailure(503, 'Operation service unavailable'); }
  }
  async function call(token: string, method: 'GET'|'POST'|'PATCH', table: string, params: Record<string,string>, body?: unknown) {
    const url = new URL(`/rest/v1/${table}`, config.APP_SUPABASE_URL); url.search = new URLSearchParams(params).toString();
    try {
      const response = await fetcher(url, { method, headers: headers(token, method !== 'GET'), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: 'error' });
      if (response.status === 401) throw new ApiFailure(401, 'Not authenticated');
      if (response.status === 403) throw new ApiFailure(403, 'Access denied');
      if (!response.ok) throw new ApiFailure(response.status === 409 ? 409 : 503, response.status === 409 ? 'Record conflict' : 'Operation service unavailable');
      const data: unknown = await response.json(); if (!Array.isArray(data)) throw new ApiFailure(503, 'Operation service unavailable');
      return data as Record<string,unknown>[];
    } catch (error) { if (error instanceof ApiFailure) throw error; throw new ApiFailure(503, 'Operation service unavailable'); }
  }
  const checked = (rows: Record<string,unknown>[], organizationId: string) => { if (rows.some((row) => row.organization_id !== organizationId)) throw new ApiFailure(503, 'Operation service unavailable'); return rows; };
  return {
    async list(token, organizationId, table, order) { return checked(await call(token, 'GET', table, { select: '*', organization_id: `eq.${organizationId}`, order, limit: '500' }), organizationId); },
    async create(token, organizationId, table, values, createdBy) { const rows=checked(await call(token,'POST',table,{select:'*'},{...values,organization_id:organizationId,...(createdBy?{created_by:await userId(token)}:{})}),organizationId);if(!rows[0])throw new ApiFailure(503,'Operation service unavailable');return rows[0]; },
    async update(token, organizationId, table, id, values) { return checked(await call(token,'PATCH',table,{select:'*',id:`eq.${id}`,organization_id:`eq.${organizationId}`},values),organizationId)[0]??null; },
  };
}
