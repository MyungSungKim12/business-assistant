import { describe, expect, it } from 'vitest';
import { org, sandbox, userId } from './fixtures.js';

const TX = '33333333-3333-4333-8333-333333333333';
const row = (over: Record<string, unknown> = {}) => ({
  id: TX, organization_id: org, created_by: userId, transaction_type: 'income', amount: 1234.5, transaction_date: '2030-01-10', category: 'Sales', counterparty: 'Acme', memo: 'Invoice',
  is_archived: false, created_at: '2030-01-10T00:00:00+00:00', updated_at: '2030-01-10T00:00:00+00:00', ...over,
});
const table = '/rest/v1/finance_transactions';
const newTx = { transaction_type: 'expense', amount: '25.50', transaction_date: '2030-01-12', category: 'Supplies' };
const pageOf = (rows: unknown[]) => (call: { query: Record<string, string> }) => ({ body: call.query.offset === '0' ? rows : [] });

describe('수입·지출 API', () => {
  it('인증·멤버십·기능이 없으면 거부한다', async () => {
    const { send, calls } = sandbox(pageOf([row()]), { features: ['finance.basic'] });
    expect((await send('GET', '/finance-transactions', undefined, null)).statusCode).toBe(401);
    expect((await send('GET', '/finance-transactions', undefined, 'outsider')).statusCode).toBe(403);
    expect(calls).toEqual([]);
    const none = sandbox(pageOf([row()]), { features: [] });
    expect((await none.send('GET', '/finance-transactions')).statusCode).toBe(403);
    expect((await none.send('GET', '/finance-summary')).statusCode).toBe(403);
    expect(none.calls).toEqual([]);
  });

  it('목록은 조직·기간·유형으로 거르고 금액을 소수 2자리 문자열로 돌려준다', async () => {
    const { send, calls } = sandbox(pageOf([row()]), { role: 'member' });
    const response = await send('GET', '/finance-transactions?from_date=2030-01-01&to_date=2030-01-31&transaction_type=income');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ ...row(), amount: '1234.50' }]);
    expect(calls[0].path).toBe(table);
    expect(calls[0].query).toMatchObject({ organization_id: `eq.${org}`, and: '(transaction_date.gte.2030-01-01,transaction_date.lte.2030-01-31)', transaction_type: 'eq.income' });
    expect(calls[0].query.select).not.toContain('*');
    expect(calls).toHaveLength(2);

    const single = sandbox(pageOf([]));
    await single.send('GET', '/finance-transactions?from_date=2030-01-01');
    expect(single.calls[0].query).toMatchObject({ transaction_date: 'gte.2030-01-01' });
    await single.send('GET', '/finance-transactions?to_date=2030-01-31');
    expect(single.calls[1].query).toMatchObject({ transaction_date: 'lte.2030-01-31' });
  });

  it('잘못된 필터는 422', async () => {
    const { send, calls } = sandbox(pageOf([]));
    expect((await send('GET', '/finance-transactions?from_date=2030-02-01&to_date=2030-01-01')).statusCode).toBe(422);
    expect((await send('GET', '/finance-transactions?transaction_type=other')).statusCode).toBe(422);
    expect((await send('GET', '/finance-summary?from_date=2030-02-01&to_date=2030-01-01')).statusCode).toBe(422);
    expect((await send('GET', '/finance-transactions?from_date=x')).statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it('등록은 작성자를 토큰 사용자로 하고 소수 금액을 문자열 그대로 보낸다', async () => {
    const { send, calls } = sandbox((call) => call.path === '/auth/v1/user' ? { body: { id: userId } } : { body: [row({ transaction_type: 'expense', amount: '25.50' })] });
    const response = await send('POST', '/finance-transactions', { ...newTx, category: '  Supplies  ' });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ amount: '25.50', transaction_type: 'expense' });
    const insert = calls.find((call) => call.method === 'POST' && call.path === table)!;
    expect(insert.body).toEqual({ ...newTx, category: 'Supplies', counterparty: '', memo: '', is_archived: false, organization_id: org, created_by: userId });
    expect(typeof (insert.body as { amount: unknown }).amount).toBe('string');
  });

  it('JSON 숫자 금액도 받되 소수 둘째 자리까지만 허용한다', async () => {
    const ok = sandbox((call) => call.path === '/auth/v1/user' ? { body: { id: userId } } : { body: [row()] });
    expect((await ok.send('POST', '/finance-transactions', { ...newTx, amount: 25.5 })).statusCode).toBe(201);
    expect(ok.calls.find((call) => call.path === table)!.body).toMatchObject({ amount: '25.5' });
    const bad = sandbox();
    for (const amount of ['0', '0.00', '-1', '1.001', '1000000000000', 'NaN', 'abc', '', null, 0, -5, 1.005]) {
      expect((await bad.send('POST', '/finance-transactions', { ...newTx, amount })).statusCode).toBe(422);
    }
    expect((await bad.send('POST', '/finance-transactions', { ...newTx, amount: '999999999999.99' })).statusCode).not.toBe(422);
  });

  it('입력 검증과 관리자 권한을 확인한다', async () => {
    const { send, calls } = sandbox();
    for (const change of [{ transaction_type: 'other' }, { category: '' }, { category: '   ' }, { category: 'x'.repeat(201) }, { memo: 'x'.repeat(5001) }, { counterparty: 'x'.repeat(5001) }, { transaction_date: '2030-13-01' }, { is_archived: 'yes' }, { extra: 1 }]) {
      expect((await send('POST', '/finance-transactions', { ...newTx, ...change })).statusCode).toBe(422);
    }
    expect(calls).toEqual([]);
    const member = sandbox(undefined, { role: 'member' });
    expect((await member.send('POST', '/finance-transactions', newTx)).statusCode).toBe(403);
    expect((await member.send('PATCH', `/finance-transactions/${TX}`, { memo: 'x' })).statusCode).toBe(403);
    expect(member.calls).toEqual([]);
  });

  it('수정은 보낸 필드만 PATCH하고 없는 거래는 404', async () => {
    const { send, calls } = sandbox(() => ({ body: [row({ is_archived: true })] }));
    const response = await send('PATCH', `/finance-transactions/${TX}`, { is_archived: true });
    expect(response.statusCode).toBe(200);
    expect(response.json().is_archived).toBe(true);
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].query).toMatchObject({ id: `eq.${TX}`, organization_id: `eq.${org}` });
    expect(calls[0].body).toEqual({ is_archived: true });
    const missing = sandbox(() => ({ body: [] }));
    expect((await missing.send('PATCH', `/finance-transactions/${TX}`, { memo: 'x' })).statusCode).toBe(404);
    for (const body of [{}, { amount: null }, { category: null }, { memo: null }, { is_archived: null }, { transaction_type: null }, { amount: '0' }]) {
      expect((await send('PATCH', `/finance-transactions/${TX}`, body)).statusCode).toBe(422);
    }
    expect((await send('PATCH', '/finance-transactions/not-a-uuid', { memo: 'x' })).statusCode).toBe(422);
  });

  it('요약은 부동소수 오차 없이 합산하고 보관된 거래를 제외하도록 요청한다', async () => {
    const rows = [
      { id: '11111111-1111-4111-8111-111111111111', transaction_type: 'income', amount: 1234.5 },
      { id: '22222222-2222-4222-8222-222222222222', transaction_type: 'expense', amount: '10.10' },
      { id: '33333333-3333-4333-8333-333333333333', transaction_type: 'expense', amount: 0.2 },
      { id: '44444444-4444-4444-8444-444444444444', transaction_type: 'expense', amount: 0.1 },
    ];
    const { send, calls } = sandbox(pageOf(rows));
    const response = await send('GET', '/finance-summary?from_date=2030-01-01');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ from_date: '2030-01-01', to_date: null, income_total: '1234.50', expense_total: '10.40', net_total: '1224.10', transaction_count: 4 });
    expect(calls[0].query).toMatchObject({ is_archived: 'eq.false', organization_id: `eq.${org}`, transaction_date: 'gte.2030-01-01', select: 'id,transaction_type,amount' });
    const negative = sandbox(pageOf([{ id: rows[1].id, transaction_type: 'expense', amount: '5.5' }]));
    expect((await negative.send('GET', '/finance-summary')).json()).toMatchObject({ income_total: '0.00', expense_total: '5.50', net_total: '-5.50', transaction_count: 1 });
  });

  it('여러 페이지를 모두 합산한다', async () => {
    const make = (n: number) => ({ id: `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`, transaction_type: 'income', amount: '1.01' });
    const all = Array.from({ length: 1500 }, (_, index) => make(index + 1));
    const { send } = sandbox((call) => ({ body: all.slice(Number(call.query.offset), Number(call.query.offset) + 1000) }));
    expect((await send('GET', '/finance-summary')).json()).toMatchObject({ income_total: '1515.00', transaction_count: 1500 });
  });

  it('공급자 오류는 안전한 메시지로, 제약 위반은 422로 바꾼다', async () => {
    const down = sandbox(() => ({ status: 500, body: { message: 'secret' } }));
    const response = await down.send('GET', '/finance-transactions');
    expect(response.statusCode).toBe(503);
    expect(response.json().detail).toBe('Finance service unavailable');
    expect(response.body).not.toContain('secret');
    const bad = sandbox((call) => call.path === '/auth/v1/user' ? { body: { id: userId } } : { status: 400, body: { message: 'bad' } });
    expect((await bad.send('POST', '/finance-transactions', newTx)).statusCode).toBe(422);
  });

  it('다른 조직 행을 돌려주면 서버 오류로 취급한다', async () => {
    const { send } = sandbox(pageOf([row({ organization_id: '00000000-0000-4000-8000-000000000000' })]));
    expect((await send('GET', '/finance-transactions')).statusCode).toBe(503);
  });
});
