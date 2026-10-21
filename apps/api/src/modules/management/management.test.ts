import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auth, buildApp, fakeFetch, fakeOrganizations, ORG, OTHER_ORG, testConfig, type FakeCall, type FakeReply, type Role } from '../catalog/testkit.js';
import { registerManagementModule } from './index.js';

const PREVIEW = {
  organization_id: ORG, from_date: '2026-10-01', to_date: '2026-10-08', recorded_income: '100', recorded_expense: '20', recorded_net: '80',
  transaction_count: 2, visit_receipts: '100', visit_refunds: '0', inventory_cogs:'0', inventory_cost_unknown_units:0, recorded_tax_expense:'0', operating_profit_before_commission_tax:'100', commission_settlement_complete:false, commission_expense:null, operating_profit_after_commission_before_tax:null, operating_profit_after_recorded_tax:null, staff_sales_basis: [], is_final_profit: false,
  excluded_costs: ['staff_commissions','tax'], staff_basis_is_commission: false,
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
    expect(response.json().recorded_tax_expense).toBe('0');
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

  it('수당 규칙 조회·등록·종료는 관리자 전용 RPC를 사용한다',async()=>{
    const rule={id:ORG,organization_id:ORG,staff_id:null,commission_scope:'service',service_id:OTHER_ORG,product_id:null,rate_basis_points:1500,basis:'net_paid',effective_from:'2026-10-01',effective_to:null,version:1,is_active:true,created_by:ORG,created_at:'2026-10-01T00:00:00Z'};
    const {calls}=setup(call=>({body:call.url.pathname.endsWith('list_staff_commission_rules')?[rule]:rule}));
    const base=`/api/v1/organizations/${ORG}/staff-commission-rules`;
    expect((await app.inject({method:'GET',url:base,headers:auth})).statusCode).toBe(200);
    expect((await app.inject({method:'POST',url:base,headers:auth,payload:{staff_id:null,commission_scope:'service',service_id:OTHER_ORG,product_id:null,rate_basis_points:1500,effective_from:'2026-10-01',effective_to:null}})).statusCode).toBe(200);
    expect((await app.inject({method:'POST',url:`${base}/${ORG}/end`,headers:auth,payload:{effective_to:'2026-10-31',expected_version:1}})).statusCode).toBe(200);
    expect(calls.map(call=>call.url.pathname.split('/').at(-1))).toEqual(['list_staff_commission_rules','create_staff_commission_rule','end_staff_commission_rule']);
    setup(call=>({body:call.url.pathname.endsWith('list_staff_commission_rules')?[rule]:rule}),'member');
    expect((await app.inject({method:'GET',url:base,headers:auth})).statusCode).toBe(403);
  });

  it('수당 정산 미리보기·확정·직원 열람을 분리된 RPC로 처리한다',async()=>{
    const settlement={id:ORG,organization_id:ORG,from_date:'2026-10-01',to_date:'2026-10-08',status:'confirmed',total_commission:'1500',lines:[]};
    const {calls,organizations}=setup(call=>({body:call.url.pathname.endsWith('preview_staff_commission_settlement')?{organization_id:ORG,from_date:'2026-10-01',to_date:'2026-10-08',lines:[]}:call.url.pathname.endsWith('list_staff_commission_settlements')?[]:settlement}));
    const base=`/api/v1/organizations/${ORG}/staff-commission-settlements`;
    expect((await app.inject({method:'POST',url:`${base}/preview`,headers:auth,payload:{from_date:'2026-10-01',to_date:'2026-10-08'}})).statusCode).toBe(200);
    expect((await app.inject({method:'POST',url:base,headers:auth,payload:{from_date:'2026-10-01',to_date:'2026-10-08',operation_id:OTHER_ORG}})).statusCode).toBe(200);
    expect((await app.inject({method:'GET',url:base,headers:auth})).statusCode).toBe(200);
    expect(calls.map(call=>call.url.pathname.split('/').at(-1))).toEqual(['preview_staff_commission_settlement','confirm_staff_commission_settlement','list_staff_commission_settlements']);
    expect(organizations.calls.slice(-3)).toEqual([{feature:'finance.basic',write:true},{feature:'finance.basic',write:true},{feature:'finance.basic',write:false}]);
    const employee=setup(()=>({body:[]}),'member');
    expect((await app.inject({method:'GET',url:base,headers:auth})).statusCode).toBe(200);
    expect(employee.organizations.calls).toEqual([{feature:'finance.basic',write:false}]);
  });

  it('담당 누락 보정은 사유·version·멱등 ID를 검증하고 관리자 RPC로만 저장한다',async()=>{
    const result={organization_id:ORG,sale_line_id:OTHER_ORG,staff_id:ORG,version:1,reason:'담당 누락 확인',replayed:false};
    const {calls,organizations}=setup(call=>({body:result}));
    const url=`/api/v1/organizations/${ORG}/staff-commission-attributions/${OTHER_ORG}`;
    const payload={staff_id:ORG,expected_version:0,reason:'담당 누락 확인',operation_id:'e9cc39fd-8e8c-4df8-a623-1f23a3a936bd'};
    const response=await app.inject({method:'PATCH',url,headers:auth,payload});
    expect(response.statusCode,response.body).toBe(200);expect(calls[0].url.pathname).toBe('/rest/v1/rpc/assign_staff_commission_attribution');
    expect(calls[0].body).toEqual({p_organization_id:ORG,p_sale_line_id:OTHER_ORG,p_staff_id:ORG,p_expected_version:0,p_reason:'담당 누락 확인',p_operation_id:payload.operation_id});
    expect(organizations.calls).toEqual([{feature:'finance.basic',write:true}]);
    for(const invalid of [{...payload,reason:'  '},{...payload,expected_version:-1},{...payload,extra:true}])expect((await app.inject({method:'PATCH',url,headers:auth,payload:invalid})).statusCode).toBe(422);
    setup(call=>({body:{...result,organization_id:OTHER_ORG}}));
    expect((await app.inject({method:'PATCH',url,headers:auth,payload})).statusCode).toBe(503);
    const member=setup(undefined,'member');expect((await app.inject({method:'PATCH',url,headers:auth,payload})).statusCode).toBe(403);expect(member.calls).toHaveLength(0);
  });

  it('보정 직원 목록도 finance 관리자 전용 조직 RPC를 사용한다',async()=>{
    const {calls,organizations}=setup(call=>({body:call.url.pathname.endsWith('list_staff_commission_attribution_staff')?[{id:ORG,organization_id:ORG,name:'직원',is_active:true}]:[]}));
    const url=`/api/v1/organizations/${ORG}/staff-commission-attribution-staff`;
    expect((await app.inject({method:'GET',url,headers:auth})).json()).toEqual([{id:ORG,organization_id:ORG,name:'직원',is_active:true}]);
    expect(calls[0].url.pathname).toBe('/rest/v1/rpc/list_staff_commission_attribution_staff');expect(organizations.calls).toEqual([{feature:'finance.basic',write:true}]);
    const member=setup(undefined,'member');expect((await app.inject({method:'GET',url,headers:auth})).statusCode).toBe(403);expect(member.calls).toHaveLength(0);
  });
});

