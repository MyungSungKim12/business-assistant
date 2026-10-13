import { describe, expect, it } from 'vitest';
import { cartId, customerId, org, sandbox, visitId } from './fixtures.js';

const rpc = '/rest/v1/rpc/get_receivables_summary';
const item = (over: Record<string, unknown> = {}) => ({
  cart_id: cartId, visit_id: visitId, customer_id: customerId, customer_name: '김고객', opened_at: '2030-01-01T01:00:00+00:00',
  total_amount: 90000, received_amount: 40000, refunded_amount: 0, due_amount: 50000, ...over,
});
const summary = (over: Record<string, unknown> = {}) => ({ receivable_count: 1, total_due: 50000, items: [item()], ...over });

describe('전체 미수금 API', () => {
  it('조직 전체 미수 요약을 RPC로 읽고 금액을 문자열로 돌려준다', async () => {
    const { send, calls, access } = sandbox(() => ({ body: summary() }), { role: 'member', features: ['finance.basic'] });
    const response = await send('GET', '/receivables?limit=3');
    expect(response.statusCode).toBe(200);
    expect(access).toEqual([{ feature: 'finance.basic', write: false }]);
    expect(calls[0].path).toBe(rpc);
    expect(calls[0].body).toEqual({ p_organization_id: org, p_limit: 3 });
    expect(response.json()).toMatchObject({ receivable_count: 1, total_due: '50000' });
    expect(response.json().items[0]).toMatchObject({ customer_name: '김고객', due_amount: '50000', opened_at: '2030-01-01T01:00:00+00:00' });
  });

  it('기본 5건이며 한도를 벗어난 요청은 422', async () => {
    const { send, calls } = sandbox(() => ({ body: summary({ items: [], receivable_count: 0, total_due: 0 }) }));
    expect((await send('GET', '/receivables')).statusCode).toBe(200);
    expect(calls[0].body).toEqual({ p_organization_id: org, p_limit: 5 });
    calls.length = 0;
    for (const query of ['limit=0', 'limit=51', 'limit=x']) expect((await send('GET', `/receivables?${query}`)).statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it('권한이 없거나 응답이 이상하면 거부·서버 오류', async () => {
    expect((await sandbox(() => ({ body: summary() }), { features: [] }).send('GET', '/receivables')).statusCode).toBe(403);
    expect((await sandbox(() => ({ body: summary() })).send('GET', '/receivables', undefined, null)).statusCode).toBe(401);
    const broken = [summary({ total_due: 'x' }), summary({ items: [item({ due_amount: -1 })] }), summary({ items: Array.from({ length: 6 }, () => item()) }), []];
    for (const body of broken) expect((await sandbox(() => ({ body })).send('GET', '/receivables?limit=5')).statusCode).toBe(503);
  });
});
