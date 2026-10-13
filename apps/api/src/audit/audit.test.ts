import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../app.js';
import { ApiFailure } from '../errors.js';
import { createFastifyApp } from '../http.js';
import { registerDocumentRoutes } from '../modules/documents/routes.js';
import { registerSalesRoutes } from '../modules/sales/routes.js';
import { fakeFetch, fakeOrganizations, testConfig, type FakeCall, type FakeReply } from '../modules/catalog/testkit.js';
import { createAuditRecorder, sanitizeMetadata, type AuditEvent, type AuditRecorder } from './recorder.js';
import { registerAuditHooks } from './hooks.js';
import { createAuditGateway, decodeCursor, encodeCursor, registerAuditRoutes } from './routes.js';

const ORG = 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const VISIT = '0a9c39fd-8e8c-4df8-a623-1f23a3a936bd';
const CUSTOMER = '1a9c39fd-8e8c-4df8-a623-1f23a3a936bd';
const TREATMENT = '2a9c39fd-8e8c-4df8-a623-1f23a3a936bd';
const DOCUMENT = '3a9c39fd-8e8c-4df8-a623-1f23a3a936bd';
const TEMPLATE = '4a9c39fd-8e8c-4df8-a623-1f23a3a936bd';
const FILE = '5a9c39fd-8e8c-4df8-a623-1f23a3a936bd';
const OP = '6a9c39fd-8e8c-4df8-a623-1f23a3a936bd';
const ACTOR = '7a9c39fd-8e8c-4df8-a623-1f23a3a936bd';
const headers = { authorization: 'Bearer user-token' };
const base = `/api/v1/organizations/${ORG}`;

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

function fakeRecorder() {
  const events: AuditEvent[] = [];
  const recorder: AuditRecorder = { record: async (_token, event) => { events.push(event); }, recordRequired: async (_token, event) => { events.push(event); } };
  return { events, recorder };
}

describe('sanitizeMetadata', () => {
  it('스칼라만 남기고 이름·연락처·사유 같은 자유 입력과 인증 값은 버린다', () => {
    const result = sanitizeMetadata({
      amount: 5000, restock: true, note: null, business_date: '2026-10-13', customer_name: '홍길동', phone: '010-0000-0000', email: 'a@b.c', reason: '고객 요청',
      access_token: 'secret', nested: { a: 1 }, list: [1], long: 'x'.repeat(500), bad: Number.NaN, missing: undefined, memo: 'x',
    });
    expect(Object.keys(result).sort()).toEqual(['amount', 'business_date', 'long', 'restock']);
    expect((result.long as string).length).toBe(200);
  });

  it('키를 20개로 제한한다', () => {
    expect(Object.keys(sanitizeMetadata(Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`k${index}`, index])))).length).toBe(20);
  });
});

