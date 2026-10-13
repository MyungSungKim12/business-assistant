import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, fakeFetch, testConfig } from '../catalog/testkit.js';
import { registerAdminModule } from './index.js';

const ADMIN_ID = '12345678-1234-4678-9234-567812345678';
const USER_ID = '87654321-4321-4765-8321-876543218765';
const tokens: Record<string, string> = { admin: ADMIN_ID, user: USER_ID };

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

function setup(serviceKey?: string) {
  const { fetcher, calls } = fakeFetch((call) => {
    const id = tokens[String(call.headers.Authorization).replace('Bearer ', '')];
    return id ? { body: { id } } : { status: 401, body: { message: 'bad jwt' } };
  });
  const config = { ...testConfig, APP_PLATFORM_ADMIN_USER_IDS: ADMIN_ID, ...(serviceKey ? { APP_SUPABASE_SERVICE_KEY: serviceKey } : {}) };
  app = buildApp((instance) => registerAdminModule(instance, undefined, config, fetcher));
  const get = (token: string | null) => app.inject({ method: 'GET', url: '/api/v1/admin/me', headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { get, calls };
}

describe('GET /api/v1/admin/me', () => {
  it('플랫폼 관리자는 true, 일반 사용자는 false 이고 서비스 키를 쓰지 않는다', async () => {
    const { get, calls } = setup('server-secret');
    expect((await get('admin')).json()).toEqual({ platform_admin: true });
    expect((await get('user')).json()).toEqual({ platform_admin: false });
    expect(calls.some((call) => call.headers.apikey === 'server-secret')).toBe(false);
  });

  it('인증이 없거나 잘못되면 401', async () => {
    const { get } = setup('server-secret');
    expect((await get(null)).statusCode).toBe(401);
    expect((await get('unknown')).statusCode).toBe(401);
  });

  it('서비스 키가 없어도 판정은 가능하다', async () => {
    const { get } = setup();
    expect((await get('admin')).json()).toEqual({ platform_admin: true });
  });
});
