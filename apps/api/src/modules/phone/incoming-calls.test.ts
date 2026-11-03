import { describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { ApiFailure } from '../../errors.js';
import { CallRelayStore } from './relay-test-store.js';

const org = 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const user = 'b9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const customerId = 'c9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const id = 'd9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const match = { customer_id: customerId, name: '김고객', phone: '01012345678', phone_e164: '+821012345678' };
const path = `/api/v1/organizations/${org}/mobile/incoming-calls`;
function fixture() {
  const store=new CallRelayStore();
  return createApp({
    phone: {request:async(token,organizationId,action,input)=>{
      const recipient=token==='alice'?user:customerId;
      if(action==='poll')return store.poll(organizationId,recipient,String(input.after??''),0);
      if(action!=='publish')throw new Error('unused');
      const occurred=String(input.occurred_at);const age=Date.now()-Date.parse(occurred);
      if(age>120000||age < -30000)throw new ApiFailure(422,'Expired');
      if(String(input.number).replace(/\D/g,'')!=='01012345678')throw new ApiFailure(404,'No match');
      return {...store.publish(organizationId,recipient,{id:String(input.event_id),phone_e164:match.phone_e164,occurred_at:occurred,matches:[match]}),retained:false};
    }},
    auth: { signIn: async () => { throw new Error('unused'); }, getUser: async token => ({ userId: token === 'alice' ? user : customerId, email: 'test@example.com', displayName: null }) },
    organizations: { requireAccess: async (_token: string, requested: string, feature: string) => { expect(feature).toBe('crm.basic'); if (requested !== org) throw new ApiFailure(403, 'Denied'); return 'member'; } } as never,
    customers: { search: async () => ({ total: 1, items: [{ id: customerId, organization_id: org, name: match.name, phone: match.phone, status: 'active' }] }) } as never,
    activities: {} as never,
  });
}
describe('mobile to PC call relay', () => {
  it('delivers only to the same authenticated user and organization, deduplicates retries and rejects altered reuse', async () => {
    const app = fixture();
    const input = { event_id: id, number: '010-1234-5678', occurred_at: new Date().toISOString() };
    const post = (payload: unknown) => app.inject({ method: 'POST', url: path, headers: { authorization: 'Bearer alice' }, payload: payload as object });
    expect((await post(input)).statusCode).toBe(201);
    expect((await post(input)).statusCode).toBe(200);
    const alice = await app.inject({ url: path + '?wait_ms=0', headers: { authorization: 'Bearer alice' } });
    expect(alice.json().items).toHaveLength(1);
    expect(alice.json().items[0]).toMatchObject({ id, phone_e164: match.phone_e164, matches: [match] });
    expect((await app.inject({ url: path + '?wait_ms=0', headers: { authorization: 'Bearer bob' } })).json().items).toEqual([]);
    expect((await app.inject({ url: path + `?wait_ms=0&after=${encodeURIComponent(alice.json().cursor)}`, headers: { authorization: 'Bearer alice' } })).json().items).toEqual([]);
    expect((await post({ ...input, occurred_at: new Date(Date.now() - 1000).toISOString() })).statusCode).toBe(409);
    expect((await post({ ...input, actor_id: customerId })).statusCode).toBe(422);
    expect((await post({ ...input, occurred_at: new Date(Date.now() - 121_000).toISOString() })).statusCode).toBe(422);
    expect((await post({ ...input, occurred_at: new Date(Date.now() + 60_000).toISOString() })).statusCode).toBe(422);
    expect((await post({ ...input, number: '01099999999' })).statusCode).toBe(404);
    expect((await app.inject({ url: path + '?wait_ms=0' })).statusCode).toBe(401);
    expect((await app.inject({ url: path.replace(org, id) + '?wait_ms=0', headers: { authorization: 'Bearer alice' } })).statusCode).toBe(403);
    await app.close();
  });

  it('expires events, handles a restarted cursor and wakes long polls without duplicate delivery', async () => {
    let now = Date.now();
    const store = new CallRelayStore(() => now);
    const empty = await store.poll(org, user, '', 0);
    const waiting = store.poll(org, user, empty.cursor, 1000);
    store.publish(org, user, { id, phone_e164: match.phone_e164, occurred_at: new Date(now).toISOString(), matches: [match] });
    expect((await waiting).items).toHaveLength(1);
    expect((await store.poll(org, user, 'old-instance:9999', 0)).items).toHaveLength(1);
    expect((await store.poll(org, customerId, '', 0)).items).toEqual([]);
    now += 121_000;
    expect((await store.poll(org, user, '', 0)).items).toEqual([]);
    store.close();
  });
});
