import { describe, expect, it } from 'vitest';
import { actorId, build, customerId, headers, json, operationId, organizationId, otherOrganizationId, treatmentId, treatmentRowJson, treatmentValues } from './fixtures.js';
import { normalizeAmount } from './schemas.js';

const base = `/api/v1/organizations/${organizationId}/customers/${customerId}`;
const list = `${base}/treatments`;
const one = `${list}/${treatmentId}`;
const consult = { goal: '보습 관리', plan: '상태 확인 후 관리', acknowledge_cautions: true, expected_cautions: { allergies: '향료', skin_type: null, concerns: ['건조'] } };
const mutation = (changes: Record<string, unknown> = {}) => ({ action: 'start', expected_version: 1, operation_id: operationId, reason: '', values: null, ...changes });
const started = { ...treatmentRowJson, status: 'in_progress', version: 2 };

describe('treatment list and create', () => {
  it('lists a customer history scoped by organization and customer, with member read access', async () => {
    const { app, calls, access } = build({ role: 'member', provider: () => json([treatmentRowJson]) });
    const result = await app.inject({ url: list, headers });
    expect(result.statusCode).toBe(200);
    expect(result.json()[0]).toMatchObject({ id: treatmentId, amount: '15000.50', status: 'draft', version: 1, consultation_goal: '', cautions_snapshot: {} });
    expect(calls[0].url.pathname).toBe('/rest/v1/treatment_records');
    expect(calls[0].url.searchParams.get('organization_id')).toBe(`eq.${organizationId}`);
    expect(calls[0].url.searchParams.get('customer_id')).toBe(`eq.${customerId}`);
    expect(calls[0].url.searchParams.get('order')).toBe('treatment_date.desc,id.desc');
    expect(calls[0].url.searchParams.get('select')).toContain('cautions_acknowledged_at');
    expect(calls[0].headers.Authorization).toBe('Bearer access');
    expect(access).toEqual([{ feature: 'crm.basic', write: false }]);
  });

  it('creates with JSON-safe decimal and date values and answers 201', async () => {
    const { app, calls, access } = build({ provider: () => json([treatmentRowJson]) });
    const result = await app.inject({ method: 'POST', url: list, headers, payload: treatmentValues });
    expect(result.statusCode).toBe(201);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ organization_id: organizationId, customer_id: customerId, ...treatmentValues });
    expect(access).toEqual([{ feature: 'crm.basic', write: true }]);
  });

  it('applies defaults, trims names, normalizes exponent amounts and accepts null amounts', async () => {
    const { app, calls } = build({ provider: () => json([treatmentRowJson]) });
    await app.inject({ method: 'POST', url: list, headers, payload: { treatment_date: '2026-09-18', treatment_name: '  수분  ', category: ' 피부 ', amount: '1E+3' } });
    expect(calls[0].body).toEqual({ organization_id: organizationId, customer_id: customerId, treatment_date: '2026-09-18', treatment_name: '수분', category: '피부', practitioner: '', notes: '', amount: '1000.00', next_visit_date: null });
    await app.inject({ method: 'POST', url: list, headers, payload: { ...treatmentValues, amount: null } });
    expect((calls[1].body as { amount: unknown }).amount).toBeNull();
  });

  it.each([
    ['treatment_name', '  '], ['treatment_date', '2026-02-31'], ['treatment_date', null], ['next_visit_date', 'invalid'], ['next_visit_date', '2026-09-17'],
    ['amount', '-1'], ['amount', '1000000000000'], ['amount', '1.001'], ['amount', 'abc'], ['notes', 'a'.repeat(10_001)], ['treatment_name', 'a'.repeat(201)], ['injected', true],
  ])('rejects invalid %s=%j before reaching the database', async (field, value) => {
    const { app, calls } = build();
    const result = await app.inject({ method: 'POST', url: list, headers, payload: { ...treatmentValues, [field as string]: value } });
    expect(result.statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it('reports 503 without leaking provider internals', async () => {
    const { app } = build({ provider: () => ({ status: 500, body: { message: 'private data', code: 'XX000' } }) });
    const result = await app.inject({ method: 'POST', url: list, headers, payload: treatmentValues });
    expect(result.statusCode).toBe(503);
    expect(result.body).not.toContain('private data');
    expect(result.json().detail).toBe('Treatment service unavailable');
  });

  it('rejects rows from another organization', async () => {
    const { app } = build({ provider: () => json([{ ...treatmentRowJson, organization_id: otherOrganizationId }]) });
    expect((await app.inject({ url: list, headers })).statusCode).toBe(503);
  });

  it.each([['POST', list], ['PATCH', one], ['POST', `${one}/mutations`]])('%s %s enforces auth, membership, feature and manager role', async (method, url) => {
    const payload = url.endsWith('mutations') ? mutation() : method === 'PATCH' ? { ...treatmentValues, expected_version: 1 } : treatmentValues;
    const send = async (options: Parameters<typeof build>[0], token = true) => {
      const { app, calls } = build(options);
      const response = await app.inject({ method: method as 'POST', url, headers: token ? headers : {}, payload });
      return { status: response.statusCode, calls };
    };
    expect((await send({}, false)).status).toBe(401);
    expect((await send({ role: null })).status).toBe(403);
    expect((await send({ role: 'member' })).status).toBe(403);
    expect((await send({ features: [] })).status).toBe(403);
    const unavailable = await send({ provider: () => ({ status: 500, body: {} }) });
    expect(unavailable.status).toBe(503);
    const denied = await send({ role: 'member' });
    expect(denied.calls).toEqual([]);
  });

  it('answers 503 when organization access is not configured', async () => {
    const { app } = build({ withOrganizations: false });
    expect((await app.inject({ url: list, headers })).statusCode).toBe(503);
  });

  it('rejects malformed IDs', async () => {
    const { app } = build();
    expect((await app.inject({ url: `${base}x/treatments`, headers })).statusCode).toBe(422);
    expect((await app.inject({ url: `/api/v1/organizations/${organizationId}/customers/not-a-uuid/treatments`, headers })).statusCode).toBe(422);
  });
});

describe('treatment PATCH (legacy edit)', () => {
  it('routes an edit through the mutate_treatment RPC with the expected version and a fresh operation id', async () => {
    const { app, calls } = build({ provider: () => json([{ ...treatmentRowJson, notes: '정정 내용' }]) });
    const result = await app.inject({ method: 'PATCH', url: one, headers, payload: { ...treatmentValues, notes: '정정 내용', expected_version: 1 } });
    expect(result.statusCode).toBe(200);
    expect(result.json().id).toBe(treatmentId);
    expect(calls[0].url.pathname).toBe('/rest/v1/rpc/mutate_treatment');
    const body = calls[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ p_organization_id: organizationId, p_customer_id: customerId, p_treatment_id: treatmentId, p_action: 'edit', p_expected_version: 1, p_reason: '' });
    expect(body.p_operation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.p_values).toEqual({ ...treatmentValues, notes: '정정 내용' });
  });

  it('keeps a supplied operation id for idempotent retries', async () => {
    const { app, calls } = build({ provider: () => json([treatmentRowJson]) });
    await app.inject({ method: 'PATCH', url: one, headers, payload: { ...treatmentValues, expected_version: 3, operation_id: operationId } });
    expect(calls[0].body).toMatchObject({ p_expected_version: 3, p_operation_id: operationId });
  });

  it('requires expected_version (409) and a positive one (422)', async () => {
    const { app, calls } = build();
    const missing = await app.inject({ method: 'PATCH', url: one, headers, payload: treatmentValues });
    expect(missing.statusCode).toBe(409);
    expect(missing.json().detail).toBe('Refresh record and provide expected_version');
    expect((await app.inject({ method: 'PATCH', url: one, headers, payload: { ...treatmentValues, expected_version: 0 } })).statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it('answers 404 when the RPC returns no row', async () => {
    const { app } = build({ provider: () => json([]) });
    const result = await app.inject({ method: 'PATCH', url: one, headers, payload: { ...treatmentValues, expected_version: 1 } });
    expect(result.statusCode).toBe(404);
    expect(result.json().detail).toBe('Treatment not found');
  });
});

describe('treatment mutations', () => {
  it('forwards a transition to the RPC and returns the lifecycle response', async () => {
    const { app, calls } = build({ provider: () => json([started]) });
    const result = await app.inject({ method: 'POST', url: `${one}/mutations`, headers, payload: mutation() });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ status: 'in_progress', version: 2 });
    expect(calls[0].body).toEqual({ p_organization_id: organizationId, p_customer_id: customerId, p_treatment_id: treatmentId, p_action: 'start', p_expected_version: 1, p_operation_id: operationId, p_reason: '', p_values: {} });
  });

  it('forwards consultation values exactly and keeps cautions fields in the projection', async () => {
    const row = { ...treatmentRowJson, consultation_goal: '보습', consultation_plan: '확인 후 관리', cautions_snapshot: { allergies: '향료', skin_type: null, concerns: ['건조'] }, cautions_acknowledged_by: actorId, cautions_acknowledged_at: '2026-09-22T01:00:00+00:00' };
    const { app, calls } = build({ provider: () => json([row]) });
    const result = await app.inject({ method: 'POST', url: `${one}/mutations`, headers, payload: mutation({ action: 'consult', values: consult }) });
    expect(result.statusCode).toBe(200);
    expect(calls[0].body).toMatchObject({ p_action: 'consult', p_values: consult, p_operation_id: operationId });
    expect(result.json()).toMatchObject({ consultation_goal: '보습', cautions_snapshot: row.cautions_snapshot, cautions_acknowledged_by: actorId, cautions_acknowledged_at: row.cautions_acknowledged_at });
  });

  it('normalizes edit values and trims the reason', async () => {
    const { app, calls } = build({ provider: () => json([treatmentRowJson]) });
    await app.inject({ method: 'POST', url: `${one}/mutations`, headers, payload: mutation({ action: 'correct', reason: '  오기 정정  ', values: { ...treatmentValues, amount: '1E+3' } }) });
    expect(calls[0].body).toMatchObject({ p_action: 'correct', p_reason: '오기 정정' });
    expect((calls[0].body as { p_values: { amount: string } }).p_values.amount).toBe('1000.00');
  });

  it('accepts empty consultation drafts and the maximum lengths', async () => {
    const { app } = build({ provider: () => json([treatmentRowJson]) });
    for (const [goal, plan, ack] of [['', '', false], ['가'.repeat(2000), '나'.repeat(5000), true]] as const) {
      const result = await app.inject({ method: 'POST', url: `${one}/mutations`, headers, payload: mutation({ action: 'consult', values: { ...consult, goal, plan, acknowledge_cautions: ack } }) });
      expect(result.statusCode).toBe(200);
    }
  });

  it.each([
    { action: 'complete', values: treatmentValues }, { action: 'cancel', reason: '   ' }, { action: 'correct', reason: '', values: treatmentValues },
    { action: 'edit', values: null }, { expected_version: 0 }, { operation_id: 'invalid' }, { action: 'delete' }, { actor_id: actorId },
    { action: 'consult', values: treatmentValues }, { action: 'consult', values: null }, { action: 'start', reason: 'x'.repeat(2001) },
    ...['edit', 'correct', 'start', 'complete', 'cancel'].map((action) => ({ action, reason: 'reason', values: consult })),
  ])('rejects invalid mutation %j', async (changes) => {
    const { app, calls } = build();
    const result = await app.inject({ method: 'POST', url: `${one}/mutations`, headers, payload: mutation(changes) });
    expect(result.statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it.each([
    { goal: 'x'.repeat(2001) }, { plan: 'x'.repeat(5001) }, { goal: null }, { plan: 1 }, { acknowledge_cautions: 'true' }, { acknowledge_cautions: 1 }, { acknowledge_cautions: null },
    { expected_cautions: {} }, { expected_cautions: { allergies: null, skin_type: null, concerns: [] } }, { expected_cautions: { allergies: '', skin_type: 1, concerns: [] } },
    { expected_cautions: { allergies: '', skin_type: null, concerns: 'dry' } }, { expected_cautions: { allergies: '', skin_type: null, concerns: [1] } },
    { expected_cautions: { allergies: '', skin_type: null, concerns: [], extra: 1 } }, { cautions_acknowledged_by: actorId },
  ])('never lets invalid consultation %j reach the database', async (changes) => {
    const { app, calls } = build();
    const result = await app.inject({ method: 'POST', url: `${one}/mutations`, headers, payload: mutation({ action: 'consult', values: { ...consult, ...changes } }) });
    expect(result.statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it.each(['goal', 'plan', 'acknowledge_cautions', 'expected_cautions'])('requires the %s field of a consultation', async (key) => {
    const { app } = build();
    const { [key]: _removed, ...values } = consult as Record<string, unknown>;
    expect((await app.inject({ method: 'POST', url: `${one}/mutations`, headers, payload: mutation({ action: 'consult', values }) })).statusCode).toBe(422);
  });

  it.each([
    ['P0001', 409], ['P0002', 404], ['42501', 403], ['22023', 422], ['22008', 422], ['23514', 422], ['22003', 422], ['XX000', 503], ['', 503],
  ])('maps database error code %s to HTTP %i', async (code, status) => {
    const { app } = build({ provider: () => ({ status: 400, body: { code, message: 'private data' } }) });
    const result = await app.inject({ method: 'POST', url: `${one}/mutations`, headers, payload: mutation() });
    expect(result.statusCode).toBe(status);
    expect(result.body).not.toContain('private data');
  });

  it('keeps conflicts distinct from outages', async () => {
    const conflict = build({ provider: () => ({ status: 400, body: { code: 'P0001' } }) });
    const result = await conflict.app.inject({ method: 'POST', url: `${one}/mutations`, headers, payload: mutation() });
    expect(result.json().detail).toBe('Record changed or transition not allowed');
    const outage = build({ provider: () => ({ status: 500, raw: 'not json' }) });
    expect((await outage.app.inject({ method: 'POST', url: `${one}/mutations`, headers, payload: mutation() })).statusCode).toBe(503);
  });
});

describe('treatment events', () => {
  const event = { id: operationId, actor_id: actorId, action: 'start', reason: '', occurred_at: '2026-09-22T01:00:00+00:00', before_data: { status: 'draft' }, after_data: { status: 'in_progress' } };

  it('lets members read audit history scoped to organization, customer and treatment', async () => {
    const { app, calls, access } = build({ role: 'member', provider: () => json([event]) });
    const result = await app.inject({ url: `${one}/events`, headers });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual([event]);
    const query = calls[0].url.searchParams;
    expect(calls[0].url.pathname).toBe('/rest/v1/treatment_record_events');
    expect([query.get('organization_id'), query.get('customer_id'), query.get('treatment_id')]).toEqual([`eq.${organizationId}`, `eq.${customerId}`, `eq.${treatmentId}`]);
    expect(query.get('order')).toBe('occurred_at.desc,id.desc');
    expect(access).toEqual([{ feature: 'crm.basic', write: false }]);
  });

  it('treats a malformed audit row as an outage', async () => {
    const { app } = build({ provider: () => json([{ ...event, actor_id: null }]) });
    expect((await app.inject({ url: `${one}/events`, headers })).statusCode).toBe(503);
  });
});

describe('treatment photos', () => {
  const photo = { id: operationId, organization_id: organizationId, customer_id: customerId, treatment_id: treatmentId, storage_path: `${organizationId}/a.jpg`, thumbnail_path: null, content_type: 'image/jpeg', caption: '', sort_order: 0, taken_at: null };
  const photos = `${base}/treatment-photos`;

  it('lists photos with an optional treatment filter', async () => {
    const { app, calls } = build({ role: 'member', provider: () => json([photo]) });
    expect((await app.inject({ url: `${photos}?treatment_id=${treatmentId}`, headers })).json()).toEqual([photo]);
    expect(calls[0].url.searchParams.get('treatment_id')).toBe(`eq.${treatmentId}`);
    expect(calls[0].url.searchParams.get('order')).toBe('sort_order.asc,created_at.asc');
    await app.inject({ url: photos, headers });
    expect(calls[1].url.searchParams.has('treatment_id')).toBe(false);
    expect((await app.inject({ url: `${photos}?treatment_id=bad`, headers })).statusCode).toBe(422);
  });

  it('creates photo metadata for managers only and applies defaults', async () => {
    const { app, calls } = build({ provider: () => json([photo]) });
    const result = await app.inject({ method: 'POST', url: photos, headers, payload: { treatment_id: treatmentId, storage_path: photo.storage_path } });
    expect(result.statusCode).toBe(201);
    expect(calls[0].body).toEqual({ organization_id: organizationId, customer_id: customerId, treatment_id: treatmentId, storage_path: photo.storage_path, thumbnail_path: null, content_type: 'image/jpeg', caption: '', sort_order: 0, taken_at: null });
    expect((await build().app.inject({ method: 'POST', url: photos, headers, payload: { treatment_id: treatmentId, storage_path: '' } })).statusCode).toBe(422);
    expect((await build().app.inject({ method: 'POST', url: photos, headers, payload: { treatment_id: treatmentId, storage_path: 'a', sort_order: -1 } })).statusCode).toBe(422);
    expect((await build({ role: 'member' }).app.inject({ method: 'POST', url: photos, headers, payload: { treatment_id: treatmentId, storage_path: 'a' } })).statusCode).toBe(403);
  });

  it('deletes an existing photo (204) and answers 404 for a missing one', async () => {
    const present = build({ provider: (call) => json(call.method === 'GET' ? [{ id: photo.id }] : null) });
    expect((await present.app.inject({ method: 'DELETE', url: `${photos}/${photo.id}`, headers })).statusCode).toBe(204);
    expect(present.calls.map((call) => call.method)).toEqual(['GET', 'DELETE']);
    expect(present.calls[1].url.searchParams.get('organization_id')).toBe(`eq.${organizationId}`);
    expect(present.calls[1].url.searchParams.get('customer_id')).toBe(`eq.${customerId}`);
    const missing = build({ provider: () => json([]) });
    const result = await missing.app.inject({ method: 'DELETE', url: `${photos}/${photo.id}`, headers });
    expect(result.statusCode).toBe(404);
    expect(result.json().detail).toBe('Treatment photo not found');
    expect(missing.calls.map((call) => call.method)).toEqual(['GET']);
    expect((await build({ role: 'member' }).app.inject({ method: 'DELETE', url: `${photos}/${photo.id}`, headers })).statusCode).toBe(403);
  });
});

describe('amount normalization', () => {
  it.each([['15000.5', '15000.50'], ['0', '0.00'], ['-0', '0.00'], [' 7 ', '7.00'], ['1E+3', '1000.00'], ['1.50e1', '15.00'], ['.5', '0.50'], ['999999999999.99', '999999999999.99'], [1e3, '1000.00'], [15000.5, '15000.50'], ['10.100', '10.10']])('accepts %j as %s', (input, output) => {
    expect(normalizeAmount(input)).toBe(output);
  });
  it.each(['', '-1', '1.001', '1000000000000', '1e13', 'abc', '1,000', '.', 'NaN', 'Infinity', '1e99999999999', Number.NaN, 1e21])('rejects %j', (input) => {
    expect(normalizeAmount(input)).toBeUndefined();
  });
});