describe('createAuditRecorder', () => {
  const event: AuditEvent = { organizationId: ORG, action: 'sale.refund', targetType: 'visit', targetId: VISIT, metadata: { amount: 1000, reason: 'private' }, requestId: 'req-1', ip: '10.0.0.1' };

  it('사용자 토큰(서비스 키 아님)으로 record_audit_event RPC 를 호출한다', async () => {
    const { fetcher, calls } = fakeFetch(() => ({ body: OP }));
    await createAuditRecorder(testConfig, fetcher).record('user-token', event);
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe('/rest/v1/rpc/record_audit_event');
    expect(calls[0].headers.Authorization).toBe('Bearer user-token');
    expect(calls[0].headers.apikey).toBe('public-key');
    expect(calls[0].body).toEqual({ p_organization_id: ORG, p_action: 'sale.refund', p_target_type: 'visit', p_target_id: VISIT, p_metadata: { amount: 1000 }, p_request_id: 'req-1', p_ip: '10.0.0.1' });
  });

  it('record 는 실패해도 던지지 않고 토큰·원문 없이 경고만 남긴다', async () => {
    const warn = vi.fn();
    const { fetcher } = fakeFetch(() => ({ status: 500, body: { message: 'secret internal error user-token' } }));
    await expect(createAuditRecorder(testConfig, fetcher, { warn }).record('user-token', event)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('user-token');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret internal');
  });

  it('recordRequired 는 실패하면 503 을 던지고 권한 오류는 그대로 전달한다', async () => {
    const failing = createAuditRecorder(testConfig, fakeFetch(() => ({ status: 500, body: {} })).fetcher);
    await expect(failing.recordRequired('t', event)).rejects.toMatchObject({ status: 503 });
    const forbidden = createAuditRecorder(testConfig, fakeFetch(() => ({ status: 403, body: {} })).fetcher);
    await expect(forbidden.recordRequired('t', event)).rejects.toMatchObject({ status: 403 });
    const wrongShape = createAuditRecorder(testConfig, fakeFetch(() => ({ body: { not: 'a uuid' } })).fetcher);
    await expect(wrongShape.recordRequired('t', event)).rejects.toMatchObject({ status: 503 });
  });
});

describe('성공한 민감 작업 뒤 감사 기록 훅', () => {
  const access = fakeOrganizations('owner', ['crm.basic', 'finance.basic', 'document.template', 'files.basic']);
  const gateway = (overrides: Record<string, unknown> = {}) => ({
    refundPayment: vi.fn(async () => ({ ok: true })), returnProduct: vi.fn(async () => ({ ok: true })), closeDay: vi.fn(async () => ({ ok: true })), adjustClose: vi.fn(async () => ({ ok: true })),
    recordConsentEvent: vi.fn(async () => ({ ok: true })), issueTreatmentDocument: vi.fn(async () => ({ ok: true })), mutateTemplate: vi.fn(async () => ({ ok: true })),
    archiveFile: vi.fn(async () => ({ id: FILE })), ...overrides,
  });

  function build(overrides: Record<string, unknown> = {}, recorder: AuditRecorder = fakeRecorder().recorder) {
    const stub = gateway(overrides);
    app = createFastifyApp({ APP_LOG_LEVEL: 'silent' });
    registerAuditHooks(app, recorder);
    registerSalesRoutes(app, access, stub as never);
    registerDocumentRoutes(app, access, stub as never);
    return stub;
  }
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers, payload: payload as object });

  it('환불은 금액·원천 ID 만 기록하고 사유(자유 입력)는 기록하지 않는다', async () => {
    const { events, recorder } = fakeRecorder();
    build({}, recorder);
    const response = await post(`${base}/visits/${VISIT}/payments/refunds`, { expected_version: 1, operation_id: OP, source_id: FILE, amount: '3000', reason: '고객 변심 010-1234-5678', confirmed: true });
    expect(response.statusCode).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ organizationId: ORG, action: 'sale.refund', targetType: 'visit', targetId: VISIT, metadata: { source_id: FILE, amount: '3000', operation_id: OP } });
    expect(JSON.stringify(events[0])).not.toContain('010-1234');
    expect(events[0].requestId).toBeTruthy();
    expect(events[0].ip).toBeTruthy();
  });

  it('상품 반품·일 마감·마감 정정을 기록한다', async () => {
    const { events, recorder } = fakeRecorder();
    build({}, recorder);
    await post(`${base}/visits/${VISIT}/payments/product-returns`, { expected_version: 1, operation_id: OP, sale_line_id: FILE, receipt_id: FILE, quantity: 1, restock: true, amount: '1000', reason: '불량', confirmed: true });
    await post(`${base}/sale-daily-settlement/close?business_date=2026-10-13`, { operation_id: OP, counted_cash: '100000', reason: '마감', confirmed: true });
    await post(`${base}/sale-daily-settlement/adjustments?business_date=2026-10-13`, { operation_id: OP, expected_version: 2, counted_cash: '99000', reason: '정정', confirmed: true });
    expect(events.map((event) => event.action)).toEqual(['sale.product_return', 'sale.day_close', 'sale.close_adjust']);
    expect(events[1].metadata).toEqual({ business_date: '2026-10-13', counted_cash: '100000', operation_id: OP });
    expect(events[2].metadata).toMatchObject({ business_date: '2026-10-13', expected_version: 2 });
  });

  it('작업이 실패하거나 입력이 잘못되면 기록하지 않는다', async () => {
    const { events, recorder } = fakeRecorder();
    build({ refundPayment: vi.fn(async () => { throw new ApiFailure(409, 'Sale cart conflict'); }) }, recorder);
    expect((await post(`${base}/visits/${VISIT}/payments/refunds`, { expected_version: 1, operation_id: OP, source_id: FILE, amount: '3000', reason: 'x', confirmed: true })).statusCode).toBe(409);
    expect((await post(`${base}/visits/${VISIT}/payments/refunds`, { amount: '-1' })).statusCode).toBe(422);
    expect(events).toEqual([]);
  });

  it('동의서 서명·교부·철회를 기록하고 서명 좌표·수령인은 기록하지 않는다', async () => {
    const { events, recorder } = fakeRecorder();
    build({}, recorder);
    const url = `${base}/customers/${CUSTOMER}/treatments/${TREATMENT}/documents/${DOCUMENT}/events`;
    const strokes = [[[0.1, 0.1], [0.2, 0.3]]];
    expect((await post(url, { expected_revision: 0, operation_id: OP, action: 'sign', values: { confirmed: true, signer_name: '홍길동', strokes } })).statusCode).toBe(201);
    expect((await post(url, { expected_revision: 1, operation_id: OP, action: 'deliver', values: { confirmed: true, method: 'email', recipient: 'a@b.c', reference: '', note: '' } })).statusCode).toBe(201);
    expect((await post(url, { expected_revision: 2, operation_id: OP, action: 'revoke', values: { confirmed: true, reason: '철회 사유' } })).statusCode).toBe(201);
    expect(events.map((event) => event.action)).toEqual(['consent.sign', 'consent.deliver', 'consent.revoke']);
    expect(events[1].metadata).toMatchObject({ method: 'email', customer_id: CUSTOMER, treatment_id: TREATMENT });
    const text = JSON.stringify(events);
    for (const secret of ['홍길동', 'a@b.c', '철회 사유', 'strokes', 'recipient']) expect(text).not.toContain(secret);
  });

  it('문서 발행·서식 발행(publish)·파일 보관을 기록하고 서식 save 는 기록하지 않는다', async () => {
    const { events, recorder } = fakeRecorder();
    build({}, recorder);
    await post(`${base}/customers/${CUSTOMER}/treatments/${TREATMENT}/documents`, { template_id: TEMPLATE, operation_id: OP, expected_preview: {} });
    await post(`${base}/document-templates/${TEMPLATE}/mutations`, { operation_id: OP, expected_revision: 1, action: 'publish', values: null });
    await post(`${base}/document-templates/${TEMPLATE}/mutations`, { operation_id: OP, expected_revision: 1, action: 'save', values: { name: '서식', description: '', content: '' } });
    expect((await app.inject({ method: 'DELETE', url: `${base}/files/${FILE}`, headers })).statusCode).toBe(200);
    expect(events.map((event) => [event.action, event.targetType, event.targetId])).toEqual([
      ['document.issue', 'treatment', TREATMENT], ['template.publish', 'document_template', TEMPLATE], ['file.archive', 'file', FILE],
    ]);
  });

  it('감사 기록이 실패해도 본 작업 응답은 그대로다', async () => {
    const warn = vi.fn();
    const failing = createAuditRecorder(testConfig, fakeFetch(() => ({ status: 500, body: {} })).fetcher, { warn });
    build({}, failing);
    const response = await post(`${base}/visits/${VISIT}/payments/refunds`, { expected_version: 1, operation_id: OP, source_id: FILE, amount: '3000', reason: 'x', confirmed: true });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('토큰이 없는 요청(인증 실패)은 기록하지 않는다', async () => {
    const { events, recorder } = fakeRecorder();
    build({}, recorder);
    expect((await app.inject({ method: 'DELETE', url: `${base}/files/${FILE}` })).statusCode).toBe(401);
    expect(events).toEqual([]);
  });
});

