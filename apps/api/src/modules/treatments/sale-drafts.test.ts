import { describe, expect, it } from 'vitest';
import { actorId, allFeatures, build, customerId, documentId, headers, json, operationId, organizationId, treatmentId, type Provider } from './fixtures.js';

const scoped = `/api/v1/organizations/${organizationId}/customers/${customerId}/treatments/${treatmentId}/sale-draft`;
const inbox = `/api/v1/organizations/${organizationId}/treatment-sale-drafts`;
const values = { description: '실제 시술', amount: '999999999999.99', consent_document_id: null, exception_reason: '별도 확인', partial_reason: '' };
const preview = {
  values, line: { description: '실제 시술', quantity: 1, unit_price: values.amount, line_total: values.amount, practitioner: '담당' },
  total_amount: values.amount, source_snapshot: { treatment: { version: 2 } }, consent_status: 'not_linked', warnings: ['동의 예외 확인'],
};
const draft = {
  id: documentId, organization_id: organizationId, customer_id: customerId, treatment_id: treatmentId, status: 'draft', description: '실제 시술', amount: values.amount,
  source_snapshot: preview.source_snapshot, created_by: actorId, created_at: '2030-01-01T00:00:00Z', operation_id: operationId, request_fingerprint: { secret: true },
};
const create = { operation_id: operationId, expected_preview: preview, confirmed: true };

const provider: Provider = (call) => {
  if (call.url.pathname.endsWith('/preview_treatment_sale_draft')) return json(preview);
  if (call.url.pathname.endsWith('/treatment_records')) return json([{ id: treatmentId }]);
  if (Number(call.url.searchParams.get('offset') ?? 0) > 0) return json([]);
  return json([draft]);
};

describe('every sale-draft route', () => {
  const routes = [
    ['GET', scoped, undefined], ['GET', inbox, undefined], ['POST', `${scoped}/preview`, { values }], ['POST', scoped, create],
  ] as const;

  it.each(routes)('%s %s requires auth, membership and all three features before touching the database', async (method, url, payload) => {
    const attempts: [Parameters<typeof build>[0], number, boolean][] = [
      [{}, 401, false], [{ role: null }, 403, true],
      ...allFeatures.map((missing): [Parameters<typeof build>[0], number, boolean] => [{ features: allFeatures.filter((feature) => feature !== missing) }, 403, true]),
    ];
    for (const [options, status, authenticated] of attempts) {
      const { app, calls } = build({ provider, ...options });
      const response = await app.inject({ method, url, headers: status === 401 ? {} : headers, payload });
      expect(response.statusCode, JSON.stringify(options)).toBe(status);
      expect(calls).toEqual([]);
      void authenticated;
    }
  });
});

describe('sale-draft permissions', () => {
  it('lets members read and preview but only managers create', async () => {
    expect((await build({ role: 'member', provider }).app.inject({ url: scoped, headers })).statusCode).toBe(200);
    expect((await build({ role: 'member', provider }).app.inject({ url: inbox, headers })).statusCode).toBe(200);
    const previewed = await build({ role: 'member', provider }).app.inject({ method: 'POST', url: `${scoped}/preview`, headers, payload: { values } });
    expect(previewed.json()).toEqual(preview);
    const denied = build({ role: 'member', provider });
    expect((await denied.app.inject({ method: 'POST', url: scoped, headers, payload: create })).statusCode).toBe(403);
    expect(denied.calls).toEqual([]);
  });

  it.each(['owner', 'admin'])('forwards the exact reviewed preview and retry identity as %s and hides private fields', async (role) => {
    const { app, calls, access } = build({ role, provider });
    const response = await app.inject({ method: 'POST', url: scoped, headers, payload: create });
    expect(response.statusCode).toBe(201);
    expect(response.json().amount).toBe('999999999999.99');
    expect(response.json()).not.toHaveProperty('operation_id');
    expect(response.json()).not.toHaveProperty('request_fingerprint');
    expect(calls[0].url.pathname).toBe('/rest/v1/rpc/create_treatment_sale_draft');
    expect(calls[0].body).toEqual({ p_organization_id: organizationId, p_customer_id: customerId, p_treatment_id: treatmentId, p_operation_id: operationId, p_expected_preview: preview, p_confirmed: true });
    expect(calls[0].headers.Authorization).toBe('Bearer access');
    expect(access.every((entry) => entry.write)).toBe(true);
  });

  it('requires exactly one row from the create RPC', async () => {
    const empty = build({ provider: () => json([]) });
    expect((await empty.app.inject({ method: 'POST', url: scoped, headers, payload: create })).statusCode).toBe(503);
    const two = build({ provider: () => json([draft, draft]) });
    expect((await two.app.inject({ method: 'POST', url: scoped, headers, payload: create })).statusCode).toBe(503);
  });
});

