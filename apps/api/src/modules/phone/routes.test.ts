import { describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import type { CustomerSearchQuery } from '../../supabase/customers.js';

const org = 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const customerId = 'c9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const otherId = 'd9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const customer = { id: customerId, organization_id: org, name: '김고객', email: 'private@example.com', phone: '010-1234-5678', notes: 'private note', birth_date: null, skin_type: null, concerns: [], allergies: '', last_visit_date: null, next_visit_date: null, tags: [] as string[], status: 'active' };
const activity = { id: otherId, organization_id: org, customer_id: customerId, activity_type: 'phone_call', title: '전화 상담', description: '예약 문의', occurred_at: '2026-10-21T00:00:00Z' };

function fixture(overrides: { access?: (token: string, orgId: string, feature: string, write?: boolean) => Promise<string>; results?: typeof customer[] } = {}) {
  const accessWrites: boolean[] = [];
  const created: unknown[] = [];
  const organizations = { requireAccess: overrides.access ?? (async (_t: string, _o: string, feature: string, write = false) => { expect(feature).toBe('crm.basic'); accessWrites.push(write); return 'member'; }) };
  // The real PostgREST adapter matches ordered digits across stored separators;
  // it does not rewrite a domestic 010 prefix into a country code for searching.
  const customers = { search: async (_token: string, _org: string, query: CustomerSearchQuery) => {
    const pattern = new RegExp(query.q.replace(/\D/g, '').split('').join('.*'));
    const rows = (overrides.results ?? [customer]).filter(row => !query.q || pattern.test(row.phone ?? ''));
    return { items: rows.slice(query.offset, query.offset + query.limit), total: rows.length };
  } };
  const activities = { create: async (_t: string, _o: string, _c: string, input: { activity_type: string; title: string; description: string; occurred_at: string | null }) => { created.push(input); return { ...activity, ...input }; } };
  return { app: createApp({ organizations: organizations as never, customers: customers as never, activities: activities as never }), accessWrites, created };
}

describe('mobile phone companion API', () => {
  it('includes legacy VIP customers but excludes inactive, blocked and archived records',async()=>{
    const {app}=fixture({results:['vip','inactive','blocked','archived'].map((status,index)=>({...customer,id:index===0?customerId:otherId,status}))});
    const headers={authorization:'Bearer token'};
    const directory=await app.inject({url:`/api/v1/organizations/${org}/mobile/phone-directory`,headers});
    expect(directory.json().items.map((row:{customer_id:string})=>row.customer_id)).toEqual([customerId]);
    const match=await app.inject({method:'POST',url:`/api/v1/organizations/${org}/mobile/phone-identification`,headers,payload:{number:customer.phone}});
    expect(match.json().matches.map((row:{customer_id:string})=>row.customer_id)).toEqual([customerId]);
    await app.close();
  });
  it('returns only scoped caller profile fields and never enriches the mobile directory', async () => {
    const row = { ...customer, notes: '조용한 상담 선호', allergies: '라텍스', tags: ['단골'], email: 'private@example.com' };
    const { app } = fixture({ results: [row] });
    const url = `/api/v1/organizations/${org}/phone/caller-profile`;
    const request = (payload: object, token = 'token') => app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload });
    const response = await request({ customer_id: customerId, number: customer.phone });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ customer_id: customerId, notes: row.notes, allergies: row.allergies, tags: row.tags });
    expect((await request({ customer_id: customerId, number: '01099999999' })).statusCode).toBe(404);
    expect((await request({ customer_id: org, number: customer.phone })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url, payload: { customer_id: customerId, number: customer.phone } })).statusCode).toBe(401);
    const mobile = await app.inject({ method: 'POST', url: `/api/v1/organizations/${org}/mobile/phone-identification`, headers: { authorization: 'Bearer token' }, payload: { number: customer.phone } });
    expect(mobile.json()).not.toHaveProperty('profiles');
    expect(mobile.json().matches[0]).not.toHaveProperty('notes');
    const denied = fixture({ access: async () => { throw Object.assign(new Error('denied'), { statusCode: 403 }); } });
    expect((await denied.app.inject({ method: 'POST', url: url.replace(org, otherId), headers: { authorization: 'Bearer token' }, payload: { customer_id: customerId, number: customer.phone } })).statusCode).toBe(403);
    const foreign = fixture({ results: [{ ...row, organization_id: otherId }] });
    expect((await foreign.app.inject({ method: 'POST', url, headers: { authorization: 'Bearer token' }, payload: { customer_id: customerId, number: customer.phone } })).statusCode).toBe(404);
    await denied.app.close(); await foreign.app.close();
    await app.close();
  });
  it.each(['010-1234-5678', '+82 10 1234 5678', '00821012345678'])('finds domestic stored numbers for %s', async number => {
    const { app } = fixture();
    const response = await app.inject({ method: 'POST', url: `/api/v1/organizations/${org}/mobile/phone-identification`, headers: { authorization: 'Bearer token' }, payload: { number } });
    expect(response.statusCode).toBe(200);
    expect(response.json().matches.map((row: { customer_id: string }) => row.customer_id)).toEqual([customerId]);
    await app.close();
  });

  it('keeps exact matches after the first candidate page and does not match digit subsequences', async () => {
    const falseCandidate = { ...customer, phone: '010-1234-05678' };
    const { app } = fixture({ results: [...Array.from({ length: 200 }, () => falseCandidate), customer] });
    const response = await app.inject({ method: 'POST', url: `/api/v1/organizations/${org}/mobile/phone-identification`, headers: { authorization: 'Bearer token' }, payload: { number: customer.phone } });
    expect(response.statusCode).toBe(200);
    expect(response.json().matches).toHaveLength(1);
    expect(response.json().matches[0].phone).toBe(customer.phone);
    await app.close();
  });

  it('finds both stored country-code and domestic forms without choosing one duplicate', async () => {
    const { app } = fixture({ results: [customer, { ...customer, id: otherId, phone: '+82 10 1234 5678' }, { ...customer, status: 'archived' }, { ...customer, organization_id: otherId }] });
    const response = await app.inject({ method: 'POST', url: `/api/v1/organizations/${org}/mobile/phone-identification`, headers: { authorization: 'Bearer token' }, payload: { number: '01012345678' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().matches.map((row: { customer_id: string }) => row.customer_id)).toEqual([customerId, otherId]);
    await app.close();
  });
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
