import { describe, expect, it } from 'vitest';
import { op, org, sandbox, userId } from './fixtures.js';

const DAY = '2030-01-15';
const rpc = (name: string) => `/rest/v1/rpc/${name}`;
const BASE = '/sale-daily-settlement';
const close = (over: Record<string, unknown> = {}) => ({
  id: '33333333-3333-4333-8333-333333333333', version: 1, expected_cash: 120000, counted_cash: 100000, variance: -20000, reason: '시재 확인', closed_by: userId, closed_at: '2030-01-15T10:00:00Z', adjustments: [], ...over,
});
const settlement = (over: Record<string, unknown> = {}) => ({
  organization_id: org, business_date: DAY, cash_received: 120000, cash_refunded: 0, expected_cash: 120000, card_received: 50000, card_refunded: 0,
  transfer_received: 0, transfer_refunded: 0, receipt_count: 3, refund_count: 0,
  receivables: [{ cart_id: '44444444-4444-4444-8444-444444444444', visit_id: '66666666-6666-4666-8666-666666666666', customer_id: '55555555-5555-4555-8555-555555555555', customer_name: '김고객', total_amount: 90000, received_amount: 40000, refunded_amount: 0, due_amount: 50000 }],
  is_closed: false, close: null, ...over,
});

describe('일 정산 API', () => {
  it('조직과 영업일을 RPC에 넘기고 금액을 정수 문자열로 돌려준다', async () => {
    const { send, calls, access } = sandbox(() => ({ body: settlement() }), { features: ['finance.basic'] });
    const response = await send('GET', `${BASE}?business_date=${DAY}`);
    expect(response.statusCode).toBe(200);
    expect(calls[0].path).toBe(rpc('get_sale_daily_settlement'));
    expect(calls[0].body).toEqual({ p_organization_id: org, p_business_date: DAY });
    expect(access).toEqual([{ feature: 'finance.basic', write: false }]);
    expect(response.json()).toMatchObject({ cash_received: '120000', expected_cash: '120000', is_closed: false, close: null });
    expect(response.json().receivables[0]).toMatchObject({ customer_name: '김고객', due_amount: '50000' });
  });

  it('영업일이 없거나 잘못되면 422', async () => {
    const { send, calls } = sandbox(() => ({ body: settlement() }));
    expect((await send('GET', BASE)).statusCode).toBe(422);
    expect((await send('GET', `${BASE}?business_date=2030-02-30`)).statusCode).toBe(422);
    expect((await send('GET', `${BASE}?business_date=bad`)).statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it('마감과 정정은 작업 ID·버전·확인을 함께 전달한다', async () => {
    const { send, calls } = sandbox(() => ({ body: settlement({ is_closed: true, close: close() }) }));
    const closed = await send('POST', `${BASE}/close?business_date=${DAY}`, { operation_id: op, counted_cash: '100000', reason: '  시재 확인  ', confirmed: true });
    expect(closed.statusCode).toBe(200);
    expect(calls[0].path).toBe(rpc('close_sale_daily'));
    expect(calls[0].body).toEqual({ p_organization_id: org, p_business_date: DAY, p_counted_cash: '100000', p_reason: '시재 확인', p_operation_id: op, p_confirmed: true });
    expect(closed.json().close).toMatchObject({ variance: '-20000', expected_cash: '120000', version: 1 });

    calls.length = 0;
    const adjusted = await send('POST', `${BASE}/adjustments?business_date=${DAY}`, { operation_id: op, expected_version: 3, counted_cash: '90', reason: '재확인', confirmed: true });
    expect(adjusted.statusCode).toBe(200);
    expect(calls[0].path).toBe(rpc('adjust_sale_daily_close'));
    expect(calls[0].body).toEqual({ p_organization_id: org, p_business_date: DAY, p_expected_version: 3, p_counted_cash: '90', p_reason: '재확인', p_operation_id: op, p_confirmed: true });
  });

  it('회원은 읽을 수 있지만 마감할 수 없고 기능이 없으면 모두 거부된다', async () => {
    const member = sandbox(() => ({ body: settlement() }), { role: 'member' });
    expect((await member.send('GET', `${BASE}?business_date=${DAY}`)).statusCode).toBe(200);
    member.calls.length = 0;
    expect((await member.send('POST', `${BASE}/close?business_date=${DAY}`, { operation_id: op, counted_cash: '100', reason: '마감', confirmed: true })).statusCode).toBe(403);
    expect((await member.send('POST', `${BASE}/adjustments?business_date=${DAY}`, { operation_id: op, expected_version: 1, counted_cash: '100', reason: '정정', confirmed: true })).statusCode).toBe(403);
    expect(member.calls).toEqual([]);
    const none = sandbox(() => ({ body: settlement() }), { features: [] });
    expect((await none.send('GET', `${BASE}?business_date=${DAY}`)).statusCode).toBe(403);
    expect(none.calls).toEqual([]);
  });

  it('잘못된 마감 요청은 RPC에 도달하지 않는다', async () => {
    const { send, calls } = sandbox(() => ({ body: settlement() }));
    const base = { operation_id: op, counted_cash: '10', reason: '확인', confirmed: true };
    for (const change of [{ counted_cash: '1.5' }, { counted_cash: '-1' }, { counted_cash: '007' }, { counted_cash: '1234567890123' }, { counted_cash: 10 }, { reason: '  ' }, { confirmed: false }, { extra: 1 }]) {
      expect((await send('POST', `${BASE}/close?business_date=${DAY}`, { ...base, ...change })).statusCode).toBe(422);
    }
    for (const change of [{ expected_version: 0 }, { expected_version: true }, {}]) {
      expect((await send('POST', `${BASE}/adjustments?business_date=${DAY}`, { ...base, ...change })).statusCode).toBe(422);
    }
    expect(calls).toEqual([]);
  });

  it('다른 조직·다른 영업일·마감 상태 불일치 응답은 거부한다', async () => {
    const get = (body: unknown) => sandbox(() => ({ body })).send('GET', `${BASE}?business_date=${DAY}`);
    expect((await get(settlement({ organization_id: '00000000-0000-4000-8000-000000000000' }))).statusCode).toBe(503);
    expect((await get(settlement({ business_date: '2030-01-16' }))).statusCode).toBe(503);
    expect((await get(settlement({ is_closed: true, close: null }))).statusCode).toBe(503);
    expect((await get(settlement({ is_closed: false, close: close() }))).statusCode).toBe(503);
    expect((await get(settlement({ cash_received: 1.5 }))).statusCode).toBe(503);
    expect((await get(settlement({ cash_received: 120000.0 }))).statusCode).toBe(200);
  });

  it('RPC 충돌은 409, 원문은 숨긴다', async () => {
    const { send } = sandbox(() => ({ status: 400, body: { code: 'P0001', message: 'already closed by 김고객' } }));
    const response = await send('POST', `${BASE}/close?business_date=${DAY}`, { operation_id: op, counted_cash: '1', reason: '마감', confirmed: true });
    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain('김고객');
  });
});
