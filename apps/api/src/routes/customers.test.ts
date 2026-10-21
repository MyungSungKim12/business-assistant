import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createCustomerGateway, customerSearchFilter, LEGACY_LIST_LIMIT, parseContentRangeTotal } from '../supabase/customers.js';
import { decodeCursor, encodeCursor } from './customers.js';

const organizationId = 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const customerId = 'c9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const customer = {
  id: customerId,
  organization_id: organizationId,
  name: '김고객',
  email: null,
  phone: '010-1234-5678',
  notes: '',
  birth_date: null,
  skin_type: null,
  concerns: [],
  allergies: '',
  last_visit_date: null,
  next_visit_date: null,
  tags: ['재방문'],
  status: 'active',
};

function fixture() {
  const accessCalls: boolean[] = [];
  const access = { requireAccess: async (token: string, id: string, feature: string, write = false) => {
    expect(token).toBe('access');
    expect(id).toBe(organizationId);
    expect(feature).toBe('crm.basic');
    accessCalls.push(write);
    return 'owner';
  } };
  const customers = {
    list: async () => [customer],
    create: async (_token: string, _organizationId: string, input: { name: string }) => ({ ...customer, ...input }),
    update: async (_token: string, _organizationId: string, id: string, patch: { name?: string }) => id === customerId ? { ...customer, ...patch } : null,
  };
  return { app: createApp({ organizations: access as never, customers }), accessCalls };
}

describe('customer HTTP flow', () => {
  it('lists customers only after checking the CRM feature for the requested organization', async () => {
    const { app, accessCalls } = fixture();
    const result = await app.inject({ url: `/api/v1/organizations/${organizationId}/customers`, headers: { authorization: 'Bearer access' } });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual([customer]);
    expect(accessCalls).toEqual([false]);
    await app.close();
  });

  it('creates a customer under the route organization and never accepts an organization id from the body', async () => {
    const { app, accessCalls } = fixture();
    const result = await app.inject({
      method: 'POST', url: `/api/v1/organizations/${organizationId}/customers`, headers: { authorization: 'Bearer access' },
      payload: { ...customer, id: 'd9cc39fd-8e8c-4df8-a623-1f23a3a936bd', organization_id: 'e9cc39fd-8e8c-4df8-a623-1f23a3a936bd' },
    });
    expect(result.statusCode).toBe(422);
    expect(result.json().detail).toBe('Invalid customer input');
    await app.close();
  });

  it('updates only a customer that belongs to the requested organization', async () => {
    const { app, accessCalls } = fixture();
    const result = await app.inject({
      method: 'PATCH', url: `/api/v1/organizations/${organizationId}/customers/${customerId}`, headers: { authorization: 'Bearer access' }, payload: { name: '김수정' },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ id: customerId, organization_id: organizationId, name: '김수정' });
    expect(accessCalls).toEqual([true]);
    await app.close();
  });

  it('blocks customer erasure until retention policy is approved and validates IDs', async () => {
    const { app, accessCalls } = fixture();
    const base = `/api/v1/organizations/${organizationId}/customers`;
    const blocked = await app.inject({ method: 'DELETE', url: `${base}/${customerId}`, headers: { authorization: 'Bearer access' } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().detail).toMatch(/linked records.*storage objects.*backups/i);
    expect(accessCalls.at(-1)).toBe(true);
    expect((await app.inject({ method: 'DELETE', url: `${base}/not-a-uuid`, headers: { authorization: 'Bearer access' } })).statusCode).toBe(422);
    await app.close();
  });
});

const secondaryId = 'd9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const operationId = 'e9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const auth = { authorization: 'Bearer access' };
const apiBase = `/api/v1/organizations/${organizationId}`;
const mergeResult = { primary: customer, secondary_id: secondaryId, moved: { appointments: 2, customer_photos: 1 } };

function toolsFixture(overrides: Record<string, unknown> = {}, audit?: unknown) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const record = (name: string, result: unknown) => async (_token: string, _organization: string, ...args: unknown[]) => { calls.push({ name, args }); return result; };
  const accessCalls: boolean[] = [];
  const access = { requireAccess: async (_token: string, _id: string, _feature: string, write = false) => { accessCalls.push(write); return 'owner'; } };
  const customers = {
    list: async () => [customer], create: async () => customer, update: async () => customer,
    search: record('search', { items: [customer], total: 120 }),
    listTags: record('listTags', [{ tag: '재방문', count: 3 }]),
    renameTag: record('renameTag', { updated: 2 }),
    mergeTags: record('mergeTags', { updated: 4 }),
    deleteTag: record('deleteTag', { updated: 1 }),
    duplicateGroups: record('duplicateGroups', []),
    merge: record('merge', mergeResult),
    ...overrides,
  };
  return { app: createApp({ organizations: access as never, customers: customers as never, ...(audit ? { audit: audit as never } : {}) }), calls, accessCalls };
}

