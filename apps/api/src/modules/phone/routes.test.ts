import { describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';

const org = 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const customerId = 'c9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const otherId = 'd9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const customer = { id: customerId, organization_id: org, name: '김고객', email: 'private@example.com', phone: '010-1234-5678', notes: 'private note', birth_date: null, skin_type: null, concerns: [], allergies: '', last_visit_date: null, next_visit_date: null, tags: [], status: 'active' };
const activity = { id: otherId, organization_id: org, customer_id: customerId, activity_type: 'phone_call', title: '전화 상담', description: '예약 문의', occurred_at: '2026-10-21T00:00:00Z' };

function fixture(overrides: { access?: (token: string, orgId: string, feature: string, write?: boolean) => Promise<string>; results?: typeof customer[] } = {}) {
  const accessWrites: boolean[] = [];
  const created: unknown[] = [];
  const organizations = { requireAccess: overrides.access ?? (async (_t: string, _o: string, feature: string, write = false) => { expect(feature).toBe('crm.basic'); accessWrites.push(write); return 'member'; }) };
  const customers = { search: async () => ({ items: overrides.results ?? [customer], total: (overrides.results ?? [customer]).length }) };
  const activities = { create: async (_t: string, _o: string, _c: string, input: { activity_type: string; title: string; description: string; occurred_at: string | null }) => { created.push(input); return { ...activity, ...input }; } };
  return { app: createApp({ organizations: organizations as never, customers: customers as never, activities: activities as never }), accessWrites, created };
}

describe('mobile phone companion API', () => {
  it('returns only active customers with callable phone fields, never profile details', async () => {
    const { app } = fixture();
    const result = await app.inject({ url: `/api/v1/organizations/${org}/mobile/phone-directory`, headers: { authorization: 'Bearer token' } });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ items: [{ customer_id: customerId, name: '김고객', phone: '010-1234-5678', phone_e164: '+821012345678' }], next_cursor: null });
    await app.close();
  });

  it('normalizes country code and returns exact matches only', async () => {
    const { app } = fixture({ results: [customer, { ...customer, id: otherId, phone: '010-1234-5679' }] });
    const result = await app.inject({ method: 'POST', url: `/api/v1/organizations/${org}/mobile/phone-identification`, headers: { authorization: 'Bearer token' }, payload: { number: '+82 10 1234 5678' } });
    expect(result.statusCode).toBe(200);
    expect(result.json().matches).toEqual([{ customer_id: customerId, name: '김고객', phone: '010-1234-5678', phone_e164: '+821012345678' }]);
    expect((await app.inject({ method: 'POST', url: `/api/v1/organizations/${org}/mobile/phone-identification`, headers: { authorization: 'Bearer token' }, payload: { number: '발신번호 표시제한' } })).statusCode).toBe(422);
    await app.close();
  });

  it('lets an authenticated organization member save only a verified call memo without admin write permission', async () => {
    const { app, accessWrites, created } = fixture();
    const result = await app.inject({ method: 'POST', url: `/api/v1/organizations/${org}/mobile/phone-memos`, headers: { authorization: 'Bearer token' }, payload: { customer_id: customerId, phone: '+821012345678', memo: '예약 문의' } });
    expect(result.statusCode).toBe(201);
    expect(result.json()).toMatchObject({ activity_type: 'phone_call', customer_id: customerId, description: '예약 문의' });
    expect(accessWrites).toEqual([false]);
    expect(created).toEqual([{ activity_type: 'phone_call', title: '전화 상담', description: '예약 문의', occurred_at: null }]);
    await app.close();
  });

  it('rejects wrong customer/number pairs, malformed bodies, missing auth and cross-org requests', async () => {
    const { app } = fixture();
    const base = `/api/v1/organizations/${org}/mobile/phone-memos`;
    expect((await app.inject({ method: 'POST', url: base, headers: { authorization: 'Bearer token' }, payload: { customer_id: otherId, phone: customer.phone, memo: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: base, headers: { authorization: 'Bearer token' }, payload: { customer_id: customerId, phone: customer.phone, memo: ' ' } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: base, payload: { customer_id: customerId, phone: customer.phone, memo: 'x' } })).statusCode).toBe(401);
    const denied = fixture({ access: async () => { throw Object.assign(new Error('denied'), { statusCode: 403 }); } });
    expect((await denied.app.inject({ url: `/api/v1/organizations/${otherId}/mobile/phone-directory`, headers: { authorization: 'Bearer token' } })).statusCode).toBe(403);
    await app.close(); await denied.app.close();
  });
});
