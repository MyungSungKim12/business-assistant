import { describe, expect, it } from 'vitest';
import { cartId, op, org, payments, sandbox, visitId } from './fixtures.js';

const rpc = (name: string) => `/rest/v1/rpc/${name}`;
const PAY = `/visits/${visitId}/payments`;
const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const payload = () => ({
  expected_version: 3, operation_id: op, confirmed: true,
  payments: [{ method: 'card', amount: '70000', reference: 'approval-1' }, { method: 'cash', amount: '30000', reference: '' }],
});
const receipt = (over: Record<string, unknown> = {}) => ({ id: id(1), method: 'cash', amount: '30000', reference: '', received_at: '2030-01-01T00:00:00Z', operation_id: op, ...over });

describe('방문 수납 API', () => {
  it('복합 수납을 조직·버전·작업 ID와 함께 한 번의 RPC로 기록한다', async () => {
    const { send, calls } = sandbox(() => ({ body: payments() }));
    const response = await send('POST', PAY, payload());
    expect(response.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe(rpc('record_visit_payment'));
    expect(calls[0].body).toEqual({
      p_organization_id: org, p_visit_id: visitId, p_expected_version: 3, p_operation_id: op, p_confirmed: true,
      p_payments: [{ method: 'card', amount: '70000', reference: 'approval-1' }, { method: 'cash', amount: '30000', reference: '' }],
    });
    expect(response.json()).toMatchObject({ total_amount: '100000', paid_amount: '0', outstanding_amount: '100000', currency: 'KRW', refunds: [], refunded_amount: '0' });
  });

  it('승인번호는 공백을 제거해 보내고 현금 메모는 선택이다', async () => {
    const { send, calls } = sandbox(() => ({ body: payments() }));
    const body = payload();
    body.payments = [{ method: 'transfer', amount: '10', reference: '  T-1  ' }, { method: 'cash', amount: '5' } as never];
    expect((await send('POST', PAY, body)).statusCode).toBe(200);
    expect((calls[0].body as { p_payments: unknown }).p_payments).toEqual([{ method: 'transfer', amount: '10', reference: 'T-1' }, { method: 'cash', amount: '5', reference: '' }]);
  });

  it('회원은 조회만 하고 수납은 관리자만 한다', async () => {
    const { send, calls } = sandbox(() => ({ body: payments() }), { role: 'member' });
    expect((await send('GET', PAY)).statusCode).toBe(200);
    expect(calls[0].path).toBe(rpc('get_visit_payments'));
    expect(calls[0].body).toEqual({ p_organization_id: org, p_visit_id: visitId });
    calls.length = 0;
    expect((await send('POST', PAY, payload())).statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it.each([[[]], [['finance.basic']], [['crm.basic']]])('두 기능이 모두 필요하다 %j', async (features) => {
    const { send, calls } = sandbox(() => ({ body: payments() }), { features });
    expect((await send('POST', PAY, payload())).statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it.each(['0', '-1', '0.01', 'NaN', '1e3', '01', 100, null, '1000000000000', ''])('금액 %j 는 RPC에 도달하지 않는다', async (amount) => {
    const { send, calls } = sandbox(() => ({ body: payments() }));
    const body = payload();
    (body.payments[0] as { amount: unknown }).amount = amount;
    expect((await send('POST', PAY, body)).statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it.each(['unconfirmed', 'missing_reference', 'duplicate', 'bool_version', 'empty', 'four', 'extra_field', 'bad_method'])('잘못된 계약 %s 는 RPC에 도달하지 않는다', async (change) => {
    const { send, calls } = sandbox(() => ({ body: payments() }));
    const body: Record<string, unknown> & ReturnType<typeof payload> = payload();
    if (change === 'unconfirmed') body.confirmed = false;
    else if (change === 'missing_reference') body.payments[0].reference = '   ';
    else if (change === 'duplicate') body.payments.push(body.payments[0]);
    else if (change === 'bool_version') body.expected_version = true as never;
    else if (change === 'empty') body.payments = [];
    else if (change === 'four') body.payments = [1, 2, 3, 4].map(() => ({ method: 'cash', amount: '1', reference: '' }));
    else if (change === 'extra_field') body.organization_id = org;
    else (body.payments[0] as { method: string }).method = 'wallet';
    expect((await send('POST', PAY, body)).statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it('충돌은 안전한 409, 같은 작업 ID 재전송도 RPC 결과를 그대로 돌려준다', async () => {
    const conflict = sandbox(() => ({ status: 400, body: { code: 'P0001', message: 'stale version 3' } }));
    const response = await conflict.send('POST', PAY, payload());
    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain('stale version');
    const replay = sandbox(() => ({ body: payments({ paid_amount: '100000', outstanding_amount: '0', status: 'paid', receipts: [receipt({ amount: '100000' })] }) }));
    const first = await replay.send('POST', PAY, payload());
    const second = await replay.send('POST', PAY, payload());
    expect(first.json()).toEqual(second.json());
    expect(replay.calls.map((call) => (call.body as { p_operation_id: string }).p_operation_id)).toEqual([op, op]);
  });

  it('잔액이 맞지 않는 응답은 닫힌 채로 실패한다', async () => {
    for (const change of [{ paid_amount: '10' }, { refunded_amount: '5' }, { outstanding_amount: '1' }]) {
      const { send } = sandbox(() => ({ body: payments(change) }));
      expect((await send('GET', PAY)).statusCode).toBe(503);
    }
    const other = sandbox(() => ({ body: payments({ visit_id: id(2) }) }));
    expect((await other.send('GET', PAY)).statusCode).toBe(503);
  });

  it('회원권 사용(wallet)도 수납액으로 인정하고 환불 합계를 대조한다', async () => {
    const refund = { id: id(3), source_id: id(1), source_kind: 'wallet_usage', amount: '10000', reason: '취소', created_at: '2030-01-02T00:00:00Z', operation_id: op };
    const { send } = sandbox(() => ({
      body: payments({ paid_amount: '20000', outstanding_amount: '80000', refunded_amount: '10000', status: 'collecting', receipts: [receipt({ method: 'wallet', amount: 30000 })], refunds: [refund] }),
    }));
    const response = await send('GET', PAY);
    expect(response.statusCode).toBe(200);
    expect(response.json().receipts[0]).toMatchObject({ method: 'wallet', amount: '30000' });
  });

  it('환불은 원거래·사유·확인·관리자를 요구한다', async () => {
    const body = { source_id: id(1), amount: '30000', reason: '  고객 요청  ', expected_version: 3, operation_id: op, confirmed: true };
    const { send, calls } = sandbox(() => ({ body: payments() }));
    expect((await send('POST', `${PAY}/refunds`, body)).statusCode).toBe(200);
    expect(calls[0].path).toBe(rpc('refund_visit_payment'));
    expect(calls[0].body).toEqual({
      p_organization_id: org, p_visit_id: visitId, p_source_id: id(1), p_amount: '30000', p_reason: '고객 요청', p_expected_cart_version: 3, p_operation_id: op, p_confirmed: true,
    });
    const member = sandbox(() => ({ body: payments() }), { role: 'member' });
    expect((await member.send('POST', `${PAY}/refunds`, body)).statusCode).toBe(403);
    for (const change of [{ amount: '0' }, { reason: ' ' }, { confirmed: false }, { source_id: 'x' }, { amount: '1.5' }]) {
      calls.length = 0;
      expect((await send('POST', `${PAY}/refunds`, { ...body, ...change })).statusCode).toBe(422);
      expect(calls).toEqual([]);
    }
  });

  it('상품 반품은 수량·원결제·재입고 선택·관리자를 요구한다', async () => {
    const body = { sale_line_id: id(4), receipt_id: id(5), quantity: 1, restock: true, amount: '12000', reason: '미개봉 반품', expected_version: 3, operation_id: op, confirmed: true };
    const { send, calls } = sandbox(() => ({ body: payments() }));
    expect((await send('POST', `${PAY}/product-returns`, body)).statusCode).toBe(200);
    expect(calls[0].path).toBe(rpc('return_visit_product'));
    expect(calls[0].body).toEqual({
      p_organization_id: org, p_visit_id: visitId, p_sale_line_id: id(4), p_receipt_id: id(5), p_quantity: 1, p_restock: true, p_amount: '12000',
      p_reason: '미개봉 반품', p_expected_cart_version: 3, p_operation_id: op, p_confirmed: true,
    });
    const member = sandbox(() => ({ body: payments() }), { role: 'member' });
    expect((await member.send('POST', `${PAY}/product-returns`, body)).statusCode).toBe(403);
    for (const change of [{ quantity: 0 }, { quantity: 1000 }, { restock: 'yes' }, { amount: '0' }, { confirmed: false }, { receipt_id: undefined }]) {
      calls.length = 0;
      expect((await send('POST', `${PAY}/product-returns`, { ...body, ...change })).statusCode).toBe(422);
      expect(calls).toEqual([]);
    }
  });

  it('cart_id는 응답에 그대로 노출되고 숫자 금액도 정수 문자열로 돌려준다', async () => {
    const { send } = sandbox(() => ({ body: payments({ total_amount: 100000.0, paid_amount: 0, outstanding_amount: 100000 }) }));
    const body = (await send('GET', PAY)).json();
    expect(body).toMatchObject({ cart_id: cartId, total_amount: '100000', paid_amount: '0', outstanding_amount: '100000' });
  });
});