describe('customer search route', () => {
  it('returns items, total and a cursor that continues after the returned page', async () => {
    const { app, calls } = toolsFixture();
    const first = await app.inject({ url: `${apiBase}/customers/search?q=%EA%B9%80&status=all&sort=created_at&limit=50`, headers: auth });
    expect(first.statusCode).toBe(200);
    const body = first.json() as { items: unknown[]; total: number; next_cursor: string | null };
    expect(body.total).toBe(120);
    expect(body.items).toEqual([customer]);
    expect(body.next_cursor).toEqual(expect.any(String));
    expect(calls[0]!.args[0]).toMatchObject({ q: '김', status: 'all', sort: 'created_at', direction: 'desc', limit: 50, offset: 0 });
    await app.inject({ url: `${apiBase}/customers/search?cursor=${body.next_cursor}`, headers: auth });
    expect(calls[1]!.args[0]).toMatchObject({ offset: 1, status: 'active', sort: 'name', direction: 'asc', limit: 50 });
    await app.close();
  });

  it('ends paging with a null cursor and rejects malformed input', async () => {
    const { app } = toolsFixture({ search: async () => ({ items: [customer], total: 1 }) });
    expect((await app.inject({ url: `${apiBase}/customers/search`, headers: auth })).json()).toMatchObject({ total: 1, next_cursor: null });
    for (const query of ['limit=0', 'limit=201', 'status=bogus', 'sort=password', 'cursor=not-a-cursor', `q=${'a'.repeat(101)}`]) {
      expect((await app.inject({ url: `${apiBase}/customers/search?${query}`, headers: auth })).statusCode, query).toBe(422);
    }
    await app.close();
  });

  it('answers 503 when the gateway has no search support and requires a bearer token', async () => {
    const { app } = toolsFixture({ search: undefined });
    expect((await app.inject({ url: `${apiBase}/customers/search`, headers: auth })).statusCode).toBe(503);
    expect((await app.inject({ url: `${apiBase}/customers/search` })).statusCode).toBe(401);
    await app.close();
  });
});

describe('customer tag routes', () => {
  it('lists, renames, merges and deletes tags through the gateway as write operations', async () => {
    const { app, calls, accessCalls } = toolsFixture();
    expect((await app.inject({ url: `${apiBase}/customer-tags`, headers: auth })).json()).toEqual([{ tag: '재방문', count: 3 }]);
    expect((await app.inject({ method: 'POST', url: `${apiBase}/customer-tags/rename`, headers: auth, payload: { from: ' 재방문 ', to: '단골' } })).json()).toEqual({ updated: 2 });
    expect((await app.inject({ method: 'POST', url: `${apiBase}/customer-tags/merge`, headers: auth, payload: { from: ['a', 'b'], to: 'c' } })).json()).toEqual({ updated: 4 });
    expect((await app.inject({ method: 'POST', url: `${apiBase}/customer-tags/delete`, headers: auth, payload: { tag: '단골' } })).json()).toEqual({ updated: 1 });
    expect(calls.find((call) => call.name === 'renameTag')!.args).toEqual(['재방문', '단골']);
    expect(accessCalls).toEqual([false, true, true, true]);
    await app.close();
  });

  it('rejects invalid tag bodies and unknown keys', async () => {
    const { app } = toolsFixture();
    const bad: Array<[string, object]> = [['rename', { from: '', to: 'x' }], ['rename', { from: 'a', to: 'b', extra: 1 }], ['merge', { from: [], to: 'x' }], ['delete', { tag: 'x'.repeat(51) }]];
    for (const [path, payload] of bad) {
      expect((await app.inject({ method: 'POST', url: `${apiBase}/customer-tags/${path}`, headers: auth, payload })).statusCode, path).toBe(422);
    }
    await app.close();
  });
});

