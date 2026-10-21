import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, fakeFetch, ORG, testConfig, type FakeCall, type FakeReply } from '../catalog/testkit.js';
import { registerAdminModule } from './index.js';
import { platformAdminIds } from './gateway.js';

const ADMIN_ID = '12345678-1234-4678-9234-567812345678';
const USER_ID = '87654321-4321-4765-8321-876543218765';
const configured = { ...testConfig, APP_SUPABASE_SERVICE_KEY: 'server-secret', APP_PLATFORM_ADMIN_USER_IDS: ADMIN_ID };
const tokens: Record<string, string> = { admin: ADMIN_ID, user: USER_ID };

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

/** Auth 서버(/auth/v1/user)와 구독 RPC를 흉내 내는 가짜 Supabase. */
function setup(config: Parameters<typeof registerAdminModule>[2] = configured, rpc: (call: FakeCall) => FakeReply = (call) => ({ body: { plan_code: (call.body as { target_plan_code: string }).target_plan_code } })) {
  const { fetcher, calls } = fakeFetch((call) => {
    if (call.url.pathname === '/auth/v1/user') {
      const id = tokens[String(call.headers.Authorization).replace('Bearer ', '')];
      return id ? { body: { id } } : { status: 401, body: { message: 'bad jwt' } };
    }
    return rpc(call);
  });
  app = buildApp((instance) => registerAdminModule(instance, undefined, config, fetcher));
  const post = (token: string | null, body: Record<string, unknown> = {}, organizationId = ORG) => app.inject({
    method: 'POST', url: `/api/v1/admin/organizations/${organizationId}/subscription`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: { plan_code: 'BASIC', status: 'active', starts_at: '2026-09-16T00:00:00Z', ends_at: null, ...body },
  });
  return { post, calls };
}

