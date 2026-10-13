import { describe, expect, it } from 'vitest';
import type { ConnectionState, Platform, RefreshTokenStore } from '../platform/types';
import { ApiClient } from './client';
import type { HttpRequest, HttpResponse } from './transport';

const json = (status: number, body: unknown): HttpResponse => ({ status, body: JSON.stringify(body), headers: {} });
const session = { access_token: 'access-1', refresh_token: 'refresh-1', user: { user_id: '00000000-0000-4000-8000-000000000001', email: 'a@example.com', display_name: null } };

function setup(adminReply: (request: HttpRequest) => HttpResponse) {
  const requests: HttpRequest[] = [];
  let token: string | null = null;
  const tokenStore: RefreshTokenStore = { async load() { return token; }, async save(value) { token = value; }, async clear() { token = null; } };
  const platform: Platform = {
    kind: 'browser', apiBase: '/api/v1', tokenStore,
    request: async (request) => {
      requests.push(request);
      if (request.path === '/auth/login') return json(200, session);
      return adminReply(request);
    },
    async uploadBinary() {}, async downloadBinary() { return new Uint8Array(); },
    subscribeConnection(listener: (state: ConnectionState) => void) { listener('online'); return () => undefined; },
  };
  const client = new ApiClient(platform);
  const adminCalls = () => requests.filter((request) => request.path === '/admin/me');
  return { client, adminCalls, requests };
}

describe('ApiClient.isPlatformAdmin', () => {
  it('관리자 API 범위로 /admin/me 를 호출하고 결과를 세션 동안 재사용한다', async () => {
    const { client, adminCalls } = setup(() => json(200, { platform_admin: true }));
    await client.login('a@example.com', 'pw');
    expect(await client.isPlatformAdmin()).toBe(true);
    expect(await client.isPlatformAdmin()).toBe(true);
    expect(adminCalls()).toHaveLength(1);
    expect(adminCalls()[0]).toMatchObject({ method: 'GET', scope: 'admin' });
    expect(adminCalls()[0].headers.Authorization).toBe('Bearer access-1');
  });

  it('false 도 캐시한다', async () => {
    const { client, adminCalls } = setup(() => json(200, { platform_admin: false }));
    await client.login('a@example.com', 'pw');
    expect(await client.isPlatformAdmin()).toBe(false);
    expect(await client.isPlatformAdmin()).toBe(false);
    expect(adminCalls()).toHaveLength(1);
  });

  it('호출 실패·미설정은 false 이고 저장하지 않아 다음에 다시 시도한다', async () => {
    let configured = false;
    const { client, adminCalls } = setup(() => (configured ? json(200, { platform_admin: true }) : json(404, { detail: 'Not found' })));
    await client.login('a@example.com', 'pw');
    expect(await client.isPlatformAdmin()).toBe(false);
    configured = true;
    expect(await client.isPlatformAdmin()).toBe(true);
    expect(adminCalls()).toHaveLength(2);
  });

  it('형식이 다른 응답은 false', async () => {
    const { client } = setup(() => json(200, { platform_admin: 'yes' }));
    await client.login('a@example.com', 'pw');
    expect(await client.isPlatformAdmin()).toBe(false);
  });

  it('로그아웃하거나 다시 로그인하면 다시 확인한다', async () => {
    const { client, adminCalls } = setup(() => json(200, { platform_admin: true }));
    await client.login('a@example.com', 'pw');
    await client.isPlatformAdmin();
    await client.logout();
    await client.login('b@example.com', 'pw');
    await client.isPlatformAdmin();
    expect(adminCalls()).toHaveLength(2);
  });
});