describe('customer merge route', () => {
  it('merges the secondary into the customer in the path as a write operation', async () => {
    const { app, calls, accessCalls } = toolsFixture();
    const payload = { secondary_id: secondaryId, operation_id: operationId, resolved: { name: '김대표', notes: '합친 메모', tags: ['a'] } };
    const result = await app.inject({ method: 'POST', url: `${apiBase}/customers/${customerId}/merge`, headers: auth, payload });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ secondary_id: secondaryId, moved: { appointments: 2 } });
    expect(calls[0]!.args).toEqual([customerId, { secondaryId, operationId, resolved: payload.resolved }]);
    expect(accessCalls).toEqual([true]);
    await app.close();
  });

  it('rejects merging a customer into itself, bad ids and unknown fields', async () => {
    const { app } = toolsFixture();
    const url = `${apiBase}/customers/${customerId}/merge`;
    const bad = [
      { secondary_id: customerId, operation_id: operationId },
      { secondary_id: 'nope', operation_id: operationId },
      { secondary_id: secondaryId },
      { secondary_id: secondaryId, operation_id: operationId, resolved: { organization_id: organizationId } },
    ];
    for (const payload of bad) expect((await app.inject({ method: 'POST', url, headers: auth, payload })).statusCode).toBe(422);
    await app.close();
  });

  it('records an audit event without personal data', async () => {
    const events: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
    const audit = { record: async (_token: string, event: { action: string; metadata?: Record<string, unknown> }) => { events.push(event); }, recordRequired: async () => undefined };
    const { app } = toolsFixture({}, audit);
    await app.inject({ method: 'POST', url: `${apiBase}/customers/${customerId}/merge`, headers: auth, payload: { secondary_id: secondaryId, operation_id: operationId } });
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'customer.merge', metadata: { secondary_id: secondaryId, moved_total: 3 } })]));
    await app.close();
  });
});

describe('customer gateway search', () => {
  const config = { APP_SUPABASE_URL: 'https://example.supabase.co', APP_SUPABASE_PUBLISHABLE_KEY: 'pk' } as never;

  it('builds a PostgREST query with filters, order and exact count and reads the total from Content-Range', async () => {
    const seen: Array<{ url: URL; headers: Record<string, string> }> = [];
    const fetcher = (async (input: URL, init: { headers: Record<string, string> }) => {
      seen.push({ url: input, headers: init.headers });
      return new Response(JSON.stringify([customer]), { status: 200, headers: { 'content-range': '50-99/412' } });
    }) as never;
    const gateway = createCustomerGateway(config, fetcher);
    const result = await gateway.search('t', organizationId, { q: '010-1234', status: 'active', sort: 'last_visit_date', direction: 'desc', limit: 50, offset: 50 });
    expect(result).toEqual({ items: [customer], total: 412 });
    const params = seen[0]!.url.searchParams;
    expect(params.get('organization_id')).toBe(`eq.${organizationId}`);
    expect(params.get('status')).toBe('eq.active');
    expect(params.get('order')).toBe('last_visit_date.desc.nullslast,id.asc');
    expect(params.get('limit')).toBe('50');
    expect(params.get('offset')).toBe('50');
    expect(params.get('or')).toContain('phone.ilike."*0*1*0*1*2*3*4*"');
    expect(seen[0]!.headers.Prefer).toBe('count=exact');
  });

  it('caps the legacy full list at the server limit', async () => {
    let limit = '';
    const fetcher = (async (input: URL) => { limit = input.searchParams.get('limit') ?? ''; return new Response('[]', { status: 200 }); }) as never;
    await createCustomerGateway(config, fetcher).list('t', organizationId);
    expect(limit).toBe(String(LEGACY_LIST_LIMIT));
  });

  it('neutralizes characters that would break the or() filter', () => {
    expect(customerSearchFilter('  ')).toBeNull();
    const filter = customerSearchFilter('a",b)(*%_\\{x}')!;
    expect(filter).not.toMatch(/[\\%_]/);
    expect(filter).toContain('tags.cs.{a b x}');
    expect(filter.match(/"/g)!.length).toBe(6);
    expect(parseContentRangeTotal('0-0/7')).toBe(7);
    expect(parseContentRangeTotal('*/0')).toBe(0);
    expect(parseContentRangeTotal(null)).toBeNull();
    expect(decodeCursor(encodeCursor(250))).toBe(250);
    expect(decodeCursor('###')).toBeUndefined();
  });
});

describe('customer marketing consent (047)', () => {
  const headers = { authorization: 'Bearer access' };
  it('accepts marketing_consent on create and patch but never a client-supplied consent timestamp', async () => {
    const { app } = fixture();
    const base = `/api/v1/organizations/${organizationId}/customers`;
    const created = await app.inject({ method: 'POST', url: base, headers, payload: { name: '동의 고객', marketing_consent: true } });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ name: '동의 고객', marketing_consent: true });
    const patched = await app.inject({ method: 'PATCH', url: `${base}/${customerId}`, headers, payload: { marketing_consent: false } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ marketing_consent: false });
    for (const payload of [{ name: 'x', marketing_consent_at: '2026-01-01T00:00:00Z' }, { name: 'x', marketing_consent: 'yes' }]) {
      expect((await app.inject({ method: 'POST', url: base, headers, payload })).statusCode).toBe(422);
    }
    expect((await app.inject({ method: 'PATCH', url: `${base}/${customerId}`, headers, payload: { marketing_consent_at: '2026-01-01T00:00:00Z' } })).statusCode).toBe(422);
    await app.close();
  });

  it('rejects a full customer row (id, organization, created_at) as a PATCH body', async () => {
    const { app } = fixture();
    const result = await app.inject({ method: 'PATCH', url: `/api/v1/organizations/${organizationId}/customers/${customerId}`, headers, payload: { ...customer, created_at: '2026-10-01T00:00:00Z' } });
    expect(result.statusCode).toBe(422);
    await app.close();
  });
});

