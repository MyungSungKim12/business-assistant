import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../app.js';
import { createOrganizationGateway } from '../supabase/organizations.js';
import { fakeFetch, ORG, testConfig, type FakeCall, type FakeReply } from '../modules/catalog/testkit.js';

const USER = 'b9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const TARGET = 'c9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const headers = { authorization: 'Bearer access' };

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

function setup(rpc: (call: FakeCall) => FakeReply = () => ({ body: [] }), role = 'owner', options: { accessCacheTtlSec?: number } = {}) {
  let time = 0;
  const { fetcher, calls } = fakeFetch((call) => {
    const path = call.url.pathname;
    if (path === '/auth/v1/user') return { body: { id: USER } };
    if (path.endsWith('organization_exists')) return { body: true };
    if (path === '/rest/v1/memberships') return { body: [{ role, user_id: USER }] };
    if (path === '/rest/v1/subscriptions') return { body: [{ status: 'active', ends_at: null, plans: { code: 'pro', plan_features: [{ feature_code: 'crm.basic' }] } }] };
    return rpc(call);
  });
  const gateway = createOrganizationGateway(testConfig, fetcher, { ...options, now: () => time });
  app = createApp({ organizations: gateway });
  return { calls, gateway, advance: (ms: number) => { time += ms; } };
}
const url = (suffix = '') => `/api/v1/organizations/${ORG}/members${suffix}`;
const rpcCalls = (calls: FakeCall[], name: string) => calls.filter((call) => call.url.pathname === `/rest/v1/rpc/${name}`);
const failure = (message: string, status = 400) => ({ status, body: { code: 'P0001', message } });

