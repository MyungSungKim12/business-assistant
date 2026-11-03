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
      // Logout is now an explicit Auth request; business-race handlers below count only their original routes.
      if(request.path==='/auth/logout')return json(200,{logged_out:true});
      state = 'checking'; listeners.forEach((listener) => listener(state));
      try { const response = await handler(request); state = 'online'; listeners.forEach((listener) => listener(state)); return response; }
      catch (error) { state = 'offline'; listeners.forEach((listener) => listener(state)); throw error; }
    },
    async uploadBinary() {}, async downloadBinary() { return new Uint8Array(); },
    subscribeConnection(listener) { listeners.add(listener); listener(state); return () => { listeners.delete(listener); }; },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('ApiClient session lifecycle isolation (SEC-14)', () => {
  it('rejects a late refresh after logout without persisting tokens or retrying the original request', async () => {
    const tokens = memoryTokenStore(); const refresh = deferred<HttpResponse>(); const started = deferred<void>();
    let protectedCalls = 0;
    const api = new ApiClient(platform(async request => {
      if (request.path === '/auth/login') return json(200, session());
      if (request.path === '/auth/refresh') { started.resolve(); return refresh.promise; }
      protectedCalls++; return protectedCalls === 1 ? json(401, {}) : json(200, []);
    }, tokens));
    await api.login('owner@example.com', 'password');
    const pending = api.listOrganizations().catch(error => error);
    await started.promise; await api.logout(); refresh.resolve(json(200, session('late', 'late-refresh')));
    expect(await pending).toMatchObject({ code: 'SESSION_CHANGED', retryable: false });
    expect(tokens.value).toBeNull(); expect(protectedCalls).toBe(1);
  });

  it.each([200, 401, 503])('does not overwrite or clear a new account after an old refresh returns HTTP %s', async status => {
    const tokens = memoryTokenStore(); const refresh = deferred<HttpResponse>(); const started = deferred<void>();
    let logins = 0; let oldCalls = 0;
    const api = new ApiClient(platform(async request => {
      if (request.path === '/auth/login') return json(200, ++logins === 1 ? session() : session('new-account', 'new-refresh'));
      if (request.path === '/auth/refresh') { started.resolve(); return refresh.promise; }
      if (request.headers.Authorization === 'Bearer access-1') { oldCalls++; return json(401, {}); }
      expect(request.headers.Authorization).toBe('Bearer new-account'); return json(200, []);
    }, tokens));
    await api.login('owner@example.com', 'password');
    const pending = api.listOrganizations().catch(error => error); await started.promise;
    await api.logout(); await api.login('other@example.com', 'password');
    refresh.resolve(status === 200 ? json(200, session('old-account', 'old-refresh')) : json(status, {}));
    expect(await pending).toMatchObject({ code: 'SESSION_CHANGED' });
    expect(tokens.value).toBe('new-refresh'); expect(oldCalls).toBe(1);
    await expect(api.listOrganizations()).resolves.toEqual([]);
  });

  it('does not accept a login response that arrives after logout', async () => {
    const tokens = memoryTokenStore(); const response = deferred<HttpResponse>(); const started = deferred<void>();
    const api = new ApiClient(platform(async () => { started.resolve(); return response.promise; }, tokens));
    const pending = api.login('owner@example.com', 'password').catch(error => error);
    await started.promise; await api.logout(); response.resolve(json(200, session()));
    expect(await pending).toMatchObject({ code: 'SESSION_CHANGED' }); expect(tokens.value).toBeNull();
  });

  it('rejects a previous-account successful data response after switching accounts', async () => {
    const tokens = memoryTokenStore(); const response = deferred<HttpResponse>(); let logins = 0;
    const api = new ApiClient(platform(async request => request.path === '/auth/login' ? json(200, ++logins === 1 ? session() : session('new', 'new-refresh')) : response.promise, tokens));
    await api.login('owner@example.com', 'password');
    const pending = api.listOrganizations().catch(error => error);
    await api.login('other@example.com', 'password'); response.resolve(json(200, [{ id: ORG_ID, name: '이전 계정 매장', slug: 'old', role: 'owner' }]));
    expect(await pending).toMatchObject({ code: 'SESSION_CHANGED' }); expect(tokens.value).toBe('new-refresh');
  });

  it('does not refresh or replay a void mutation whose 401 response arrives after logout', async () => {
    const tokens = memoryTokenStore(); const response = deferred<HttpResponse>(); let calls = 0; const started = deferred<void>();
    const api = new ApiClient(platform(async request => {
      if (request.path === '/auth/login') return json(200, session());
      calls++; started.resolve(); return response.promise;
    }, tokens));
    await api.login('owner@example.com', 'password');
    const pending = api.callVoid('DELETE', '/audit-only-fake-path').catch(error => error);
    await started.promise; await api.logout(); response.resolve(json(401, {}));
    expect(await pending).toMatchObject({ code: 'SESSION_CHANGED' }); expect(calls).toBe(1);
  });

  it('serializes logout behind a token save already in progress', async () => {
    const tokens = memoryTokenStore(); const entered = deferred<void>(); const finish = deferred<void>();
    tokens.save = async value => { entered.resolve(); await finish.promise; tokens.value = value; };
    const api = new ApiClient(platform(async () => json(200, session()), tokens));
    const login = api.login('owner@example.com', 'password').catch(error => error);
    await entered.promise;
    const logout = api.logout(); finish.resolve();
    await logout;
    expect(await login).toMatchObject({ code: 'SESSION_CHANGED' }); expect(tokens.value).toBeNull();
  });

  it('does not use a token loaded for an earlier restore attempt after a new account logs in', async () => {
    const tokens = memoryTokenStore('old-refresh'); const loaded = deferred<string | null>(); const started = deferred<void>();
    tokens.load = async () => { started.resolve(); return loaded.promise; };
    let refreshes = 0;
    const api = new ApiClient(platform(async request => {
      if (request.path === '/auth/login') return json(200, session('new', 'new-refresh'));
      if (request.path === '/auth/refresh') { refreshes++; return json(200, session('old', 'old-refresh')); }
      expect(request.headers.Authorization).toBe('Bearer new'); return json(200, []);
    }, tokens));
    const restore = api.restoreSession(); await started.promise;
    await api.login('other@example.com', 'password'); loaded.resolve('old-refresh');
    await expect(restore).resolves.toEqual({ authenticated: false });
    expect(refreshes).toBe(0); expect(tokens.value).toBe('new-refresh');
    await expect(api.listOrganizations()).resolves.toEqual([]);
  });

  it('shares startup restoration without rotating the same saved token twice', async () => {
    const tokens = memoryTokenStore('saved-refresh'); const response = deferred<HttpResponse>(); const started = deferred<void>(); let refreshes = 0;
    const api = new ApiClient(platform(async () => { refreshes++; started.resolve(); return response.promise; }, tokens));
    const first = api.restoreSession(), second = api.restoreSession(); await started.promise;
    response.resolve(json(200, session()));
    const results = await Promise.all([first, second]);
    expect(results.every(row => row.authenticated)).toBe(true); expect(refreshes).toBe(1);
  });

  it('rejects a late signup response without saving its session after logout', async () => {
    const tokens = memoryTokenStore(); const response = deferred<HttpResponse>(); const started = deferred<void>();
    const api = new ApiClient(platform(async () => { started.resolve(); return response.promise; }, tokens));
    const pending = api.signUp('new@example.com', 'password', '사용자').catch(error => error);
    await started.promise; await api.logout(); response.resolve(json(200, { ...session(), email_confirmation_required: false }));
    expect(await pending).toMatchObject({ code: 'SESSION_CHANGED' }); expect(tokens.value).toBeNull();
  });

  it('keeps a temporarily unavailable refresh token for the next restore attempt', async () => {
    const tokens = memoryTokenStore('saved-refresh');
    const api = new ApiClient(platform(async () => json(503, { detail: 'unavailable' }), tokens));
    await expect(api.restoreSession()).resolves.toEqual({ authenticated: false });
    expect(tokens.value).toBe('saved-refresh');
  });

  it('allows logout after a failed token save and does not retain an authenticated client', async () => {
    const tokens = memoryTokenStore(); tokens.save = async () => { throw new Error('keyring unavailable'); };
    const api = new ApiClient(platform(async () => json(200, session()), tokens));
    await expect(api.login('owner@example.com', 'password')).rejects.toThrow('keyring unavailable');
    await expect(api.logout()).resolves.toBeUndefined();
    await expect(api.listOrganizations()).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' }); expect(tokens.value).toBeNull();
  });
});

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

  it('reads task people and sends task fields (assignee, recurrence, customer) with the real client', async () => {
    const requests: HttpRequest[] = [];
    const task = { id: '55555555-5555-4555-8555-555555555555', organization_id: ORG_ID, created_by: USER_ID, title: '청소', description: '', due_at: null, status: 'open', priority: 'normal' };
    const api = new ApiClient(platform(async (request) => {
      requests.push(request);
      if (request.path === '/auth/login') return json(200, session());
      if (request.path.endsWith('/task-people')) return json(200, [{ user_id: USER_ID, name: '김담당' }]);
      return json(200, { ...task, assignee_id: USER_ID, completed_by: USER_ID, completed_by_name: '김담당', completed_at: '2026-10-14T06:00:00Z' });
    }));
    await api.login('owner@example.com', 'password');

    expect(await api.listTaskPeople(ORG_ID)).toEqual([{ user_id: USER_ID, name: '김담당' }]);
    expect(requests[1]).toMatchObject({ method: 'GET', path: `/organizations/${ORG_ID}/task-people` });
    const saved = await api.updateTask(ORG_ID, task.id, { assignee_id: USER_ID, recurrence: 'weekly', customer_id: null });
    expect(JSON.parse(requests[2].body ?? '{}')).toEqual({ assignee_id: USER_ID, recurrence: 'weekly', customer_id: null });
    expect(saved).toMatchObject({ assignee_id: USER_ID, completed_by_name: '김담당' });
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

describe('ApiClient customer photo trash (CRM-15)', () => {
  it('lists the trash and restores a photo with the real client', async () => {
    const photoId = '33333333-3333-4333-8333-333333333333';
    const photo = { id: photoId, organization_id: ORG_ID, customer_id: USER_ID, original_name: 'a.jpg', storage_path: 'p', content_type: 'image/jpeg', size_bytes: 10, caption: '', created_at: '2026-10-13T00:00:00Z' };
    const requests: HttpRequest[] = [];
    const api = new ApiClient(platform(async (request) => {
      requests.push(request);
      if (request.path === '/auth/login') return json(200, session());
      if (request.path.endsWith('/photos/trash')) return json(200, [{ ...photo, archived_at: '2026-10-14T01:00:00Z', archived_by_name: '원장' }]);
      return json(200, photo);
    }));
    await api.login('owner@example.com', 'password');
    const trash = await api.listTrashedPhotos(ORG_ID, USER_ID);
    expect(trash[0]).toMatchObject({ id: photoId, archived_by_name: '원장' });
    expect(requests[1]).toMatchObject({ method: 'GET', path: `/organizations/${ORG_ID}/customers/${USER_ID}/photos/trash` });
    const restored = await api.restoreCustomerPhoto(ORG_ID, USER_ID, photoId);
    expect(restored.id).toBe(photoId);
    expect(requests[2]).toMatchObject({ method: 'POST', path: `/organizations/${ORG_ID}/customers/${USER_ID}/photos/${photoId}/restore` });
  });
});