describe('관리자 구독 교체', () => {
  it('인증이 없으면 401', async () => {
    expect((await setup().post(null)).statusCode).toBe(401);
    expect((await setup().post('unknown')).statusCode).toBe(401);
  });

  it('플랫폼 관리자가 아니면 403이고 서비스 키 RPC에 닿지 않는다', async () => {
    const { post, calls } = setup();
    expect((await post('user')).statusCode).toBe(403);
    expect(calls.some((call) => call.url.pathname.includes('replace_organization_subscription'))).toBe(false);
  });

  it('관리자 목록이 비어 있으면 모두 거부한다', async () => {
    expect((await setup({ ...configured, APP_PLATFORM_ADMIN_USER_IDS: '' }).post('admin')).statusCode).toBe(403);
  });

  it('서버 설정(서비스 키)이 없으면 503이고 인증이 먼저다', async () => {
    const missing = { ...testConfig, APP_PLATFORM_ADMIN_USER_IDS: ADMIN_ID };
    expect((await setup(missing).post('admin')).statusCode).toBe(503);
    expect((await setup(missing).post(null)).statusCode).toBe(401);
  });

  it('유효한 요청은 plan_code를 정규화해 서비스 키로 RPC를 호출한다', async () => {
    const { post, calls } = setup();
    const response = await post('admin', { plan_code: '  basic  ' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ plan_code: 'BASIC', status: 'active', starts_at: '2026-09-16T00:00:00Z', ends_at: null });
    const rpc = calls.find((call) => call.url.pathname === '/rest/v1/rpc/replace_organization_subscription')!;
    expect(rpc.headers.apikey).toBe('server-secret');
    expect(rpc.headers.Authorization).toBe('Bearer server-secret');
    expect(rpc.body).toEqual({ target_organization_id: ORG, target_plan_code: 'BASIC', target_status: 'active', target_starts_at: '2026-09-16T00:00:00Z', target_ends_at: null });
    const auth = calls.find((call) => call.url.pathname === '/auth/v1/user')!;
    expect(auth.headers.apikey).toBe('public-key');
    expect(auth.headers.Authorization).toBe('Bearer admin');
  });

  it.each([
    ['종료가 시작과 같음', { ends_at: '2026-09-16T00:00:00Z' }],
    ['종료가 시작보다 빠름', { ends_at: '2026-09-15T00:00:00Z' }],
    ['시작 시각에 오프셋 없음', { starts_at: '2026-09-16T00:00:00', ends_at: '2026-09-17T00:00:00Z' }],
    ['종료 시각에 오프셋 없음', { ends_at: '2026-09-17T00:00:00' }],
    ['지원하지 않는 상태', { status: 'unknown' }],
    ['빈 plan_code', { plan_code: '   ' }],
  ])('%s 은 422이고 RPC를 호출하지 않는다', async (_name, change) => {
    const { post, calls } = setup();
    expect((await post('admin', change)).statusCode).toBe(422);
    expect(calls.some((call) => call.url.pathname.includes('replace_organization_subscription'))).toBe(false);
  });

  it('오프셋 없는 시각의 오류 메시지는 timezone-aware를 알려 준다', async () => {
    const response = await setup().post('admin', { starts_at: '2026-09-16T00:00:00', ends_at: '2026-09-17T00:00:00Z' });
    expect(response.json().detail).toContain('timezone-aware');
  });

  it('모든 구독 상태를 허용하고 종료 시각이 있는 오프셋 값도 받는다', async () => {
    const { post } = setup();
    for (const status of ['trialing', 'active', 'past_due', 'canceled', 'expired']) expect((await post('admin', { status })).statusCode).toBe(200);
    expect((await post('admin', { starts_at: '2026-09-16T09:00:00+09:00', ends_at: '2026-10-16T09:00:00+09:00' })).statusCode).toBe(200);
  });

  it('조직이 없으면 404, 기타 입력 거부는 422, 그 외 장애는 503', async () => {
    expect((await setup(configured, () => ({ status: 400, body: { message: 'organization not found' } })).post('admin')).statusCode).toBe(404);
    expect((await setup(configured, () => ({ status: 400, body: { message: 'invalid plan' } })).post('admin')).statusCode).toBe(422);
    expect((await setup(configured, () => ({ status: 500, body: { message: 'x' } })).post('admin')).statusCode).toBe(503);
  });

  it('응답의 plan_code가 요청과 다르면 503으로 막고 원문을 노출하지 않는다', async () => {
    const response = await setup(configured, () => ({ body: { plan_code: 'PRO' } })).post('admin');
    expect(response.statusCode).toBe(503);
    expect(response.json().detail).toBe('Admin subscription service unavailable');
  });

  it('조직 ID가 UUID가 아니면 422', async () => {
    expect((await setup().post('admin', {}, 'not-a-uuid')).statusCode).toBe(422);
  });
});

describe('플랫폼 관리자 목록', () => {
  it('쉼표로 구분한 UUID만 읽고 잘못된 항목은 무시한다', () => {
    const ids = platformAdminIds({ ...testConfig }, { APP_PLATFORM_ADMIN_USER_IDS: ` ${ADMIN_ID.toUpperCase()}, bad ,${USER_ID},, ` });
    expect([...ids].sort()).toEqual([ADMIN_ID, USER_ID].sort());
    expect(platformAdminIds({ ...testConfig }, {}).size).toBe(0);
  });
});

