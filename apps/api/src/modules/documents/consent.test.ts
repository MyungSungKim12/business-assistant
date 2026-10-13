import { describe, expect, it } from 'vitest';
import { auth, build, CUSTOMER, deliver, DOCUMENT, event, expectNoLeak, ORG, OPERATION, revoke, sign, TREATMENT, treatmentPath, USER } from './testkit.js';

const path = treatmentPath(`documents/${DOCUMENT}/events`);
const body = { expected_revision: 0, operation_id: OPERATION, action: 'sign', values: sign };
const post = (app: ReturnType<typeof build>['app'], payload: unknown, headers: Record<string, string> = auth) => app.inject({ method: 'POST', url: path, headers, payload: payload as never });
const respondEvents = (events: unknown[]) => (call: { url: URL }) => ({ body: call.url.pathname.endsWith('issued_treatment_documents') ? [{ id: DOCUMENT }] : events });

describe('동의서 서명·교부·철회', () => {
  it.each(['GET', 'POST'] as const)('%s 는 인증·멤버십·두 기능을 모두 요구한다', async (method) => {
    const init = { method, url: path, payload: method === 'POST' ? (body as never) : undefined };
    expect((await build().app.inject(init)).statusCode).toBe(401);
    expect((await build().app.inject({ ...init, headers: { authorization: 'Bearer outsider' } })).statusCode).toBe(403);
    for (const features of [['crm.basic'], ['document.template']]) expect((await build({ features }).app.inject({ ...init, headers: auth })).statusCode).toBe(403);
  });

  it('멤버는 증빙을 읽지만 기록할 수 없다', async () => {
    const { app, calls } = build({ role: 'member', respond: respondEvents([event]) });
    expect((await app.inject({ url: path, headers: auth })).statusCode).toBe(200);
    const reads = calls.length;
    expect((await post(app, body)).statusCode).toBe(403);
    expect(calls).toHaveLength(reads);
  });

  it.each([['owner', 'sign', sign], ['admin', 'deliver', deliver], ['owner', 'revoke', revoke]] as const)('%s 의 %s 기록은 정확한 RPC 페이로드로 전달되고 재시도 메타데이터를 숨긴다', async (role, action, values) => {
    const { app, calls } = build({ role, respond: () => ({ body: [{ ...event, action, values }] }) });
    const result = await post(app, { ...body, action, values, expected_revision: 4 });
    expect(result.statusCode).toBe(201);
    expectNoLeak(result.body);
    expect(calls[0].url.pathname).toBe('/rest/v1/rpc/record_treatment_document_event');
    expect(calls[0].body).toEqual({
      p_organization_id: ORG, p_customer_id: CUSTOMER, p_treatment_id: TREATMENT, p_document_id: DOCUMENT, p_expected_revision: 4, p_operation_id: OPERATION, p_action: action, p_values: values,
    });
  });

  it('이력은 상위 발행본을 정확히 확인하고 revision 순서대로 읽는다', async () => {
    const { app, calls } = build({ respond: respondEvents([event]) });
    const result = await app.inject({ url: path, headers: auth });
    expect(result.statusCode).toBe(200);
    expectNoLeak(result.body);
    expect(calls[0].url.pathname).toBe('/rest/v1/issued_treatment_documents');
    expect(calls[0].url.searchParams.get('id')).toBe(`eq.${DOCUMENT}`);
    expect(calls[1].url.searchParams.get('order')).toBe('revision.asc');
    expect(calls[1].url.searchParams.get('document_id')).toBe(`eq.${DOCUMENT}`);
  });

  it('250건 단위로 여러 페이지를 읽고 마지막 철회까지 포함한다', async () => {
    const make = (revision: number) => ({ ...event, revision, action: revision === 251 ? 'revoke' : 'deliver', values: revision === 251 ? revoke : deliver });
    const { app, calls } = build({
      respond: (call) => {
        if (call.url.pathname.endsWith('issued_treatment_documents')) return { body: [{ id: DOCUMENT }] };
        const offset = Number(call.url.searchParams.get('offset'));
        return { body: Array.from({ length: offset === 0 ? 250 : 1 }, (_value, index) => make(offset + index + 1)) };
      },
    });
    const result = await app.inject({ url: path, headers: auth });
    expect(result.json()).toHaveLength(251);
    expect(result.json()[250].action).toBe('revoke');
    expect(calls.map((call) => call.url.searchParams.get('offset'))).toEqual([null, '0', '250']);
  });

  it('상위 발행본이 없거나 다른 조직이면 이력 조회를 멈추고 404', async () => {
    const missing = build({ respond: () => ({ body: [] }) });
    expect((await missing.app.inject({ url: path, headers: auth })).statusCode).toBe(404);
    expect(missing.calls).toHaveLength(1);
    const other = build();
    const response = await other.app.inject({ url: path.replace(ORG, '88888888-8888-4888-8888-888888888888'), headers: auth });
    expect(response.statusCode).toBe(403);
    expect(other.calls).toEqual([]);
  });

  it('revision 이 끊기거나 중복이면 안전한 503', async () => {
    expect((await build({ respond: respondEvents([{ ...event, revision: 2 }]) }).app.inject({ url: path, headers: auth })).statusCode).toBe(503);
  });

  it.each([
    [{ expected_revision: -1 }], [{ expected_revision: true }], [{ expected_revision: '0' }], [{ expected_revision: 0.5 }], [{ expected_revision: 2147483648 }],
    [{ operation_id: 'bad' }], [{ action: 'SIGN' }], [{ action: 'unknown' }], [{ values: {} }], [{ values: null }], [{ values: [] }], [{ extra: 'forged' }],
  ])('잘못된 봉투 %j 는 RPC 전에 422', async (changes) => {
    const { app, calls } = build();
    expect((await post(app, { ...body, ...changes })).statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it.each(['expected_revision', 'operation_id', 'action', 'values'])('%s 가 빠지면 422', async (key) => {
    const { app, calls } = build();
    expect((await post(app, Object.fromEntries(Object.entries(body).filter(([name]) => name !== key)))).statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it.each([['sign', sign], ['deliver', deliver], ['revoke', revoke]] as const)('%s 값은 모든 필드가 필요하다', async (action, values) => {
    const { app, calls } = build();
    for (const omitted of Object.keys(values)) {
      const incomplete = Object.fromEntries(Object.entries(values).filter(([name]) => name !== omitted));
      expect((await post(app, { ...body, action, values: incomplete })).statusCode).toBe(422);
    }
    expect(calls).toEqual([]);
  });

  it('최대 그림(50획·5000점)은 허용하고 같은 재시도 요청은 같은 RPC 본문을 보낸다', async () => {
    const values = { ...sign, strokes: Array.from({ length: 10 }, () => Array.from({ length: 500 }, (_v, index) => [index % 2, index % 2])) };
    const { app, calls } = build({ respond: () => ({ body: [event] }) });
    const first = await post(app, { ...body, values });
    const retry = await post(app, { ...body, values });
    expect(first.statusCode).toBe(201);
    expect(first.body).toBe(retry.body);
    const rpcCalls = calls.filter((call) => call.url.pathname.endsWith('/rpc/record_treatment_document_event'));
    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls[0].body).toEqual(rpcCalls[1].body);
    expect((rpcCalls[0].body as { p_values: unknown }).p_values).toEqual(values);
  });

  const stroke = [[0, 0], [1, 1]];
  it.each([
    [{ ...sign, signer_name: ' ' }], [{ ...sign, signer_name: 'x'.repeat(101) }], [{ ...sign, confirmed: false }], [{ ...sign, confirmed: 1 }], [{ ...sign, confirmed: 'true' }],
    [{ ...sign, extra: 'forged' }], [{ ...sign, strokes: [] }], [{ ...sign, strokes: [[]] }], [{ ...sign, strokes: [[[0, 0]]] }], [{ ...sign, strokes: [[[0, 0], [0, 0]]] }],
    [{ ...sign, strokes: [[[false, 0], [1, 1]]] }], [{ ...sign, strokes: [[['0', 0], [1, 1]]] }], [{ ...sign, strokes: [[[0, -0.1], [1, 1]]] }], [{ ...sign, strokes: [[[0, 0], [1.1, 1]]] }],
    [{ ...sign, strokes: [[[0, 0, 0], [1, 1]]] }], [{ ...sign, strokes: Array.from({ length: 51 }, () => stroke) }],
    [{ ...sign, strokes: [Array.from({ length: 251 }, (_v, index) => stroke[index % 2]).concat([[0, 0]]).concat(Array.from({ length: 250 }, () => [1, 1]))] }],
    [{ ...sign, strokes: Array.from({ length: 11 }, () => Array.from({ length: 500 }, (_v, index) => stroke[index % 2])) }],
  ])('잘못된 서명 값은 RPC 전에 422', async (values) => {
    const { app, calls } = build();
    expect((await post(app, { ...body, values })).statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it.each([
    ['deliver', { ...deliver, method: 'fax' }], ['deliver', { ...deliver, recipient: ' ' }], ['deliver', { ...deliver, recipient: 'x'.repeat(201) }], ['deliver', { ...deliver, reference: 'x'.repeat(501) }],
    ['deliver', { ...deliver, note: 'x'.repeat(2001) }], ['deliver', { ...deliver, confirmed: 1 }], ['deliver', { ...deliver, reference: null }], ['deliver', sign],
    ['revoke', { ...revoke, reason: ' ' }], ['revoke', { ...revoke, reason: 'x'.repeat(2001) }], ['revoke', { ...revoke, confirmed: 1 }], ['revoke', { ...revoke, extra: 'forged' }],
  ])('잘못된 %s 값은 RPC 전에 422', async (action, values) => {
    const { app, calls } = build();
    expect((await post(app, { ...body, action, values })).statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it.each(['GET', 'POST'] as const)('%s: DB 오류는 안전한 상태로 매핑되고 환자 정보를 숨긴다', async (method) => {
    for (const [code, status] of [['P0001', 409], ['P0002', 404], ['42501', 403], ['22023', 422], ['XX000', 503]] as const) {
      const { app } = build({ respond: () => ({ status: 400, body: { code, message: 'private patient data' } }) });
      const result = await app.inject({ method, url: path, headers: auth, payload: method === 'POST' ? (body as never) : undefined });
      expect(result.statusCode).toBe(status);
      expect(result.body).not.toContain('private');
    }
  });

  it.each([[{}], [[]], [[event, event]], [[{ id: 'bad' }]]])('기록 응답은 정확히 유효한 이벤트 1건이어야 한다 %j', async (payload) => {
    expect((await post(build({ respond: () => ({ body: payload }) }).app, body)).statusCode).toBe(503);
  });

  it.each([[{}], [[{ id: 'bad' }]], [[null]]])('깨진 이력 응답은 안전한 503 %j', async (payload) => {
    expect((await build({ respond: respondEvents(payload as never) }).app.inject({ url: path, headers: auth })).statusCode).toBe(503);
  });

  it.each([[{}], [[null]], [[{ id: 'bad' }]], [[{ id: DOCUMENT }, { id: DOCUMENT }]]])('깨진 상위 응답은 안전한 503 %j', async (parent) => {
    expect((await build({ respond: () => ({ body: parent }) }).app.inject({ url: path, headers: auth })).statusCode).toBe(503);
  });

  it('서명 데이터는 응답 외에 로그·오류 본문으로 새지 않는다', async () => {
    const { app } = build({ respond: () => ({ status: 400, body: { code: 'XX000', message: JSON.stringify(sign) } }) });
    const result = await post(app, body);
    expect(result.body).not.toContain('Customer A');
    expect(USER).toBeTruthy();
  });
});
