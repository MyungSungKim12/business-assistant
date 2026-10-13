import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { rateLimitMessage } from '../app/useSessionFlow';
import type { ConnectionState, Platform, RefreshTokenStore } from '../platform/types';
import { ApiClient } from './client';
import type { HttpRequest, HttpResponse } from './transport';

const json = (status: number, body: unknown): HttpResponse => ({ status, body: JSON.stringify(body), headers: {} });

function memoryTokenStore(initial: string | null): RefreshTokenStore & { value: string | null } {
  return { value: initial, async load() { return this.value; }, async save(value) { this.value = value; }, async clear() { this.value = null; } };
}

function platformWith(handler: (request: HttpRequest) => HttpResponse, tokenStore: RefreshTokenStore): Platform {
  return {
    kind: 'browser', apiBase: '/api/v1', tokenStore,
    request: async (request) => handler(request),
    async uploadBinary() {}, async downloadBinary() { return new Uint8Array(); },
    subscribeConnection(listener: (state: ConnectionState) => void) { listener('online'); return () => undefined; },
  };
}

describe('restoreSession', () => {
  it('keeps the saved refresh token on temporary failures so the next launch can retry', async () => {
    for (const status of [429, 503]) {
      const store = memoryTokenStore('refresh-1');
      const client = new ApiClient(platformWith(() => json(status, { detail: 'busy' }), store));
      await expect(client.restoreSession()).resolves.toEqual({ authenticated: false });
      expect(store.value).toBe('refresh-1');
    }
  });

  it('clears the token when the server rejects it', async () => {
    for (const status of [401, 403]) {
      const store = memoryTokenStore('refresh-1');
      const client = new ApiClient(platformWith(() => json(status, { detail: 'Invalid credentials' }), store));
      await expect(client.restoreSession()).resolves.toEqual({ authenticated: false });
      expect(store.value).toBeNull();
    }
  });
});

describe('admin API routing', () => {
  it('sends /admin/ paths to the admin scope and everything else to the main API', async () => {
    const seen: HttpRequest[] = [];
    const client = new ApiClient(platformWith((request) => {
      seen.push(request);
      if (request.path === '/auth/login') return json(200, { access_token: 'a', refresh_token: 'r', user: { user_id: '11111111-1111-4111-8111-111111111111', email: 'o@example.com', display_name: null } });
      return json(200, { ok: true });
    }, memoryTokenStore(null)));
    await client.login('o@example.com', 'secret-password');
    const schema = z.object({ ok: z.boolean() });
    await client.call('GET', '/organizations/x/tasks', schema);
    await client.call('POST', '/admin/organizations/x/subscription', schema, {});
    expect(seen.find((request) => request.path === '/organizations/x/tasks')?.scope).toBeUndefined();
    expect(seen.find((request) => request.path.startsWith('/admin/'))?.scope).toBe('admin');
  });
});

describe('rateLimitMessage', () => {
  it('shows the server guidance for 429 only', () => {
    expect(rateLimitMessage({ status: 429, message: '30초 후 다시 시도해 주세요.' })).toBe('30초 후 다시 시도해 주세요.');
    expect(rateLimitMessage({ status: 429, message: '' })).toContain('잠시 후');
    expect(rateLimitMessage({ status: 401, message: 'x' })).toBeNull();
    expect(rateLimitMessage(undefined)).toBeNull();
    vi.fn();
  });
});
