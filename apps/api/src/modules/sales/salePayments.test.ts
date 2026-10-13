import { describe, expect, it } from 'vitest';
import { cartId, customerId, org, sandbox, visitId } from './fixtures.js';
import { decodeSaleCursor, encodeSaleCursor } from './schemas.js';

const rpc = '/rest/v1/rpc/list_sale_payments';
const ROW = '11111111-1111-4111-8111-111111111111';
const ROW2 = '22222222-2222-4222-8222-222222222222';
const row = (over: Record<string, unknown> = {}) => ({
  id: ROW, kind: 'payment', method: 'card', amount: 60000, occurred_at: '2030-01-10T02:00:00.123456+00:00', reference: 'A-1', reason: '',
  cart_id: cartId, visit_id: visitId, customer_id: customerId, customer_name: '김고객', ...over,
});
const totals = (over: Record<string, unknown> = {}) => ({ payment_total: 60000, refund_total: 10000, net_total: 50000, payment_count: 1, refund_count: 1, row_count: 2, ...over });
const result = (rows: unknown[] = [row()], cursor: unknown = null, over: Record<string, unknown> = {}) => ({ rows, next_cursor: cursor, totals: totals(over) });

describe('수납·환불 내역 검색 API', () => {
  it('조건을 RPC 인자로 넘기고 금액을 문자열로, 합계를 함께 돌려준다', async () => {
    const { send, calls, access } = sandbox(() => ({ body: result() }), { role: 'member', features: ['finance.basic'] });
    const response = await send('GET', `/sale-payments?from_date=2030-01-01&to_date=2030-01-31&customer_id=${customerId}&method=card&kind=payment&min_amount=1000&max_amount=90000&sort=oldest&limit=20`);
    expect(response.statusCode).toBe(200);
    expect(access).toEqual([{ feature: 'finance.basic', write: false }]);
    expect(calls[0].path).toBe(rpc);
    expect(calls[0].body).toEqual({
      p_organization_id: org, p_from_date: '2030-01-01', p_to_date: '2030-01-31', p_customer_id: customerId, p_method: 'card', p_kind: 'payment',
      p_min_amount: '1000', p_max_amount: '90000', p_sort: 'oldest', p_limit: 20, p_cursor_at: null, p_cursor_id: null,
    });
    const body = response.json();
    expect(body.rows[0]).toMatchObject({ kind: 'payment', method: 'card', amount: '60000', customer_name: '김고객' });
    expect(body.totals).toEqual({ payment_total: '60000', refund_total: '10000', net_total: '50000', payment_count: 1, refund_count: 1, row_count: 2 });
    expect(body.next_cursor).toBeNull();
  });

  it('조건이 없으면 기본값(최신순 50건)을 쓴다', async () => {
    const { send, calls } = sandbox(() => ({ body: result([]) }));
    expect((await send('GET', '/sale-payments')).statusCode).toBe(200);
    expect(calls[0].body).toMatchObject({ p_sort: 'newest', p_limit: 50, p_method: null, p_kind: null, p_customer_id: null });
  });

  it('다음 커서는 불투명 문자열로 내보내고, 되돌려 받으면 시각·id를 그대로 RPC에 넘긴다', async () => {
    const next = { occurred_at: '2030-01-10T02:00:00.123456+00:00', id: ROW2 };
    const first = sandbox(() => ({ body: result([row()], next) }));
    const cursor = (await first.send('GET', '/sale-payments')).json().next_cursor as string;
    expect(typeof cursor).toBe('string');
    expect(cursor).not.toContain(ROW2);
    expect(decodeSaleCursor(cursor)).toEqual(next);
    const second = sandbox(() => ({ body: result([]) }));
    await second.send('GET', `/sale-payments?cursor=${cursor}`);
    expect(second.calls[0].body).toMatchObject({ p_cursor_at: next.occurred_at, p_cursor_id: ROW2 });
  });

  it('잘못된 조건은 RPC 호출 없이 422', async () => {
    const { send, calls } = sandbox(() => ({ body: result() }));
    const bad = [
      'from_date=2030-02-01&to_date=2030-01-01', 'from_date=x', 'customer_id=abc', 'method=gift', 'kind=other', 'sort=amount',
      'min_amount=-1', 'min_amount=1.5', 'max_amount=abc', 'min_amount=500&max_amount=100', 'limit=0', 'limit=201', 'limit=abc',
      'cursor=not-a-cursor', `cursor=${encodeSaleCursor({ occurred_at: 'nonsense', id: ROW })}`,
    ];
    for (const query of bad) expect((await send('GET', `/sale-payments?${query}`)).statusCode, query).toBe(422);
    expect(calls).toEqual([]);
  });

  it('인증·기능이 없으면 거부하고, 공급자 오류는 안전한 메시지로 바꾼다', async () => {
    const { send, calls } = sandbox(() => ({ body: result() }));
    expect((await send('GET', '/sale-payments', undefined, null)).statusCode).toBe(401);
    expect((await send('GET', '/sale-payments', undefined, 'outsider')).statusCode).toBe(403);
    expect(calls).toEqual([]);
    expect((await sandbox(() => ({ body: result() }), { features: [] }).send('GET', '/sale-payments')).statusCode).toBe(403);
    const denied = sandbox(() => ({ status: 403, body: { code: '42501', message: 'secret' } }));
    expect((await denied.send('GET', '/sale-payments')).statusCode).toBe(403);
    const invalid = sandbox(() => ({ status: 400, body: { code: '22023', message: 'secret' } }));
    expect((await invalid.send('GET', '/sale-payments')).statusCode).toBe(422);
    const down = sandbox(() => ({ status: 500, body: { message: 'secret' } }));
    const failed = await down.send('GET', '/sale-payments');
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain('secret');
  });

  it('형식이 맞지 않는 응답은 서버 오류로 본다', async () => {
    const broken = [
      { rows: [row({ kind: 'gift' })], next_cursor: null, totals: totals() },
      { rows: [row({ amount: 0 })], next_cursor: null, totals: totals() },
      { rows: [], totals: totals() },
      [],
    ];
    for (const body of broken) expect((await sandbox(() => ({ body })).send('GET', '/sale-payments')).statusCode).toBe(503);
  });
});
