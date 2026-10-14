import { describe, expect, it } from 'vitest';
import { org, sandbox } from './fixtures.js';

const rid = '29cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const BASE = '/finance-recurring-expenses';
const row = (over: Record<string, unknown> = {}) => ({
  id: rid, organization_id: org, name: '월세', amount: 1200000, category: '임대료', counterparty: '건물주', memo: '', day_of_month: 25, is_active: true, version: 1, updated_at: '2026-10-14T01:00:00Z', ...over,
});
const answer = (body: unknown, status = 200) => () => ({ body, status });
const del = (app: ReturnType<typeof sandbox>['app'], path: string) => app.inject({ method: 'DELETE', url: `/api/v1/organizations/${org}${path}`, headers: { authorization: 'Bearer access' } });
const put = (app: ReturnType<typeof sandbox>['app'], method: 'PATCH', path: string, payload: unknown) => app.inject({ method, url: `/api/v1/organizations/${org}${path}`, headers: { authorization: 'Bearer access' }, payload: payload as never });

describe('반복 지출 API (FIN-11)', () => {
  it('목록은 이름순으로 읽고 금액을 소수 두 자리 문자열로 정규화하며 member도 읽는다', async () => {
    const { send, calls, access } = sandbox(answer([row()]), { role: 'member' });
    const response = await send('GET', BASE);
    expect(response.statusCode).toBe(200);
    expect(response.json()[0]).toMatchObject({ name: '월세', amount: '1200000.00' });
    expect(calls[0].path).toBe('/rest/v1/finance_recurring_expenses');
    expect(calls[0].query).toMatchObject({ organization_id: `eq.${org}`, order: 'name.asc' });
    expect(access).toEqual([{ feature: 'finance.basic', write: false }]);
  });

  it('다른 조직 행이 섞인 응답은 닫힌 실패(503)다', async () => {
    const { send } = sandbox(answer([row({ organization_id: '11111111-1111-4111-8111-111111111111' })]));
    expect((await send('GET', BASE)).statusCode).toBe(503);
  });

  it('생성은 조직을 경로에서 정하고 기본값(활성, 빈 거래처·메모)을 채운다', async () => {
    const { send, calls, access } = sandbox(answer([row()], 201));
    const response = await send('POST', BASE, { name: '  월세  ', amount: '1200000', category: ' 임대료 ', day_of_month: 25 });
    expect(response.statusCode).toBe(201);
    expect(calls[0].body).toEqual({ organization_id: org, name: '월세', amount: '1200000', category: '임대료', counterparty: '', memo: '', day_of_month: 25, is_active: true });
    expect(access.at(-1)).toEqual({ feature: 'finance.basic', write: true });
  });

  it('member의 쓰기는 거부되고 DB에 닿지 않는다', async () => {
    const { send, app, calls } = sandbox(answer([row()]), { role: 'member' });
    expect((await send('POST', BASE, { name: 'x', amount: 1, category: 'y', day_of_month: 1 })).statusCode).toBe(403);
    expect((await put(app, 'PATCH', `${BASE}/${rid}`, { name: 'x', expected_version: 1 })).statusCode).toBe(403);
    expect((await del(app, `${BASE}/${rid}`)).statusCode).toBe(403);
    expect((await send('POST', `${BASE}/generate`, { month: '2026-10' })).statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it('잘못된 입력(금액 0·소수 3자리·날짜 범위·알 수 없는 필드)은 422이고 DB에 닿지 않는다', async () => {
    const { send, calls } = sandbox(answer([row()]));
    const post = (payload: Record<string, unknown>) => send('POST', BASE, { name: '월세', amount: '1000', category: '임대료', day_of_month: 5, ...payload });
    expect((await post({ amount: '0' })).statusCode).toBe(422);
    expect((await post({ amount: '-5' })).statusCode).toBe(422);
    expect((await post({ amount: '1.234' })).statusCode).toBe(422);
    expect((await post({ day_of_month: 0 })).statusCode).toBe(422);
    expect((await post({ day_of_month: 32 })).statusCode).toBe(422);
    expect((await post({ category: '  ' })).statusCode).toBe(422);
    expect((await post({ name: '가'.repeat(121) })).statusCode).toBe(422);
    expect((await post({ organization_id: org })).statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it('수정은 보낸 필드만 version 조건과 함께 갱신하고, 오래된 버전은 409, 없으면 404다', async () => {
    const ok = sandbox(answer([row({ amount: 1300000, version: 2 })]));
    const saved = await put(ok.app, 'PATCH', `${BASE}/${rid}`, { amount: '1300000', expected_version: 1 });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ amount: '1300000.00', version: 2 });
    expect(ok.calls[0].body).toEqual({ amount: '1300000' });
    expect(ok.calls[0].query).toMatchObject({ version: 'eq.1', id: `eq.${rid}`, organization_id: `eq.${org}` });
    const stale = sandbox((call) => (call.method === 'PATCH' ? { body: [] } : { body: [{ id: rid }] }));
    expect((await put(stale.app, 'PATCH', `${BASE}/${rid}`, { name: 'x', expected_version: 1 })).statusCode).toBe(409);
    const missing = sandbox(answer([]));
    expect((await put(missing.app, 'PATCH', `${BASE}/${rid}`, { name: 'x', expected_version: 1 })).statusCode).toBe(404);
    expect((await put(ok.app, 'PATCH', `${BASE}/${rid}`, { name: 'x' })).statusCode).toBe(422);
  });

  it('같은 이름(23505)과 한도 위반(23514)을 409·422로 매핑한다', async () => {
    const dup = sandbox(answer({ code: '23505', message: 'duplicate' }, 409));
    expect((await dup.send('POST', BASE, { name: '중복', amount: 1, category: 'x', day_of_month: 1 })).statusCode).toBe(409);
    const bad = sandbox(answer({ code: '23514', message: 'check' }, 400));
    expect((await bad.send('POST', BASE, { name: '한도', amount: 1, category: 'x', day_of_month: 1 })).statusCode).toBe(422);
  });

  it('삭제는 존재를 확인하고 204, 지워지지 않았으면 403, 없으면 404다', async () => {
    let deleted = false;
    const ok = sandbox((call) => { if (call.method === 'DELETE') { deleted = true; return { body: [] }; } return { body: deleted ? [] : [{ id: rid }] }; });
    expect((await del(ok.app, `${BASE}/${rid}`)).statusCode).toBe(204);
    const blocked = sandbox((call) => (call.method === 'DELETE' ? { body: [] } : { body: [{ id: rid }] }));
    expect((await del(blocked.app, `${BASE}/${rid}`)).statusCode).toBe(403);
    expect((await del(sandbox(answer([])).app, `${BASE}/${rid}`)).statusCode).toBe(404);
  });

  it('한 달치 등록은 달의 첫날로 RPC를 부르고 결과를 그대로 돌려준다', async () => {
    const { send, calls, access } = sandbox(answer({ month: '2026-10-01', created: 2, skipped: 1, transaction_ids: [rid, rid.replace('29', '39')] }));
    const response = await send('POST', `${BASE}/generate`, { month: '2026-10' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ created: 2, skipped: 1 });
    expect(calls[0].path).toBe('/rest/v1/rpc/generate_finance_recurring_expenses');
    expect(calls[0].body).toEqual({ p_organization_id: org, p_month: '2026-10-01' });
    expect(access.at(-1)).toEqual({ feature: 'finance.basic', write: true });
    expect((await send('POST', `${BASE}/generate`, { month: '2026-10-15' })).statusCode).toBe(422);
    expect((await send('POST', `${BASE}/generate`, { month: '2026-13' })).statusCode).toBe(422);
    expect((await send('POST', `${BASE}/generate`, {})).statusCode).toBe(422);
  });

  it('마감된 달에는 등록하지 않고 한국어 안내가 있는 409를 돌려준다', async () => {
    const { send } = sandbox(answer({ code: 'P0001', message: 'Finance month is closed' }, 400));
    const response = await send('POST', `${BASE}/generate`, { month: '2026-09' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'FINANCE_MONTH_CLOSED' });
    expect(response.json().detail).toContain('마감된 달');
  });

  it('너무 먼 미래(22023)는 422로 알린다', async () => {
    const { send } = sandbox(answer({ code: '22023', message: 'Month is too far' }, 400));
    expect((await send('POST', `${BASE}/generate`, { month: '2031-01' })).statusCode).toBe(422);
  });

  it('그 달에 등록된 반복 지출 기록을 읽는다', async () => {
    const { send, calls } = sandbox(answer([{ recurring_id: rid, organization_id: org, month: '2026-10-01', transaction_id: rid }]), { role: 'member' });
    const response = await send('GET', `${BASE}/runs?month=2026-10`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ recurring_id: rid, organization_id: org, month: '2026-10-01', transaction_id: rid }]);
    expect(calls[0].query).toMatchObject({ month: 'eq.2026-10-01', organization_id: `eq.${org}` });
    expect((await send('GET', `${BASE}/runs?month=bad`)).statusCode).toBe(422);
  });

  it('finance.basic 기능이 없으면 403이다', async () => {
    const { send, calls } = sandbox(answer([]), { features: ['crm.basic'] });
    expect((await send('GET', BASE)).statusCode).toBe(403);
    expect(calls).toEqual([]);
  });
});
