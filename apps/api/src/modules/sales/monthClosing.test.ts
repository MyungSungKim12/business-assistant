import { describe, expect, it } from 'vitest';
import { org, sandbox, userId, visitId } from './fixtures.js';

const ID = '33333333-3333-4333-8333-333333333333';
const closing = (over: Record<string, unknown> = {}) => ({
  id: ID, organization_id: org, month: '2030-01-01', note: '1월 결산 확인', closed_by: userId, closed_at: '2030-02-01T01:00:00+00:00',
  reopened_by: null, reopened_at: null, reopen_reason: null, ...over,
});
const rpc = (name: string) => `/rest/v1/rpc/${name}`;
const TX = '44444444-4444-4444-8444-444444444444';
const closedError = { status: 400, body: { code: 'P0001', message: 'Finance month is closed' } };
const newTx = { transaction_type: 'expense', amount: '25.50', transaction_date: '2030-01-12', category: 'Supplies' };
const payBody = { operation_id: '99999999-9999-4999-8999-999999999999', expected_version: 3, confirmed: true, payments: [{ method: 'cash', amount: '1000' }] };

describe('재무 월 마감 API', () => {
  it('목록은 조직으로 거르고 최근 달부터 읽는다(회원도 조회 가능)', async () => {
    const older = closing({ id: '55555555-5555-4555-8555-555555555555', month: '2029-12-01', reopened_at: '2030-01-05T00:00:00+00:00', reopened_by: userId, reopen_reason: '정정' });
    const { send, calls } = sandbox((call) => ({ body: call.query.offset === '0' ? [closing(), older] : [] }), { role: 'member' });
    const response = await send('GET', '/finance-month-closings');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(2);
    expect(calls[0].path).toBe('/rest/v1/finance_month_closings');
    expect(calls[0].query).toMatchObject({ organization_id: `eq.${org}`, order: 'month.desc,closed_at.desc,id.desc' });
    const other = sandbox(() => ({ body: [closing({ organization_id: '00000000-0000-4000-8000-000000000000' })] }));
    expect((await other.send('GET', '/finance-month-closings')).statusCode).toBe(503);
  });

  it('마감은 달의 첫날과 사유를 RPC에 넘기고 201을 돌려준다', async () => {
    const { send, calls, access } = sandbox(() => ({ body: closing() }));
    const response = await send('POST', '/finance-month-closings', { month: '2030-01', note: '  1월 결산 확인  ' });
    expect(response.statusCode).toBe(201);
    expect(access).toEqual([{ feature: 'finance.basic', write: true }]);
    expect(calls[0].path).toBe(rpc('close_finance_month'));
    expect(calls[0].body).toEqual({ p_organization_id: org, p_month: '2030-01-01', p_note: '1월 결산 확인' });
    expect(response.json()).toMatchObject({ month: '2030-01-01', note: '1월 결산 확인', reopened_at: null });
  });

  it('잘못된 달·사유는 422이고 회원은 마감·재오픈할 수 없다', async () => {
    const { send, calls } = sandbox(() => ({ body: closing() }));
    const bad = [{ month: '2030-13', note: 'x' }, { month: '2030-01-15', note: 'x' }, { month: 'x', note: 'x' }, { month: '2030-01' }, { month: '2030-01', note: '   ' }, { month: '2030-01', note: 'x'.repeat(1001) }, { month: '2030-01', note: 'x', extra: 1 }];
    for (const body of bad) expect((await send('POST', '/finance-month-closings', body)).statusCode).toBe(422);
    for (const body of [{}, { reason: ' ' }, { reason: 'x', extra: 1 }]) expect((await send('POST', '/finance-month-closings/2030-01/reopen', body)).statusCode).toBe(422);
    expect((await send('POST', '/finance-month-closings/2030-1/reopen', { reason: 'x' })).statusCode).toBe(422);
    expect(calls).toEqual([]);
    const member = sandbox(() => ({ body: closing() }), { role: 'member' });
    expect((await member.send('POST', '/finance-month-closings', { month: '2030-01', note: 'x' })).statusCode).toBe(403);
    expect((await member.send('POST', '/finance-month-closings/2030-01/reopen', { reason: 'x' })).statusCode).toBe(403);
    expect(member.calls).toEqual([]);
  });

  it('재오픈은 달과 사유를 RPC에 넘긴다', async () => {
    const reopened = closing({ reopened_at: '2030-02-03T00:00:00+00:00', reopened_by: userId, reopen_reason: '세금계산서 정정' });
    const { send, calls } = sandbox(() => ({ body: reopened }));
    const response = await send('POST', '/finance-month-closings/2030-01-01/reopen', { reason: ' 세금계산서 정정 ' });
    expect(response.statusCode).toBe(200);
    expect(calls[0].path).toBe(rpc('reopen_finance_month'));
    expect(calls[0].body).toEqual({ p_organization_id: org, p_month: '2030-01-01', p_reason: '세금계산서 정정' });
    expect(response.json().reopen_reason).toBe('세금계산서 정정');
  });

  it('응답의 달이 요청과 다르면 서버 오류로 본다', async () => {
    const { send } = sandbox(() => ({ body: closing({ month: '2029-12-01' }) }));
    expect((await send('POST', '/finance-month-closings', { month: '2030-01', note: 'x' })).statusCode).toBe(503);
  });

  it('이미 마감·마감 아님·권한 없음은 각각 409·404·403 한국어 안내로 바꾼다', async () => {
    const again = sandbox(() => ({ status: 400, body: { code: 'P0001', message: 'Finance month already closed' } }));
    const first = await again.send('POST', '/finance-month-closings', { month: '2030-01', note: 'x' });
    expect(first.statusCode).toBe(409);
    expect(first.json().detail).toContain('이미 마감');
    const missing = sandbox(() => ({ status: 404, body: { code: 'P0002', message: 'Finance month is not closed' } }));
    const gone = await missing.send('POST', '/finance-month-closings/2030-01/reopen', { reason: 'x' });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().detail).toContain('마감 상태가 아닌');
    const denied = sandbox(() => ({ status: 403, body: { code: '42501', message: 'secret' } }));
    expect((await denied.send('POST', '/finance-month-closings', { month: '2030-01', note: 'x' })).statusCode).toBe(403);
  });

  it('마감된 달의 거래 등록·수정은 409와 오류 코드·한국어 안내를 돌려준다', async () => {
    const create = sandbox((call) => (call.path === '/auth/v1/user' ? { body: { id: userId } } : closedError));
    const created = await create.send('POST', '/finance-transactions', newTx);
    expect(created.statusCode).toBe(409);
    expect(created.json()).toMatchObject({ code: 'FINANCE_MONTH_CLOSED' });
    expect(created.json().detail).toContain('마감된 달');
    expect(created.body).not.toContain('Finance month is closed');
    const update = sandbox(() => closedError);
    const updated = await update.send('PATCH', `/finance-transactions/${TX}`, { is_archived: true });
    expect(updated.statusCode).toBe(409);
    expect(updated.json().code).toBe('FINANCE_MONTH_CLOSED');
  });

  it('수납이 마감된 달의 장부에 걸려도 같은 409 안내를 쓰고, 다른 충돌은 그대로 둔다', async () => {
    const pay = sandbox(() => closedError);
    const paid = await pay.send('POST', `/visits/${visitId}/payments`, payBody);
    expect(paid.statusCode).toBe(409);
    expect(paid.json().code).toBe('FINANCE_MONTH_CLOSED');
    const other = sandbox(() => ({ status: 400, body: { code: 'P0001', message: 'Cart changed' } }));
    const conflict = await other.send('POST', `/visits/${visitId}/payments`, payBody);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().detail).toBe('Sale cart conflict; reload before retrying');
  });
});
