import { describe, expect, it } from 'vitest';
import { bundle, cartId, customerId, draftId, line, lineId, op, org, sandbox, userId, visitId, visitRow } from './fixtures.js';

const rpc = (name: string) => `/rest/v1/rpc/${name}`;
const answer = (body: unknown) => () => ({ body });
const CART = `/visits/${visitId}/sale-cart`;

describe('방문 장바구니 API', () => {
  it('잘못된 예약 ID 필터는 DB 조회 전에 거절한다',async()=>{
    const {send,calls}=sandbox();
    expect((await send('GET','/visits?appointment_id=invalid')).statusCode).toBe(422);
    expect(calls).toEqual([]);
  });
  it('예약에서 방문을 찾을 때 조직·고객·예약 필터를 모두 사용한다',async()=>{
    const {send,calls}=sandbox(call=>({body:call.query.offset==='0'?[visitRow({appointment_id:op})]:[]}),{role:'member'});
    expect((await send('GET',`/visits?customer_id=${customerId}&appointment_id=${op}`)).statusCode).toBe(200);
    expect(calls[0].query).toMatchObject({organization_id:`eq.${org}`,customer_id:`eq.${customerId}`,appointment_id:`eq.${op}`});
  });
  it('예약 조회 응답의 조직·고객·예약이 다르면 닫힌 실패로 처리한다',async()=>{
    for(const row of [visitRow({organization_id:op,appointment_id:op}),visitRow({customer_id:op,appointment_id:op}),visitRow({appointment_id:null})]){
      const {send}=sandbox(call=>({body:call.query.offset==='0'?[row]:[]}));
      expect((await send('GET',`/visits?customer_id=${customerId}&appointment_id=${op}`)).statusCode).toBe(503);
    }
  });
  it('회원은 조회만 하고 변경은 관리자만 한다', async () => {
    const { send, calls } = sandbox((call) => call.path.endsWith('/customer_visits') ? { body: [] } : { body: bundle() }, { role: 'member' });
    expect((await send('GET', '/visits')).statusCode).toBe(200);
    calls.length = 0;
    const response = await send('POST', `/customers/${customerId}/visits`, { operation_id: op });
    expect(response.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it.each(['crm.basic', 'finance.basic'])('모든 경로가 %s 기능을 요구한다', async (missing) => {
    const { send, calls } = sandbox(answer([]), { features: ['crm.basic', 'finance.basic'].filter((feature) => feature !== missing) });
    expect((await send('GET', '/visits')).statusCode).toBe(403);
    expect((await send('GET', '/sale-cart-drafts')).statusCode).toBe(403);
    expect((await send('GET', CART)).statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it('토큰이 없으면 401', async () => {
    const { send, calls } = sandbox();
    expect((await send('GET', '/visits', undefined, null)).statusCode).toBe(401);
    expect(calls).toEqual([]);
  });

  it('조직 ID가 UUID가 아니면 422', async () => {
    const { app } = sandbox();
    const response = await app.inject({ method: 'GET', url: '/api/v1/organizations/not-a-uuid/visits', headers: { authorization: 'Bearer access' } });
    expect(response.statusCode).toBe(422);
  });

  it('방문 생성과 변경은 조직·버전·작업 ID를 RPC에 그대로 전달한다', async () => {
    const { send, calls, access } = sandbox(answer(bundle(4)));
    const created = await send('POST', `/customers/${customerId}/visits`, { operation_id: op });
    expect(created.statusCode).toBe(201);
    expect(calls[0].path).toBe(rpc('create_customer_visit'));
    expect(calls[0].body).toEqual({ p_organization_id: org, p_customer_id: customerId, p_operation_id: op });
    expect(calls[0].headers.Authorization).toBe('Bearer access');
    expect(access.every((entry) => entry.write)).toBe(true);
    expect(access.map((entry) => entry.feature)).toEqual(['crm.basic', 'finance.basic']);

    calls.length = 0;
    expect((await send('POST', `${CART}/lines/treatment-draft`, { draft_id: draftId, expected_version: 3, operation_id: op })).statusCode).toBe(200);
    expect(calls[0].path).toBe(rpc('add_treatment_draft_to_cart'));
    expect(calls[0].body).toEqual({ p_organization_id: org, p_visit_id: visitId, p_draft_id: draftId, p_expected_version: 3, p_operation_id: op });

    calls.length = 0;
    const updated = await send('PATCH', `${CART}/lines/${lineId}`, { expected_version: 4, operation_id: op, quantity: 2, unit_price: '100.25', staff_id: null, staff_name: '담당자' });
    expect(updated.statusCode).toBe(200);
    expect(calls[0].path).toBe(rpc('mutate_sale_cart_line'));
    expect(calls[0].body).toEqual({
      p_organization_id: org, p_visit_id: visitId, p_line_id: lineId, p_expected_version: 4, p_operation_id: op, p_action: 'update',
      p_values: { quantity: 2, unit_price: '100.25', staff_id: null, staff_name: '담당자' },
    });

    calls.length = 0;
    await send('POST', `${CART}/lines/${lineId}/remove`, { expected_version: 1, operation_id: op, reason: '  중복 담김  ' });
    expect(calls[0].body).toMatchObject({ p_action: 'remove', p_values: { reason: '중복 담김' } });
    calls.length = 0;
    await send('POST', `${CART}/lines/${lineId}/restore`, { expected_version: 1, operation_id: op });
    expect(calls[0].body).toMatchObject({ p_action: 'restore', p_values: {} });
    calls.length = 0;
    await send('POST', `${CART}/review`, { expected_version: 2, operation_id: op, ready: true });
    expect(calls[0].path).toBe(rpc('review_sale_cart'));
    expect(calls[0].body).toEqual({ p_organization_id: org, p_visit_id: visitId, p_expected_version: 2, p_operation_id: op, p_ready: true });
    calls.length = 0;
    await send('POST', `/visits/${visitId}/cancel`, { expected_version: 1, operation_id: op });
    expect(calls[0].path).toBe(rpc('cancel_customer_visit'));
    expect(calls[0].body).toEqual({ p_organization_id: org, p_visit_id: visitId, p_expected_version: 1, p_operation_id: op });
  });

  it('PATCH는 보낸 필드만 전달하고 하나도 없으면 거절한다', async () => {
    const { send, calls } = sandbox(answer(bundle()));
    await send('PATCH', `${CART}/lines/${lineId}`, { expected_version: 1, operation_id: op, quantity: 3 });
    expect(calls[0].body).toMatchObject({ p_values: { quantity: 3 } });
    expect(Object.keys((calls[0].body as { p_values: object }).p_values)).toEqual(['quantity']);
    calls.length = 0;
    expect((await send('PATCH', `${CART}/lines/${lineId}`, { expected_version: 1, operation_id: op })).statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it('수당 배분은 합계 100%와 서로 다른 직원만 RPC에 전달한다', async () => {
    const { send, calls } = sandbox(answer(bundle()));
    const allocations = [{ staff_id: userId, share_basis_points: 6000 }, { staff_id: draftId, share_basis_points: 4000 }];
    const response = await send('PATCH', `${CART}/lines/${lineId}`, { expected_version: 1, operation_id: op, staff_id: userId, staff_name: '주 담당', commission_allocations: allocations });
    expect(response.statusCode).toBe(200);
    expect(calls[0].body).toMatchObject({ p_values: { commission_allocations: allocations } });
    for (const commission_allocations of [
      [{ staff_id: userId, share_basis_points: 6000 }],
      [{ staff_id: userId, share_basis_points: 6000 }, { staff_id: userId, share_basis_points: 4000 }],
      Array.from({ length: 11 }, (_, index) => ({ staff_id: `${String(index + 1).padStart(8, '0')}-0000-4000-8000-000000000000`, share_basis_points: index === 10 ? 0 : 1000 })),
    ]) {
      calls.length = 0;
      expect((await send('PATCH', `${CART}/lines/${lineId}`, { expected_version: 1, operation_id: op, commission_allocations })).statusCode).toBe(422);
      expect(calls).toEqual([]);
    }
  });

  it('수동 할인은 확인·유효한 값·관리자를 요구한다', async () => {
    const body = { kind: 'percent', value: '15', reason: '첫 방문', expected_version: 2, operation_id: op, confirmed: true };
    const { send, calls } = sandbox(answer(bundle()));
    expect((await send('POST', `${CART}/discount`, body)).statusCode).toBe(200);
    expect(calls[0].path).toBe(rpc('apply_sale_cart_discount'));
    expect(calls[0].body).toEqual({ p_organization_id: org, p_visit_id: visitId, p_kind: 'percent', p_value: '15', p_reason: '첫 방문', p_expected_version: 2, p_operation_id: op, p_confirmed: true });
    for (const change of [{ value: '100' }, { value: '101' }, { value: '0' }, { confirmed: false }, { reason: ' ' }, { kind: 'amount', value: '0' }, { kind: 'none', value: '5' }, { value: '1.5' }, { extra: 1 }]) {
      calls.length = 0;
      expect((await send('POST', `${CART}/discount`, { ...body, ...change })).statusCode).toBe(422);
      expect(calls).toEqual([]);
    }
    const none = sandbox(answer(bundle()));
    expect((await none.send('POST', `${CART}/discount`, { ...body, kind: 'none', value: '0' })).statusCode).toBe(200);
    const member = sandbox(answer(bundle()), { role: 'member' });
    expect((await member.send('POST', `${CART}/discount`, body)).statusCode).toBe(403);
    expect(member.calls).toEqual([]);
  });

  it.each([
    [{ code: 'P0001' }, 409, 'conflict'],
    [{ code: '23505' }, 409, 'conflict'],
    [{ code: 'P0002' }, 404, 'not found'],
    [{ code: '42501' }, 403, 'permission'],
    [{ code: '22023', message: 'secret' }, 422, 'invalid'],
    [{ code: '23514' }, 422, 'invalid'],
    [{ code: '22P02' }, 422, 'invalid'],
    [{ code: 'XX000', message: 'secret SQL detail' }, 503, 'unavailable'],
  ])('RPC 오류 %j 를 %i 로 바꾸고 원문을 숨긴다', async (failure, status, word) => {
    const { send } = sandbox(() => ({ status: 400, body: { ...failure, details: 'customer 김고객' } }));
    const response = await send('POST', `/customers/${customerId}/visits`, { operation_id: op });
    expect(response.statusCode).toBe(status);
    expect(response.json().detail.toLowerCase()).toContain(word);
    expect(response.body).not.toContain('secret');
    expect(response.body).not.toContain('김고객');
  });

  it('코드 없는 업스트림 오류와 깨진 응답은 503, 만료 토큰은 401', async () => {
    expect((await sandbox(() => ({ status: 500, body: { message: 'boom' } })).send('GET', CART)).statusCode).toBe(503);
    expect((await sandbox(() => ({ status: 401, body: {} })).send('GET', CART)).statusCode).toBe(401);
    expect((await sandbox(answer({ nope: true })).send('GET', CART)).statusCode).toBe(503);
  });

  it.each([true, '2', 1.5, null, 0])('expected_version %j 는 거절한다', async (value) => {
    const { send, calls } = sandbox(answer(bundle()));
    expect((await send('POST', `${CART}/review`, { expected_version: value, operation_id: op, ready: true })).statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it.each([
    ['quantity', true], ['quantity', '2'], ['quantity', null], ['quantity', 0], ['quantity', 1000], ['unit_price', null], ['unit_price', '1.001'], ['unit_price', 'NaN'],
    ['unit_price', 100], ['unit_price', '-1'], ['staff_name', null], ['staff_name', 'x'.repeat(201)], ['staff_id', 'nope'],
  ])('잘못된 라인 입력 %s=%j 는 RPC에 도달하지 않는다', async (field, value) => {
    const { send, calls } = sandbox(answer(bundle()));
    expect((await send('PATCH', `${CART}/lines/${lineId}`, { expected_version: 1, operation_id: op, [field]: value })).statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it('공백뿐인 제거 사유를 거절한다', async () => {
    const { send, calls } = sandbox(answer(bundle()));
    expect((await send('POST', `${CART}/lines/${lineId}/remove`, { expected_version: 1, operation_id: op, reason: '   ' })).statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it('시술 초안 목록은 문서 편집 기능 없이 CRM·재무 권한으로 읽고 내부 필드를 노출하지 않는다', async () => {
    const draft = { id: draftId, organization_id: org, customer_id: customerId, treatment_id: lineId, status: 'draft', description: '보톡스', amount: 150000, source_snapshot: {}, created_by: userId, created_at: '2030-01-01T00:00:00Z', operation_id: op, fingerprint: 'x' };
    const { send, calls, access } = sandbox((call) => ({ body: call.query.offset === '0' ? [draft] : [] }), { role: 'member' });
    const response = await send('GET', '/sale-cart-drafts');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ ...draft, amount: '150000.00', operation_id: undefined, fingerprint: undefined }].map((row) => JSON.parse(JSON.stringify(row))));
    expect(access.map((entry) => entry.feature)).toEqual(['crm.basic', 'finance.basic']);
    expect(calls[0].query).toMatchObject({ organization_id: `eq.${org}`, status: 'eq.draft' });
    expect(calls[0].query.select).not.toContain('operation_id');
  });

  it('방문 목록은 조직·고객·상태로 거르고 페이지를 끝까지 읽는다', async () => {
    const second = visitRow({ id: '11111111-1111-4111-8111-111111111111' });
    const { send, calls } = sandbox((call) => ({ body: call.query.offset === '0' ? [visitRow()] : call.query.offset === '1' ? [second] : [] }));
    const response = await send('GET', `/visits?customer_id=${customerId}&status=open`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(2);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.path === '/rest/v1/customer_visits' && call.query.organization_id === `eq.${org}` && call.query.customer_id === `eq.${customerId}` && call.query.status === 'eq.open')).toBe(true);
    expect((await send('GET', '/visits?status=bogus')).statusCode).toBe(422);
  });

  it('다른 조직 행이나 중복 행은 서버 오류로 취급한다', async () => {
    const other = sandbox(() => ({ body: [visitRow({ organization_id: '00000000-0000-4000-8000-000000000000' })] }));
    expect((await other.send('GET', '/visits')).statusCode).toBe(503);
    const duplicate = sandbox((call) => ({ body: call.query.offset === '0' || call.query.offset === '1' ? [visitRow()] : [] }));
    expect((await duplicate.send('GET', '/visits')).statusCode).toBe(503);
  });

  it('장바구니 조회는 방문·조직 불일치를 거부하고 금액을 문자열로 정규화한다', async () => {
    const ok = bundle(2, { cart: { subtotal: 12000.5, discount_total: 0, total_amount: 12000.5, discount_value: 10 }, lines: [line({ unit_price: 6000.25, line_total: 12000.5, quantity: 2 })] });
    const good = sandbox(answer(ok));
    const response = await good.send('GET', CART);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.cart).toMatchObject({ subtotal: '12000.50', discount_total: '0.00', total_amount: '12000.50', discount_kind: 'none', discount_value: '10' });
    expect(body.lines[0]).toMatchObject({ unit_price: '6000.25', line_total: '12000.50' });
    expect(good.calls[0].body).toEqual({ p_organization_id: org, p_visit_id: visitId });
    const wrongVisit = bundle();
    wrongVisit.cart.visit_id = '22222222-2222-4222-8222-222222222222';
    expect((await sandbox(answer(wrongVisit)).send('GET', CART)).statusCode).toBe(503);
    const wrongOrg = bundle();
    wrongOrg.cart.organization_id = '22222222-2222-4222-8222-222222222222';
    expect((await sandbox(answer(wrongOrg)).send('GET', CART)).statusCode).toBe(503);
    const wrongLine = bundle(1, { lines: [line({ cart_id: '22222222-2222-4222-8222-222222222222' })] });
    expect((await sandbox(answer(wrongLine)).send('GET', CART)).statusCode).toBe(503);
    const badMoney = bundle(1, { cart: { total_amount: '1.001' } });
    expect((await sandbox(answer(badMoney)).send('GET', CART)).statusCode).toBe(503);
  });
});
