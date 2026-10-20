import { describe, expect, it } from 'vitest';
import { build, headers, organizationId, customerId, treatmentId, operationId, treatmentRowJson, json } from './fixtures.js';
const appointmentId='11111111-1111-4111-8111-111111111111', visitId='22222222-2222-4222-8222-222222222222';
const base=`/api/v1/organizations/${organizationId}/customers/${customerId}`;
const path=`${base}/treatments/${treatmentId}/visit-link`;
const body={appointment_id:appointmentId,visit_id:visitId,expected_version:1,operation_id:operationId,reason:'접수 확인'};
describe('개별 시술 예약·방문 연결 API',()=>{
 it('명시 연결을 버전·멱등키·사유와 RPC로 전달한다',async()=>{
  const {app,calls}=build({provider:()=>json([{...treatmentRowJson,appointment_id:appointmentId,visit_id:visitId,version:2}])});
  const result=await app.inject({method:'PUT',url:path,headers,payload:body});expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({appointment_id:appointmentId,visit_id:visitId,version:2});
  expect(calls[0].url.pathname).toBe('/rest/v1/rpc/set_treatment_visit_link');
  expect(calls[0].body).toEqual({p_organization_id:organizationId,p_customer_id:customerId,p_treatment_id:treatmentId,p_appointment_id:appointmentId,p_visit_id:visitId,p_expected_version:1,p_operation_id:operationId,p_reason:'접수 확인'});
 });
 it.each([{}, {...body,reason:''},{...body,visit_id:'invalid'},{...body,expected_version:0},{...body,extra:true}])('잘못된 입력은 RPC 전에 거절한다',async payload=>{
  const {app,calls}=build();expect((await app.inject({method:'PUT',url:path,headers,payload})).statusCode).toBe(422);expect(calls).toHaveLength(0);
 });
 it('인증·기능·관리자 권한을 요구한다',async()=>{
  expect((await build().app.inject({method:'PUT',url:path,payload:body})).statusCode).toBe(401);
  for(const opts of [{role:'member'},{role:null},{features:[]}]){
   const {app,calls}=build(opts);expect((await app.inject({method:'PUT',url:path,headers,payload:body})).statusCode).toBe(403);expect(calls).toHaveLength(0);
  }
 });
 it.each([['P0001',409],['22023',422],['P0002',404],['42501',403]] as const)('DB %s를 %s로 변환한다',async(code,status)=>{
  const {app}=build({provider:()=>json({code},400)});expect((await app.inject({method:'PUT',url:path,headers,payload:body})).statusCode).toBe(status);
 });
 it('다른 고객의 저장 응답을 거부한다',async()=>{
  const {app}=build({provider:()=>json([{...treatmentRowJson,customer_id:visitId}])});expect((await app.inject({method:'PUT',url:path,headers,payload:body})).statusCode).toBe(503);
 });
 it('선택지는 고객 범위로 완전 조회하며 다른 고객 결과를 거부한다',async()=>{
  const {app,calls}=build({provider:call=>call.url.pathname.endsWith('customers')?json([{id:customerId}]):json([])});
  const result=await app.inject({url:`${base}/treatment-context-options`,headers});expect(result.statusCode).toBe(200);expect(result.json()).toEqual({appointments:[],visits:[]});
  expect(calls.filter(c=>!c.url.pathname.endsWith('customers')).every(c=>c.url.searchParams.get('customer_id')===`eq.${customerId}`&&c.headers.Prefer==='count=exact')).toBe(true);
  const bad=build({provider:call=>call.url.pathname.endsWith('customers')?json([{id:customerId}]):call.url.pathname.endsWith('appointments')?json([{id:appointmentId,organization_id:organizationId,customer_id:visitId,service_name_snapshot:'외부',start_at:'2026-10-20T01:00:00Z',status:'reserved'}]):json([])});
  expect((await bad.app.inject({url:`${base}/treatment-context-options`,headers})).statusCode).toBe(503);
 });
 it('시술 이력도 짧은 첫 페이지 뒤 연결 기록을 읽고 부분 실패는 거절한다',async()=>{
  const {app}=build({provider:call=>{
   const offset=Number(call.url.searchParams.get('offset'));
   return {body:[{...treatmentRowJson,id:offset===0?treatmentId:visitId,appointment_id:offset===0?null:appointmentId}],headers:{'Content-Range':`${offset}-${offset}/2`}};
  }});
  const result=await app.inject({url:`${base}/treatments`,headers});expect(result.statusCode).toBe(200);expect(result.json()).toHaveLength(2);expect(result.json()[1].appointment_id).toBe(appointmentId);
  const broken=build({provider:call=>Number(call.url.searchParams.get('offset'))===0?{body:[treatmentRowJson],headers:{'Content-Range':'0-0/2'}}:json({},503)});
  expect((await broken.app.inject({url:`${base}/treatments`,headers})).statusCode).toBe(503);
 });
});