describe('sale-draft validation', () => {
  it.each([null, 0, 1.2, true, '-1', '1e2', '1.001', '1000000000000', '', '01', '1.'])('never lets amount %j reach the database', async (amount) => {
    const { app, calls } = build({ provider });
    const response = await app.inject({ method: 'POST', url: `${scoped}/preview`, headers, payload: { values: { ...values, amount } } });
    expect(response.statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it.each([
    { description: '' }, { description: ' ' }, { description: 'x'.repeat(201) }, { exception_reason: 'x'.repeat(2001) }, { partial_reason: null },
    { consent_document_id: 'bad' }, { injected: true },
  ])('rejects sale values %j', async (patch) => {
    const { app, calls } = build({ provider });
    expect((await app.inject({ method: 'POST', url: `${scoped}/preview`, headers, payload: { values: { ...values, ...patch } } })).statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it('accepts amounts at the boundary and a linked consent document', async () => {
    const { app } = build({ provider });
    for (const patch of [{ amount: '0' }, { amount: '0.5' }, { amount: '1000.00' }, { consent_document_id: documentId }]) {
      expect((await app.inject({ method: 'POST', url: `${scoped}/preview`, headers, payload: { values: { ...values, ...patch } } })).statusCode).toBe(200);
    }
  });

  it.each([false, 1, 'true', null, undefined])('requires literal confirmation (%j)', async (confirmed) => {
    const { app, calls } = build({ provider });
    expect((await app.inject({ method: 'POST', url: scoped, headers, payload: { ...create, confirmed } })).statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it('rejects malformed previews, bad operation ids and extra fields', async () => {
    const { app, calls } = build({ provider });
    for (const payload of [
      { ...create, operation_id: 'x' }, { ...create, expected_preview: { ...preview, consent_status: 'other' } }, { ...create, expected_preview: { ...preview, extra: 1 } },
      { ...create, expected_preview: { ...preview, line: { ...preview.line, quantity: 2 } } }, { ...create, injected: true },
    ]) expect((await app.inject({ method: 'POST', url: scoped, headers, payload })).statusCode).toBe(422);
    expect(calls).toEqual([]);
  });
});

describe('sale-draft reads', () => {
  it('checks the parent treatment scope and filters by customer and treatment', async () => {
    const { app, calls } = build({ provider });
    expect((await app.inject({ url: scoped, headers })).statusCode).toBe(200);
    expect(calls[0].url.pathname).toBe('/rest/v1/treatment_records');
    expect(calls[0].url.searchParams.get('customer_id')).toBe(`eq.${customerId}`);
    const query = calls[calls.length - 1].url.searchParams;
    expect([query.get('organization_id'), query.get('customer_id'), query.get('treatment_id'), query.get('status')]).toEqual([`eq.${organizationId}`, `eq.${customerId}`, `eq.${treatmentId}`, 'eq.draft']);
    expect(query.get('select')).not.toContain('request_fingerprint');
    expect((await build({ provider: () => json([]) }).app.inject({ url: scoped, headers })).statusCode).toBe(404);
  });

  it('answers 503 when the parent row or draft count is inconsistent', async () => {
    const wrongParent = build({ provider: (call) => call.url.pathname.endsWith('/treatment_records') ? json([{ id: documentId }]) : json([draft]) });
    expect((await wrongParent.app.inject({ url: scoped, headers })).statusCode).toBe(503);
    const twoDrafts = build({ provider: (call) => call.url.pathname.endsWith('/treatment_records') ? json([{ id: treatmentId }]) : json([draft, { ...draft, id: operationId }]) });
    expect((await twoDrafts.app.inject({ url: scoped, headers })).statusCode).toBe(503);
  });

  it('loads the pending inbox page by page until an empty page', async () => {
    const { app, calls } = build({ provider });
    const response = await app.inject({ url: inbox, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(1);
    expect(response.json()[0]).not.toHaveProperty('operation_id');
    const first = calls[0].url.searchParams;
    expect([first.get('status'), first.get('order'), first.get('limit'), first.get('offset')]).toEqual(['eq.draft', 'created_at.desc,id.desc', '500', '0']);
    expect(calls[1].url.searchParams.get('offset')).toBe('1');
    expect(calls).toHaveLength(2);
  });

  it('refuses a repeated page and cross-organization rows', async () => {
    expect((await build({ provider: () => json([draft]) }).app.inject({ url: inbox, headers })).statusCode).toBe(503);
    expect((await build({ provider: () => json([{ ...draft, organization_id: customerId }]) }).app.inject({ url: inbox, headers })).statusCode).toBe(503);
  });

  it('keeps the exact decimal amount of numeric PostgREST values', async () => {
    const raw = JSON.stringify([draft]).replace('"999999999999.99"', '999999999999.99');
    const { app } = build({ provider: (call) => call.url.pathname.endsWith('/treatment_records') ? json([{ id: treatmentId }]) : { raw } });
    expect((await app.inject({ url: scoped, headers })).json()[0].amount).toBe('999999999999.99');
  });
});

describe('sale-draft error mapping', () => {
  it.each([['P0001', 409], ['P0002', 404], ['42501', 403], ['22023', 422], ['unknown', 503]])('maps database code %s to HTTP %i without private data', async (code, status) => {
    const { app } = build({ provider: () => ({ status: 400, body: { code, message: 'private data' } }) });
    const response = await app.inject({ method: 'POST', url: scoped, headers, payload: create });
    expect(response.statusCode).toBe(status);
    expect(response.body).not.toContain('private data');
  });

  it('uses the sale-draft messages', async () => {
    const conflict = build({ provider: () => ({ status: 400, body: { code: 'P0001' } }) });
    expect((await conflict.app.inject({ method: 'POST', url: `${scoped}/preview`, headers, payload: { values } })).json().detail).toBe('Preview changed or draft already exists; review again');
  });

  it('treats a malformed preview from the database as an outage', async () => {
    const { app } = build({ provider: () => json({ ...preview, consent_status: 'weird' }) });
    expect((await app.inject({ method: 'POST', url: `${scoped}/preview`, headers, payload: { values } })).statusCode).toBe(503);
  });
});