describe('구성원 관리 라우트', () => {
  it('상세 목록은 RPC 결과를 그대로 돌려주고 기존 /members 는 그대로다', async () => {
    const row = { user_id: USER, email: 'a@example.com', display_name: '관리자', role: 'owner', joined_at: '2026-10-01T00:00:00Z' };
    const { calls } = setup(() => ({ body: [row] }));
    const detail = await app.inject({ url: url('/detail'), headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual([row]);
    expect(rpcCalls(calls, 'list_organization_members')[0].body).toEqual({ p_org: ORG });
    await app.close();
    setup(() => ({ body: [] }));
    const legacy = await app.inject({ url: url(), headers });
    expect(legacy.statusCode).toBe(200);
  });

  it('토큰이 없으면 401', async () => {
    setup();
    expect((await app.inject({ url: url('/detail') })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: url(), payload: { email: 'a@b.co' } })).statusCode).toBe(401);
  });

  it('이메일로 추가: 입력을 정규화하고 201, 미가입이면 404 member_user_not_found', async () => {
    const { calls } = setup((call) => ((call.body as { p_email?: string }).p_email === 'new@example.com' ? { body: { user_id: TARGET, role: 'member' } } : failure('user_not_found')));
    const ok = await app.inject({ method: 'POST', url: url(), headers, payload: { email: ' New@Example.com ' } });
    expect(ok.statusCode).toBe(201);
    expect(rpcCalls(calls, 'add_organization_member_by_email')[0].body).toEqual({ p_org: ORG, p_email: 'new@example.com', p_role: 'member' });
    const missing = await app.inject({ method: 'POST', url: url(), headers, payload: { email: 'none@example.com' } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('member_user_not_found');
  });

  it('입력 오류는 422(이메일 형식, 알 수 없는 필드, owner 로 추가 시도)', async () => {
    const { calls } = setup();
    for (const payload of [{ email: 'nope' }, { email: 'a@b.co', extra: 1 }, { email: 'a@b.co', role: 'owner' }]) {
      expect((await app.inject({ method: 'POST', url: url(), headers, payload })).statusCode).toBe(422);
    }
    expect(rpcCalls(calls, 'add_organization_member_by_email')).toHaveLength(0);
  });

  it('역할 변경: 마지막 owner 는 409 last_owner, 본인은 409 self_change', async () => {
    setup(() => failure('last_owner'));
    const last = await app.inject({ method: 'PATCH', url: url(`/${TARGET}`), headers, payload: { role: 'member' } });
    expect(last.statusCode).toBe(409);
    expect(last.json().code).toBe('last_owner');
    await app.close();
    setup(() => failure('self_change'));
    const self = await app.inject({ method: 'PATCH', url: url(`/${USER}`), headers, payload: { role: 'member' } });
    expect(self.json().code).toBe('self_change');
  });

  it('역할 변경 입력 검증: 잘못된 사용자 ID·역할은 422', async () => {
    setup();
    expect((await app.inject({ method: 'PATCH', url: url('/not-a-uuid'), headers, payload: { role: 'member' } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'PATCH', url: url(`/${TARGET}`), headers, payload: { role: 'god' } })).statusCode).toBe(422);
  });

  it('권한 없음(RPC forbidden)은 403', async () => {
    setup(() => ({ status: 403, body: { code: '42501', message: 'forbidden' } }));
    const result = await app.inject({ method: 'DELETE', url: url(`/${TARGET}`), headers });
    expect(result.statusCode).toBe(403);
  });

  it('제거 성공은 204', async () => {
    const { calls } = setup(() => ({ body: { user_id: TARGET, removed: true } }));
    const result = await app.inject({ method: 'DELETE', url: url(`/${TARGET}`), headers });
    expect(result.statusCode).toBe(204);
    expect(rpcCalls(calls, 'remove_organization_member')[0].body).toEqual({ p_org: ORG, p_user: TARGET });
  });

  it('알 수 없는 RPC 오류 메시지는 원문을 노출하지 않고 503', async () => {
    setup(() => ({ status: 500, body: { message: 'secret internal detail' } }));
    const result = await app.inject({ method: 'DELETE', url: url(`/${TARGET}`), headers });
    expect(result.statusCode).toBe(503);
    expect(result.body).not.toContain('secret internal detail');
  });
});

describe('권한 검사 캐시(requireAccess)', () => {
  const accessCalls = (calls: FakeCall[]) => calls.filter((call) => call.url.pathname === '/rest/v1/memberships').length;

  it('같은 토큰·조직·기능은 TTL 안에서 한 번만 조회한다', async () => {
    const { gateway, calls, advance } = setup();
    expect(await gateway.requireAccess('t', ORG, 'crm.basic')).toBe('owner');
    expect(await gateway.requireAccess('t', ORG, 'crm.basic')).toBe('owner');
    expect(accessCalls(calls)).toBe(1);
    advance(31_000);
    await gateway.requireAccess('t', ORG, 'crm.basic');
    expect(accessCalls(calls)).toBe(2);
  });

  it('다른 토큰과 쓰기 검사는 캐시를 공유하지 않는다', async () => {
    const { gateway, calls } = setup();
    await gateway.requireAccess('t1', ORG, 'crm.basic');
    await gateway.requireAccess('t2', ORG, 'crm.basic');
    await gateway.requireAccess('t1', ORG, 'crm.basic', true);
    expect(accessCalls(calls)).toBe(3);
  });

  it('거부 결과는 캐시하지 않는다', async () => {
    const { gateway, calls } = setup();
    await expect(gateway.requireAccess('t', ORG, 'unknown.feature')).rejects.toMatchObject({ status: 403 });
    await expect(gateway.requireAccess('t', ORG, 'unknown.feature')).rejects.toMatchObject({ status: 403 });
    expect(accessCalls(calls)).toBe(2);
  });

  it('역할 변경·제거·추가 성공 뒤에는 캐시가 무효화된다', async () => {
    const { gateway, calls } = setup(() => ({ body: { user_id: TARGET, role: 'admin', removed: true } }));
    await gateway.requireAccess('t', ORG, 'crm.basic');
    await gateway.setMemberRole('t', ORG, TARGET, 'admin');
    await gateway.requireAccess('t', ORG, 'crm.basic');
    expect(accessCalls(calls)).toBe(2);
    await gateway.removeMember('t', ORG, TARGET);
    await gateway.requireAccess('t', ORG, 'crm.basic');
    expect(accessCalls(calls)).toBe(3);
    await gateway.addMemberByEmail('t', ORG, 'a@b.co', 'member');
    await gateway.requireAccess('t', ORG, 'crm.basic');
    expect(accessCalls(calls)).toBe(4);
  });

  it('TTL 0 이면 매번 조회한다', async () => {
    const { gateway, calls } = setup(undefined, 'owner', { accessCacheTtlSec: 0 });
    await gateway.requireAccess('t', ORG, 'crm.basic');
    await gateway.requireAccess('t', ORG, 'crm.basic');
    expect(accessCalls(calls)).toBe(2);
  });
});