describe('경영 손익 확정',()=>{
  const snapshot={id:'f9cc39fd-8e8c-4df8-a623-1f23a3a936bd',organization_id:ORG,from_date:'2026-10-01',to_date:'2026-10-08',revision:1,result:{...PREVIEW,is_final_profit:true,excluded_costs:[],operating_profit_after_recorded_tax:'80'},reason:'',confirmed_by:ORG,confirmed_at:'2026-10-09T00:00:00Z'};
  const input={from_date:'2026-10-01',to_date:'2026-10-08',operation_id:'e9cc39fd-8e8c-4df8-a623-1f23a3a936bd',confirmed_complete:true,reason:''};

  it('완전성 확인과 기간을 검증해 불변 스냅샷 RPC를 호출한다',async()=>{
    const {calls,organizations}=setup(call=>({body:call.url.pathname.endsWith('finalize_management_profit')?snapshot:[snapshot]}));
    const response=await app.inject({method:'POST',url:`/api/v1/organizations/${ORG}/management-profit-finalizations`,headers:auth,payload:input});
    expect(response.statusCode,response.body).toBe(200);expect(response.json().revision).toBe(1);
    expect(calls[0].url.pathname).toBe('/rest/v1/rpc/finalize_management_profit');
    expect(calls[0].body).toMatchObject({p_organization_id:ORG,p_from_date:input.from_date,p_to_date:input.to_date,p_operation_id:input.operation_id,p_confirmed_complete:true});
    expect(organizations.calls).toEqual([{feature:'finance.basic',write:true}]);
  });

  it('체크 누락·미래 기간은 거부하고 일반 구성원은 RPC에 접근하지 못한다',async()=>{
    const owner=setup();
    for(const payload of [{...input,confirmed_complete:false},{...input,to_date:'2099-01-01'},{...input,extra:true}]){
      expect((await app.inject({method:'POST',url:`/api/v1/organizations/${ORG}/management-profit-finalizations`,headers:auth,payload})).statusCode).toBe(422);
    }
    expect(owner.calls).toHaveLength(0);
    const member=setup(undefined,'member');
    expect((await app.inject({method:'POST',url:`/api/v1/organizations/${ORG}/management-profit-finalizations`,headers:auth,payload:input})).statusCode).toBe(403);
    expect(member.calls).toHaveLength(0);
  });

  it('다른 조직·다른 기간의 RPC 응답을 숨긴다',async()=>{
    for(const change of [{organization_id:OTHER_ORG},{to_date:'2026-10-09'}]){
      setup(call=>({body:{...snapshot,...change}}));
      const response=await app.inject({method:'POST',url:`/api/v1/organizations/${ORG}/management-profit-finalizations`,headers:auth,payload:input});
      expect(response.statusCode).toBe(503);
    }
  });
});