describe('고객 영구 삭제 감사(fail-closed)', () => {
  const customers = () => ({ remove: vi.fn(async () => true) });

  it('감사 기록이 성공한 뒤에만 삭제하고 기록 순서가 삭제보다 앞선다', async () => {
    const order: string[] = [];
    const store = customers();
    store.remove.mockImplementation(async () => { order.push('remove'); return true; });
    const recorder: AuditRecorder = { record: async () => {}, recordRequired: async (_token, event) => { order.push(`audit:${event.action}:${event.targetId}`); } };
    app = createApp({ organizations: fakeOrganizations('owner', ['crm.basic']) as never, customers: store as never, audit: recorder });
    const response = await app.inject({ method: 'DELETE', url: `${base}/customers/${CUSTOMER}`, headers });
    expect(response.statusCode).toBe(204);
    expect(order).toEqual([`audit:customer.delete:${CUSTOMER}`, 'remove']);
  });

  it('감사 기록에 실패하면 503 이고 삭제하지 않는다', async () => {
    const store = customers();
    const recorder: AuditRecorder = { record: async () => {}, recordRequired: async () => { throw new ApiFailure(503, 'Audit log unavailable'); } };
    app = createApp({ organizations: fakeOrganizations('owner', ['crm.basic']) as never, customers: store as never, audit: recorder });
    const response = await app.inject({ method: 'DELETE', url: `${base}/customers/${CUSTOMER}`, headers });
    expect(response.statusCode).toBe(503);
    expect(response.json().detail).toBe('Audit log unavailable');
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('권한이 없으면 감사 기록도 삭제도 하지 않는다', async () => {
    const store = customers();
    const recorder = fakeRecorder();
    app = createApp({ organizations: fakeOrganizations('member', ['crm.basic']) as never, customers: store as never, audit: recorder.recorder });
    expect((await app.inject({ method: 'DELETE', url: `${base}/customers/${CUSTOMER}`, headers })).statusCode).toBe(403);
    expect(recorder.events).toEqual([]);
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('감사 기록기가 없는 구성(기존 단위 테스트)은 이전과 같이 동작한다', async () => {
    const store = customers();
    app = createApp({ organizations: fakeOrganizations('owner', ['crm.basic']) as never, customers: store as never });
    expect((await app.inject({ method: 'DELETE', url: `${base}/customers/${CUSTOMER}`, headers })).statusCode).toBe(204);
  });
});

describe('GET /organizations/:id/audit-events', () => {
  const rowAt = (index: number, organizationId = ORG) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, organization_id: organizationId, actor_id: ACTOR, action: 'sale.refund', target_type: 'visit', target_id: VISIT,
    metadata: { amount: 1000 }, request_id: 'req', ip: '10.0.0.1', source: 'api_user', created_at: `2026-10-13T0${index}:00:00+00:00`,
  });

  function build(role: 'owner' | 'admin' | 'member', reply: (call: FakeCall) => FakeReply = () => ({ body: [] })) {
    const { fetcher, calls } = fakeFetch(reply);
    const members = vi.fn(async () => {
      if (role === 'member') throw new ApiFailure(403, 'Organization management permission required');
      return [];
    });
    app = createFastifyApp({ APP_LOG_LEVEL: 'silent' });
    registerAuditRoutes(app, { members }, createAuditGateway(testConfig, fetcher));
    return { calls, members, get: (query = '', token: string | null = 'user-token') => app.inject({ url: `${base}/audit-events${query}`, headers: token ? { authorization: `Bearer ${token}` } : {} }) };
  }

  it('owner/admin 만 조회할 수 있다(구성원 403, 인증 없음 401)', async () => {
    const member = build('member');
    expect((await member.get()).statusCode).toBe(403);
    await app.close();
    const owner = build('owner');
    expect((await owner.get('', null)).statusCode).toBe(401);
    expect((await owner.get()).statusCode).toBe(200);
    expect(owner.members).toHaveBeenCalledWith('user-token', ORG);
    await app.close();
    expect((await build('admin').get()).statusCode).toBe(200);
  });

  it('기간·action 필터를 PostgREST 쿼리로 옮기고 최신순으로 limit+1 행을 요청한다', async () => {
    const { get, calls } = build('owner');
    const response = await get('?from=2026-10-01T00:00:00%2B09:00&to=2026-10-31T23:59:59Z&action=sale.refund&limit=20');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], next_cursor: null });
    const query = calls[0].url.searchParams;
    expect(calls[0].url.pathname).toBe('/rest/v1/audit_events');
    expect(query.get('organization_id')).toBe(`eq.${ORG}`);
    expect(query.get('order')).toBe('created_at.desc,id.desc');
    expect(query.get('limit')).toBe('21');
    expect(query.get('action')).toBe('eq.sale.refund');
    expect(query.get('and')).toBe('(created_at.gte.2026-09-30T15:00:00.000Z,created_at.lte.2026-10-31T23:59:59.000Z)');
    expect(calls[0].headers.Authorization).toBe('Bearer user-token');
  });

  it('limit 보다 행이 많으면 next_cursor 를 주고 커서로 다음 페이지를 요청한다', async () => {
    const rows = [rowAt(3), rowAt(2), rowAt(1)];
    const { get, calls } = build('owner', () => ({ body: rows }));
    const first = (await get('?limit=2')).json();
    expect(first.items.map((item: { id: string }) => item.id)).toEqual([rows[0].id, rows[1].id]);
    expect(first.next_cursor).toBe(encodeCursor(rows[1]));
    expect(decodeCursor(first.next_cursor)).toEqual({ createdAt: rows[1].created_at, id: rows[1].id });
    await get(`?limit=2&cursor=${first.next_cursor}`);
    expect(calls[1].url.searchParams.get('and')).toBe(`(or(created_at.lt.${rows[1].created_at},and(created_at.eq.${rows[1].created_at},id.lt.${rows[1].id})))`);
  });

  it('잘못된 필터·커서·limit 은 422 이고 DB 를 호출하지 않는다', async () => {
    const { get, calls } = build('owner');
    for (const query of ['?limit=0', '?limit=201', '?action=Bad Action', '?action=nodot', '?from=yesterday', '?from=2026-10-02&to=2026-10-01', '?cursor=%%%', '?extra=1', `?cursor=${Buffer.from('["x","y"]').toString('base64url')}`]) {
      expect((await get(query)).statusCode, query).toBe(422);
    }
    expect(calls).toEqual([]);
  });

  it('다른 조직의 행이 섞여 오면 503 으로 막는다', async () => {
    const { get } = build('owner', () => ({ body: [rowAt(1, '99999999-9999-4999-8999-999999999999')] }));
    expect((await get()).statusCode).toBe(503);
  });

  it('조직 ID 가 UUID 가 아니면 422', async () => {
    const { members } = build('owner');
    expect((await app.inject({ url: '/api/v1/organizations/not-a-uuid/audit-events', headers })).statusCode).toBe(422);
    expect(members).not.toHaveBeenCalled();
  });
});
