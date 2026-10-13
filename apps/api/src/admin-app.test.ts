import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createAdminApp } from './admin-app.js';
import { createApp } from './app.js';
import { parseAdminConfig } from './config.js';
import { fakeFetch, ORG, type FakeCall, type FakeReply } from './modules/catalog/testkit.js';

const ADMIN_ID = '12345678-1234-4678-9234-567812345678';
const USER_ID = '87654321-4321-4765-8321-876543218765';
const config = parseAdminConfig({
  APP_SUPABASE_URL: 'https://example.supabase.co', APP_SUPABASE_PUBLISHABLE_KEY: 'public-key', APP_SUPABASE_SERVICE_KEY: 'server-secret',
  APP_PLATFORM_ADMIN_USER_IDS: ADMIN_ID, APP_LOG_LEVEL: 'silent',
});
const tokens: Record<string, string> = { admin: ADMIN_ID, user: USER_ID };
const body = { plan_code: 'BASIC', status: 'active', starts_at: '2026-09-16T00:00:00Z', ends_at: null };

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

function setup(audit: (call: FakeCall) => FakeReply = () => ({ status: 201, body: null })) {
  const { fetcher, calls } = fakeFetch((call) => {
    if (call.url.pathname === '/auth/v1/user') {
      const id = tokens[String(call.headers.Authorization).replace('Bearer ', '')];
      return id ? { body: { id } } : { status: 401, body: { message: 'bad jwt' } };
    }
    if (call.url.pathname === '/rest/v1/audit_events') return audit(call);
    return { body: { plan_code: (call.body as { target_plan_code: string }).target_plan_code } };
  });
  app = createAdminApp(config, fetcher);
  const post = (token: string) => app.inject({ method: 'POST', url: `/api/v1/admin/organizations/${ORG}/subscription`, headers: { authorization: `Bearer ${token}` }, payload: body, remoteAddress: '10.1.2.3' });
  return { post, calls };
}

describe('관리자 API 서버(별도 진입점)', () => {
  it('health 가 있고 구독 교체 경로는 같은 경로(/api/v1/admin/...)로 제공된다', async () => {
    const { post } = setup();
    expect((await app.inject({ url: '/api/v1/health' })).json()).toEqual({ status: 'ok' });
    expect((await post('admin')).statusCode).toBe(200);
  });

  it('일반 API 서버에는 관리자 경로가 없다(404)', async () => {
    const general = createApp({ config: { APP_SUPABASE_URL: 'https://example.supabase.co', APP_SUPABASE_PUBLISHABLE_KEY: 'public-key', APP_FILE_BUCKET: 'b', APP_API_PORT: 8000, APP_LOG_LEVEL: 'silent' } });
    expect((await general.inject({ method: 'POST', url: `/api/v1/admin/organizations/${ORG}/subscription`, headers: { authorization: 'Bearer admin' }, payload: body })).statusCode).toBe(404);
    await general.close();
  });

  it('플랫폼 관리자가 아니면 403 이고 서비스 키 호출과 감사 기록이 없다', async () => {
    const { post, calls } = setup();
    expect((await post('user')).statusCode).toBe(403);
    expect(calls.some((call) => call.headers.apikey === 'server-secret')).toBe(false);
  });

  it('구독 교체 성공 뒤 서비스 키로 감사 이벤트를 직접 기록한다(개인정보 없음)', async () => {
    const { post, calls } = setup();
    expect((await post('admin')).statusCode).toBe(200);
    const audit = calls.find((call) => call.url.pathname === '/rest/v1/audit_events')!;
    expect(audit.method).toBe('POST');
    expect(audit.headers.apikey).toBe('server-secret');
    expect(audit.body).toMatchObject({
      organization_id: ORG, actor_id: ADMIN_ID, action: 'subscription.replace', target_type: 'organization', target_id: ORG, source: 'service', ip: '10.1.2.3',
      metadata: { plan_code: 'BASIC', status: 'active', starts_at: '2026-09-16T00:00:00Z', ends_at: null },
    });
  });

  it('감사 기록이 실패해도 구독 교체 응답은 그대로다', async () => {
    const { post } = setup(() => ({ status: 500, body: { message: 'boom' } }));
    const response = await post('admin');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ plan_code: 'BASIC' });
  });
});