describe('customer retention controls (CRM-014)', () => {
  it('requires organization CRM access, validates explicit periods and never exposes a purge action', async () => {
    const policy = { organization_id: organizationId, profile_days: null, sensitive_notes_days: null, treatment_photos_days: null, consent_records_days: null, transaction_records_days: null, dispute_records_days: null, audit_events_days: null, version: 1, updated_by: customerId, updated_at: '2026-10-21T00:00:00Z' };
    const { app, accessCalls } = toolsFixture({ getRetentionPolicy: async () => null, saveRetentionPolicy: async (_t: string, _o: string, value: object) => ({ ...policy, ...value }) });
    const result = await app.inject({ url: `${apiBase}/customer-retention-policy`, headers: auth });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ policy: null, purge_enabled: false });
    const payload = { expected_version: 0, profile_days: null, sensitive_notes_days: null, treatment_photos_days: null, consent_records_days: null, transaction_records_days: null, dispute_records_days: null, audit_events_days: null };
    const saved = await app.inject({ method: 'PUT', url: `${apiBase}/customer-retention-policy`, headers: auth, payload });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().profile_days).toBeNull();
    expect(accessCalls).toEqual([false, true]);
    expect((await app.inject({ method: 'PUT', url: `${apiBase}/customer-retention-policy`, headers: auth, payload: { ...payload, profile_days: 0 } })).statusCode).toBe(422);
    await app.close();
  });

  it('routes relationship end and legal hold through manager-checked gateways with reason required', async () => {
    const { app, calls, accessCalls } = toolsFixture({
      setRelationshipEnd: async (_t: string, _o: string, id: string, endedAt: string | null, reason: string) => { calls.push({ name: 'end', args: [id, endedAt, reason] }); return endedAt; },
      setLegalHold: async (_t: string, _o: string, id: string, active: boolean, reason: string) => { calls.push({ name: 'hold', args: [id, active, reason] }); return operationId; },
    });
    const ended = await app.inject({ method: 'PUT', url: `${apiBase}/customers/${customerId}/relationship-end`, headers: auth, payload: { ended_at: '2026-10-01T00:00:00Z', reason: '운영 종료' } });
    expect(ended.statusCode).toBe(200);
    const held = await app.inject({ method: 'PUT', url: `${apiBase}/customers/${customerId}/legal-hold`, headers: auth, payload: { active: true, reason: '분쟁 중' } });
    expect(held.statusCode).toBe(200);
    expect(calls.map(call => call.name)).toEqual(['end', 'hold']);
    expect(accessCalls).toEqual([true, true]);
    expect((await app.inject({ method: 'PUT', url: `${apiBase}/customers/${customerId}/legal-hold`, headers: auth, payload: { active: false, reason: ' ' } })).statusCode).toBe(422);
    await app.close();
  });
});
