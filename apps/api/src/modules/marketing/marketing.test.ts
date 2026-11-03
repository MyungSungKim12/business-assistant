import {describe,it,expect,vi} from 'vitest';
import {buildApp,ORG,OTHER_ORG,auth,fakeOrganizations} from '../catalog/testkit.js';
import {registerMarketingRoutes} from './routes.js';
import type {MarketingGateway} from './gateway.js';
const UUID='0a9c39fd-8e8c-4df8-a623-1f23a3a936bd',CUSTOMER='1a9c39fd-8e8c-4df8-a623-1f23a3a936bd',OP='2a9c39fd-8e8c-4df8-a623-1f23a3a936bd';
const workspace={organization_id:ORG,templates:[],messages:[],provider_ready:false as const};
function setup(role:'owner'|'admin'|'member'|'outsider'='owner',overrides:Partial<MarketingGateway>={}){
 const organizations=fakeOrganizations(role,['crm.basic']);
 const gateway:MarketingGateway={workspace:vi.fn(async()=>workspace),saveTemplate:vi.fn(async(_t,_o,i)=>({template:{id:UUID,organization_id:ORG,name:i.name,channel:i.channel,purpose:i.purpose,body:i.body,version:1,is_active:true,created_at:'2026-11-03T00:00:00Z',updated_at:'2026-11-03T00:00:00Z'}})),preview:vi.fn(async()=>({eligible:[{customer_id:CUSTOMER,name:'고객',phone_masked:'010****1234'}],excluded:[],template_version:1,provider_ready:false as const})),enqueue:vi.fn(async()=>({created:1,excluded:[],messages:[{id:UUID,customer_id:CUSTOMER,status:'queued' as const,scheduled_at:'2026-11-03T00:00:00Z',attempt_count:0}],provider_ready:false as const})),cancel:vi.fn(async()=>({cancelled:true as const,id:UUID})),retry:vi.fn(async()=>({id:UUID,status:'queued' as const,attempt_count:1,provider_ready:false as const})),...overrides};
 const app=buildApp(a=>registerMarketingRoutes(a,organizations,gateway));return{app,organizations,gateway};
}
const base=`/api/v1/organizations/${ORG}/marketing`;
describe('MKT 메시지 API',()=>{
 it('공급자가 설정되지 않은 상태를 성공으로 바꾸지 않고 작업공간에 그대로 보여 준다',async()=>{
  const {app,gateway}=setup();const response=await app.inject({url:base,headers:auth});
  expect(response.statusCode).toBe(200);expect(response.json().provider_ready).toBe(false);expect(gateway.workspace).toHaveBeenCalledWith('user-token',ORG);
 });
 it('템플릿 입력 검증 후 조직 쓰기 권한을 확인한다',async()=>{
  const {app,organizations}=setup('owner');
  const invalid=await app.inject({method:'POST',url:`${base}/templates`,headers:auth,payload:{name:'x',channel:'sms',purpose:'marketing',body:'#{unknown} longer'}});
  expect(invalid.statusCode).toBe(422);
  const valid=await app.inject({method:'POST',url:`${base}/templates`,headers:auth,payload:{name:'재방문',channel:'sms',purpose:'marketing',body:'#{customer_name}님 방문해 주세요.'}});
  expect(valid.statusCode).toBe(201);expect(organizations.calls.at(-1)).toEqual({feature:'crm.basic',write:true});
 });
 it('member가 outbox 생성/템플릿 수정을 API에서 시도하면 거절된다',async()=>{
  const {app,gateway}=setup('member');
  const response=await app.inject({method:'POST',url:`${base}/enqueue`,headers:auth,payload:{template_id:UUID,customer_ids:[CUSTOMER],scheduled_at:null,operation_id:OP}});
  expect(response.statusCode).toBe(403);expect(gateway.enqueue).not.toHaveBeenCalled();
 });
 it('대상 preview는 선택 고객 ID만 허용하고 전화번호 평문은 반환하지 않는다',async()=>{
  const {app,gateway}=setup();const response=await app.inject({method:'POST',url:`${base}/preview`,headers:auth,payload:{template_id:UUID,customer_ids:[CUSTOMER]}});
  expect(response.statusCode).toBe(200);expect(response.json().eligible[0].phone_masked).toBe('010****1234');expect(response.body).not.toContain('0101234');expect(gateway.preview).toHaveBeenCalledWith('user-token',ORG,UUID,[CUSTOMER]);
 });
 it('duplicate recipient IDs and cross-organization response are rejected',async()=>{
  const {app}=setup();const invalid=await app.inject({method:'POST',url:`${base}/enqueue`,headers:auth,payload:{template_id:UUID,customer_ids:[CUSTOMER,CUSTOMER],scheduled_at:null,operation_id:OP}});expect(invalid.statusCode).toBe(422);
  const other=setup('owner',{workspace:vi.fn(async()=>({organization_id:OTHER_ORG,templates:[],messages:[],provider_ready:false}))});const response=await other.app.inject({url:base,headers:auth});expect(response.statusCode).toBe(503);
 });
 it('취소와 재시도는 사용자 인증과 write gate를 통과해야 한다',async()=>{
  const {app,gateway}=setup();const canceled=await app.inject({method:'POST',url:`${base}/${UUID}/cancel`,headers:auth,payload:{expected_attempt_count:0}});expect(canceled.statusCode).toBe(200);
  const retried=await app.inject({method:'POST',url:`${base}/${UUID}/retry`,headers:auth,payload:{expected_attempt_count:1,operation_id:OP}});expect(retried.statusCode).toBe(200);expect(gateway.retry).toHaveBeenCalled();
 });
});