describe('요금제별 파일 용량 관리', () => {
  const quotas = [{ code: 'BASIC', name: '베이직', file_storage_quota_bytes: null }];

  it('플랫폼 관리자만 플랜 용량 목록을 서비스 키로 조회한다', async () => {
    const { calls } = setup(configured, call => call.url.pathname === '/rest/v1/plans' ? { body: quotas } : { status: 200, body: null });
    const denied = await app.inject({ method: 'GET', url: '/api/v1/admin/plans/storage-quotas', headers: { authorization: 'Bearer user' } });
    expect(denied.statusCode).toBe(403);
    expect(calls.some(call => call.url.pathname === '/rest/v1/plans')).toBe(false);
  });

  it('목록 응답에서 정책 미설정(null)과 저장 용량을 구별한다', async () => {
    const { calls } = setup(configured, call => call.url.pathname === '/rest/v1/plans' ? { body: quotas } : { status: 200, body: null });
    const response = await app.inject({ method: 'GET', url: '/api/v1/admin/plans/storage-quotas', headers: { authorization: 'Bearer admin' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ plan_code: 'BASIC', plan_name: '베이직', quota_bytes: null }]);
    const request = calls.find(call => call.url.pathname === '/rest/v1/plans')!;
    expect(request.headers.apikey).toBe('server-secret');
    expect(request.url.searchParams.get('select')).toBe('code,name,file_storage_quota_bytes');
  });

  it('유효한 용량을 저장하고 감사 이벤트를 남긴다', async () => {
    const updated = { code: 'BASIC', name: '베이직', file_storage_quota_bytes: 5368709120 };
    const { calls } = setup(configured, call => {
      if (call.url.pathname === '/rest/v1/plans') return { body: [updated] };
      if (call.url.pathname === '/rest/v1/audit_events') return { status: 201, body: null };
      return { status: 200, body: null };
    });
    const response = await app.inject({ method: 'PATCH', url: '/api/v1/admin/plans/BASIC/storage-quota', headers: { authorization: 'Bearer admin' }, payload: { quota_bytes: 5368709120 } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ plan_code: 'BASIC', plan_name: '베이직', quota_bytes: 5368709120 });
    const update = calls.find(call => call.url.pathname === '/rest/v1/plans' && call.method === 'PATCH')!;
    expect(update.body).toEqual({ file_storage_quota_bytes: 5368709120 });
    const audit = calls.find(call => call.url.pathname === '/rest/v1/audit_events')!;
    expect(audit.body).toMatchObject({ action: 'plan.file_storage_quota_update', target_type: 'plan', target_id: 'BASIC', organization_id: null });
  });

  it('null로 저장하면 플랜 상한을 비우고 조직별 한도로 되돌린다', async () => {
    const { calls } = setup(configured, call => {
      if (call.url.pathname === '/rest/v1/plans') return { body: [{ code: 'BASIC', name: '베이직', file_storage_quota_bytes: null }] };
      if (call.url.pathname === '/rest/v1/audit_events') return { status: 201, body: null };
      return { status: 200, body: null };
    });
    const response = await app.inject({ method: 'PATCH', url: '/api/v1/admin/plans/BASIC/storage-quota', headers: { authorization: 'Bearer admin' }, payload: { quota_bytes: null } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ plan_code: 'BASIC', quota_bytes: null });
    expect(calls.find(call => call.url.pathname === '/rest/v1/plans' && call.method === 'PATCH')?.body).toEqual({ file_storage_quota_bytes: null });
  });

  it('일반 구성원은 변경 API에서 거부한다', async () => {
    const { calls } = setup();
    const response = await app.inject({ method: 'PATCH', url: '/api/v1/admin/plans/BASIC/storage-quota', headers: { authorization: 'Bearer user' }, payload: { quota_bytes: 5368709120 } });
    expect(response.statusCode).toBe(403);
    expect(calls.some(call => call.url.pathname === '/rest/v1/plans' && call.method === 'PATCH')).toBe(false);
  });

  it.each([-1, 1099511627777, 2.5, '5'])('잘못된 용량 %s는 DB 변경 전에 422로 거부한다', async quota => {
    const { calls } = setup();
    const response = await app.inject({ method: 'PATCH', url: '/api/v1/admin/plans/BASIC/storage-quota', headers: { authorization: 'Bearer admin' }, payload: { quota_bytes: quota } });
    expect(response.statusCode).toBe(422);
    expect(calls.some(call => call.url.pathname === '/rest/v1/plans' && call.method === 'PATCH')).toBe(false);
  });
});
