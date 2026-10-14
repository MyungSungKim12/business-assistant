import { describe, expect, it } from 'vitest';

import { ApiClient } from './client';
import { ApiError } from './errors';
import type { ConnectionState, Platform, RefreshTokenStore } from '../platform/types';
import type { HttpRequest, HttpResponse } from './transport';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const session = (access = 'access-1', refresh = 'refresh-1') => ({
  access_token: access,
  refresh_token: refresh,
  user: { user_id: USER_ID, email: 'owner@example.com', display_name: '김원장' },
});
const json = (status: number, body: unknown): HttpResponse => ({ status, body: JSON.stringify(body), headers: {} });

function memoryTokenStore(initial: string | null = null): RefreshTokenStore & { value: string | null } {
  return {
    value: initial,
    async load() { return this.value; },
    async save(value) { this.value = value; },
    async clear() { this.value = null; },
  };
}

function platform(handler: (request: HttpRequest) => Promise<HttpResponse>, tokenStore = memoryTokenStore()): Platform {
  let state: ConnectionState = 'checking';
  const listeners = new Set<(value: ConnectionState) => void>();
  return {
    kind: 'browser', apiBase: '/api/v1', tokenStore,
    request: async (request) => {
      state = 'checking'; listeners.forEach((listener) => listener(state));
      try { const response = await handler(request); state = 'online'; listeners.forEach((listener) => listener(state)); return response; }
      catch (error) { state = 'offline'; listeners.forEach((listener) => listener(state)); throw error; }
    },
    async uploadBinary() {}, async downloadBinary() { return new Uint8Array(); },
    subscribeConnection(listener) { listeners.add(listener); listener(state); return () => { listeners.delete(listener); }; },
  };
}

describe('ApiClient', () => {
  it('validates login and stores only the refresh token', async () => {
    const tokens = memoryTokenStore();
    const requests: HttpRequest[] = [];
    const api = new ApiClient(platform(async (request) => { requests.push(request); return json(200, session()); }, tokens));

    const result = await api.login('owner@example.com', 'password');

    expect(result.user.display_name).toBe('김원장');
    expect(tokens.value).toBe('refresh-1');
    expect(requests[0]).toMatchObject({ method: 'POST', path: '/auth/login' });
    expect(JSON.parse(requests[0].body ?? '{}')).toEqual({ email: 'owner@example.com', password: 'password' });
  });

  it('lists audit events with filters and validates the cursor page response', async () => {
    const requests: HttpRequest[] = [];
    const api = new ApiClient(platform(async (request) => {
      requests.push(request);
      if (request.path === '/auth/login') return json(200, session());
      return json(200, { items: [{ id: '33333333-3333-4333-8333-333333333333', organization_id: ORG_ID,
        actor_id: USER_ID, action: 'customer.delete', target_type: 'customer', target_id: '44444444-4444-4444-8444-444444444444',
        metadata: { archived: true }, request_id: 'request-1', ip: null, source: 'api_user', created_at: '2026-10-14T01:00:00Z' }], next_cursor: null });
    }));
    await api.login('owner@example.com', 'password');

    const result = await api.listAuditEvents(ORG_ID, { from: '2026-10-01T00:00:00+09:00', action: 'customer.delete', limit: 25 });

    expect(result.items).toHaveLength(1);
    expect(requests[1].path).toContain(`/organizations/${ORG_ID}/audit-events?`);
    expect(new URLSearchParams(requests[1].path.split('?')[1])).toEqual(new URLSearchParams({ from: '2026-10-01T00:00:00+09:00', action: 'customer.delete', limit: '25' }));
    expect(requests[1].headers.Authorization).toBe('Bearer access-1');
  });

  it('refreshes concurrent unauthorized requests once and retries with the new bearer token', async () => {
    let refreshes = 0;
    let protectedCalls = 0;
    const api = new ApiClient(platform(async (request) => {
      if (request.path === '/auth/login') return json(200, session());
      if (request.path === '/auth/refresh') { refreshes += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return json(200, session('access-2', 'refresh-2')); }
      protectedCalls += 1;
      if (request.headers.Authorization === 'Bearer access-1') return json(401, { detail: 'expired' });
      expect(request.headers.Authorization).toBe('Bearer access-2');
      return json(200, [{ id: ORG_ID, name: '뷰티샵', slug: 'beauty', role: 'owner' }]);
    }));
    await api.login('owner@example.com', 'password');

    await Promise.all([api.listOrganizations(), api.listOrganizations()]);

    expect(refreshes).toBe(1);
    expect(protectedCalls).toBe(4);
  });

  it('clears a rejected refresh token and returns to login', async () => {
    const tokens = memoryTokenStore('expired-refresh');
    const api = new ApiClient(platform(async () => json(401, { detail: 'Invalid credentials' }), tokens));

    await expect(api.restoreSession()).resolves.toEqual({ authenticated: false });
    expect(tokens.value).toBeNull();
  });

  it('does not call refresh when no stored token exists', async () => {
    let calls = 0;
    const api = new ApiClient(platform(async () => { calls += 1; return json(500, {}); }));
    await expect(api.restoreSession()).resolves.toEqual({ authenticated: false });
    expect(calls).toBe(0);
  });

  it.each([[403, false], [503, true]] as const)('normalizes HTTP %s retryability', async (status, retryable) => {
    const api = new ApiClient(platform(async (request) => request.path === '/auth/login' ? json(200, session()) : json(status, { detail: 'denied' })));
    await api.login('owner@example.com', 'password');
    const error = await api.listOrganizations().catch((value) => value);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, retryable });
  });

  it('rejects invalid JSON contracts', async () => {
    const api = new ApiClient(platform(async () => json(200, { access_token: 3 })));
    await expect(api.login('owner@example.com', 'password')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('reports checking, online and offline connection states', async () => {
    let fail = false;
    const p = platform(async () => { if (fail) throw new Error('offline'); return json(200, session()); });
    const states: ConnectionState[] = [];
    p.subscribeConnection(states.push.bind(states));
    const api = new ApiClient(p);
    await api.login('owner@example.com', 'password');
    fail = true;
    await api.login('owner@example.com', 'password').catch(() => undefined);
    expect(states).toEqual(['checking', 'checking', 'online', 'checking', 'offline']);
  });
});
