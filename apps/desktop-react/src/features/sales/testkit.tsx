import { vi } from 'vitest';
import type { z } from 'zod';
import { ApiError } from '../../api/errors';

export const ORG = 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
export const CUSTOMER = '55555555-5555-4555-8555-555555555555';
export const CUSTOMER2 = '55555555-5555-4555-8555-555555555556';
export const VISIT = '66666666-6666-4666-8666-666666666666';
export const CART = '44444444-4444-4444-8444-444444444444';
export const DRAFT = '77777777-7777-4777-8777-777777777777';
export const LINE = '88888888-8888-4888-8888-888888888888';
export const PRODUCT = '99999999-9999-4999-8999-999999999991';
export const USER = '12345678-1234-4678-9234-567812345678';
export const uid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

export const customer = (id: string, name: string) => ({
  id, organization_id: ORG, name, email: null, phone: '010-1234-5678', notes: '', birth_date: null, skin_type: null, concerns: [], allergies: '',
  last_visit_date: null, next_visit_date: null, tags: [], status: 'active',
});
export const visit = (over: Record<string, unknown> = {}) => ({
  id: VISIT, organization_id: ORG, customer_id: CUSTOMER, appointment_id: null, status: 'open', opened_at: '2030-01-01T01:00:00Z', closed_at: null, version: 1, ...over,
});
export const draft = (over: Record<string, unknown> = {}) => ({ id: DRAFT, customer_id: CUSTOMER, treatment_id: uid(1), description: '보톡스 시술', amount: '150000.00', created_at: '2030-01-01T00:00:00Z', ...over });
export const cartLine = (over: Record<string, unknown> = {}) => ({
  id: LINE, cart_id: CART, source_type: 'treatment_draft', source_id: DRAFT, description_snapshot: '보톡스 시술', quantity: 1, returned_quantity: 0,
  unit_price: '150000.00', line_total: '150000.00', staff_id: null, staff_name_snapshot: '', status: 'active', removal_reason: '', ...over,
});
export const bundle = (over: { cart?: Record<string, unknown>; lines?: unknown[]; visit?: Record<string, unknown>; discount_history?: unknown[] } = {}) => ({
  visit: visit(over.visit),
  cart: {
    id: CART, organization_id: ORG, visit_id: VISIT, customer_id: CUSTOMER, status: 'draft', version: 1, subtotal: '0.00', discount_total: '0.00', discount_kind: 'none',
    discount_value: '0', discount_reason: '', total_amount: '0.00', ...over.cart,
  },
  lines: over.lines ?? [], discount_history: over.discount_history ?? [],
});
export const payments = (over: Record<string, unknown> = {}) => ({
  visit_id: VISIT, cart_id: CART, cart_version: 3, total_amount: '100000', paid_amount: '0', outstanding_amount: '100000', refunded_amount: '0', currency: 'KRW', status: 'ready',
  receipts: [], refunds: [], ...over,
});
export const receipt = (over: Record<string, unknown> = {}) => ({ id: uid(7), method: 'card', amount: '60000', reference: 'A-1', received_at: '2030-01-01T02:00:00Z', operation_id: uid(8), ...over });

export type Call = { method: string; path: string; body: unknown };
export type Handler = (body: unknown, call: Call) => unknown;

/** 경로 패턴("GET /visits/:id/sale-cart")별 핸들러로 api.call을 흉내 내고, 응답은 실제 zod 스키마로 검증한다. */
export function fakeApi(handlers: Record<string, Handler>, extra: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const routes = Object.entries(handlers).map(([key, handler]) => {
    const [method, pattern] = key.split(' ');
    return { method, regex: new RegExp(`^${pattern.replace(/:[a-z]+/g, '[^/?]+')}$`), handler };
  });
  const call = vi.fn(async (method: string, rawPath: string, schema: z.ZodType<unknown>, body?: unknown) => {
    const path = rawPath.replace(`/organizations/${ORG}`, '').split('?')[0];
    const record = { method, path: rawPath.replace(`/organizations/${ORG}`, ''), body };
    calls.push(record);
    const route = routes.find((item) => item.method === method && item.regex.test(path));
    if (!route) throw new ApiError(404, 'HTTP_404', 'not found', false);
    const result = route.handler(body, record);
    if (result instanceof Error) throw result;
    return schema.parse(result);
  });
  const api = { call, listCustomers: vi.fn(async () => [customer(CUSTOMER, '김고객'), customer(CUSTOMER2, '이고객')]), listOperationRecords: vi.fn(async () => []), ...extra };
  return { api: api as never, call, calls };
}

export const network = () => new ApiError(0, 'NETWORK_ERROR', '네트워크에 연결할 수 없습니다.', true);
export const conflict = () => new ApiError(409, 'HTTP_409', 'Sale cart conflict', false);
