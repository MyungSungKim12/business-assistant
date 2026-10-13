import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auth, buildApp, fakeFetch, fakeOrganizations, ORG, OTHER_ORG, testConfig, type FakeCall, type FakeReply, type Role } from '../catalog/testkit.js';
import { registerManagementModule } from './index.js';

const PREVIEW = {
  organization_id: ORG, from_date: '2026-10-01', to_date: '2026-10-08', recorded_income: '100', recorded_expense: '20', recorded_net: '80',
  transaction_count: 2, visit_receipts: '100', visit_refunds: '0', staff_sales_basis: [], is_final_profit: false,
  excluded_costs: ['inventory_cogs'], staff_basis_is_commission: false,
};
const PERIOD = 'from_date=2026-10-01&to_date=2026-10-08';
let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

function setup(reply: (call: FakeCall) => FakeReply = () => ({ body: PREVIEW }), role: Role = 'owner', features = ['finance.basic']) {
  const { fetcher, calls } = fakeFetch(reply);
  const organizations = fakeOrganizations(role, features);
  app = buildApp((instance) => registerManagementModule(instance, organizations, testConfig, fetcher));
  const get = (period = PERIOD) => app.inject({ method: 'GET', url: `/api/v1/organizations/${ORG}/management-preview?${period}`, headers: auth });
  return { get, calls, organizations };
}

describe('관리 미리보기', () => {
  it('관리자는 확정 손익이 아님이 명시된 미리보기를 받는다', async () => {
    const { get, calls, organizations } = setup();
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.json().recorded_net).toBe('80');
    expect(response.json().is_final_profit).toBe(false);
    expect(calls[0].url.pathname).toBe('/rest/v1/rpc/get_management_preview');
    expect(calls[0].body).toEqual({ p_organization_id: ORG, p_from_date: '2026-10-01', p_to_date: '2026-10-08' });
    expect(organizations.calls).toEqual([{ feature: 'finance.basic', write: true }]);
  });

  it('숫자 금액은 문자열로 통일하고 담당자 행을 검증한다', async () => {
    const row = { staff_id: null, staff_name_snapshot: '', line_count: 2, gross_line_total: 90000 };
    const { get } = setup(() => ({ body: { ...PREVIEW, recorded_net: 80, staff_sales_basis: [row] } }));
    const body = (await get()).json();
    expect(body.recorded_net).toBe('80');
    expect(body.staff_sales_basis[0].gross_line_total).toBe('90000');
  });

  it('member, 외부인, 기능 누락, 잘못된 기간은 거부하고 RPC에 닿지 않는다', async () => {
    for (const [role, features] of [['member', ['finance.basic']], ['outsider', ['finance.basic']], ['owner', []]] as const) {
      const { get, calls } = setup(undefined, role, [...features]);
      expect((await get()).statusCode).toBe(403);
      expect(calls).toHaveLength(0);
    }
    const { get, calls } = setup();
    for (const period of ['from_date=2026-11-01&to_date=2026-10-01', 'from_date=2026-01-01&to_date=2027-12-31', 'from_date=2026-10-01', 'from_date=bad&to_date=2026-10-01', '']) {
      expect((await get(period)).statusCode).toBe(422);
    }
    expect(calls).toHaveLength(0);
  });

  it('366일 기간은 허용하고 367일은 거부한다', async () => {
    const { get } = setup((call) => ({ body: { ...PREVIEW, from_date: (call.body as { p_from_date: string }).p_from_date, to_date: (call.body as { p_to_date: string }).p_to_date } }));
    expect((await get('from_date=2026-01-01&to_date=2027-01-02')).statusCode).toBe(200);
    expect((await get('from_date=2026-01-01&to_date=2027-01-03')).statusCode).toBe(422);
  });

  it.each([
    ['최종 손익 표시', { is_final_profit: true }],
    ['수당 확정 표시', { staff_basis_is_commission: true }],
    ['다른 조직', { organization_id: OTHER_ORG }],
    ['다른 기간', { to_date: '2026-10-09' }],
    ['잘못된 금액', { recorded_income: 'NaN' }],
  ])('%s 응답은 원문 없이 503으로 막는다', async (_name, change) => {
    const { get } = setup(() => ({ body: { ...PREVIEW, ...change } }));
    const response = await get();
    expect(response.statusCode).toBe(503);
    expect(response.json().detail).toBe('Management service unavailable');
  });

  it('Supabase 오류 상태를 매핑한다', async () => {
    expect((await setup(() => ({ status: 403, body: { message: 'x' } })).get()).statusCode).toBe(403);
    expect((await setup(() => ({ status: 400, body: { code: '42501' } })).get()).statusCode).toBe(403);
    expect((await setup(() => ({ status: 500, body: { message: 'x' } })).get()).statusCode).toBe(503);
  });

  it('토큰이 없으면 401', async () => {
    setup();
    expect((await app.inject({ method: 'GET', url: `/api/v1/organizations/${ORG}/management-preview?${PERIOD}` })).statusCode).toBe(401);
  });
});
