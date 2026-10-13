import Fastify, { type FastifyInstance } from 'fastify';
import { ApiFailure } from '../../errors.js';
import type { ServerConfig } from '../../config.js';
import { registerSalesModule } from './index.js';

export const org = 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
export const customerId = '55555555-5555-4555-8555-555555555555';
export const visitId = '66666666-6666-4666-8666-666666666666';
export const cartId = '44444444-4444-4444-8444-444444444444';
export const draftId = '77777777-7777-4777-8777-777777777777';
export const lineId = '88888888-8888-4888-8888-888888888888';
export const op = '99999999-9999-4999-8999-999999999999';
export const userId = '12345678-1234-4678-9234-567812345678';
export const config: ServerConfig = { APP_SUPABASE_URL: 'https://project.supabase.co', APP_SUPABASE_PUBLISHABLE_KEY: 'publishable', APP_FILE_BUCKET: 'files', APP_API_PORT: 8000 };

export type Call = { method: string; path: string; query: Record<string, string>; body: unknown; headers: Record<string, string> };
export type Reply = { status?: number; body: unknown };
export type Responder = (call: Call) => Reply | undefined;

export const visitRow = (over: Record<string, unknown> = {}) => ({
  id: visitId, organization_id: org, customer_id: customerId, appointment_id: null, status: 'open', opened_at: '2030-01-01T00:00:00Z', closed_at: null, version: 1, ...over,
});
export const bundle = (version = 1, over: { cart?: Record<string, unknown>; lines?: unknown[] } = {}) => ({
  visit: visitRow(),
  cart: { id: cartId, organization_id: org, visit_id: visitId, customer_id: customerId, status: 'draft', version, subtotal: '0.00', discount_total: '0.00', total_amount: '0.00', ...over.cart },
  lines: over.lines ?? [],
});
export const line = (over: Record<string, unknown> = {}) => ({
  id: lineId, organization_id: org, cart_id: cartId, source_type: 'treatment_draft', source_id: draftId, description_snapshot: '보톡스', quantity: 1, returned_quantity: 0,
  unit_price: '100000.00', line_total: '100000.00', staff_id: null, staff_name_snapshot: '', source_snapshot: {}, status: 'active', removal_reason: '',
  created_at: '2030-01-01T00:00:00Z', removed_at: null, ...over,
});
export const payments = (over: Record<string, unknown> = {}) => ({
  visit_id: visitId, cart_id: cartId, cart_version: 3, total_amount: '100000', paid_amount: '0', outstanding_amount: '100000', currency: 'KRW', status: 'ready', receipts: [], ...over,
});

/** 가짜 Supabase. 호출을 기록하고 responder가 응답을 정한다. */
export function sandbox(responder: Responder = () => undefined, options: { role?: 'owner' | 'admin' | 'member'; features?: string[] } = {}) {
  const calls: Call[] = [];
  const access: Array<{ feature: string; write: boolean }> = [];
  const features = options.features ?? ['crm.basic', 'finance.basic'];
  const role = options.role ?? 'owner';
  const fetcher = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), headers: init?.headers as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const reply = responder(call) ?? { body: [] };
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const organizations = {
    async requireAccess(token: string, id: string, feature: string, write = false) {
      if (token !== 'access' || id !== org) throw new ApiFailure(403, 'Access denied');
      access.push({ feature, write });
      if (!features.includes(feature)) throw new ApiFailure(403, 'Feature not available');
      if (write && role === 'member') throw new ApiFailure(403, 'Organization management permission required');
      return role;
    },
  };
  const app: FastifyInstance = Fastify();
  app.setErrorHandler((error, request, reply) => {
    const status = error instanceof ApiFailure ? error.status : 500;
    return reply.code(status).send({ detail: error instanceof ApiFailure ? error.detail : 'Internal server error', ...(error instanceof ApiFailure ? error.extra : {}), requestId: request.id });
  });
  registerSalesModule(app, organizations, config, fetcher);
  const send = (method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, token: string | null = 'access') =>
    app.inject({ method, url: `/api/v1/organizations/${org}${path}`, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(body === undefined ? {} : { payload: body as object }) });
  return { app, calls, access, send };
}
