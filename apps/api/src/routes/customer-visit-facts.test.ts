import { describe,expect,it } from 'vitest';
import { createApp } from '../app.js';
import { createCustomerGateway } from '../supabase/customers.js';
import { ApiFailure } from '../errors.js';
const org='11111111-1111-4111-8111-111111111111',customer='22222222-2222-4222-8222-222222222222';
const row={organization_id:org,customer_id:customer,last_actual_visit_date:'2026-10-18',next_appointment_at:'2026-10-20T01:00:00Z',recommended_return_date:'2026-10-25',as_of:'2026-10-19T01:00:00Z'};
describe('CRM visit facts',()=>{
 it('구성원의 읽기 요청에 조직·고객 목록을 RPC로 전달한다',async()=>{
  const calls:unknown[]=[];
  const gateway=createCustomerGateway({APP_SUPABASE_URL:'https://test.invalid',APP_SUPABASE_PUBLISHABLE_KEY:'test',APP_FILE_BUCKET:'business-files',APP_API_PORT:8000},async(_url,init)=>{calls.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify([row]));});
  const app=createApp({customers:gateway,organizations:{requireAccess:async(_t:string,o:string,f:string,write?:boolean)=>{expect([o,f,Boolean(write)]).toEqual([org,'crm.basic',false]);return 'member';}} as never});
  try{const r=await app.inject({method:'POST',url:`/api/v1/organizations/${org}/customers/visit-facts`,headers:{authorization:'Bearer test'},payload:{customer_ids:[customer]}});expect(r.statusCode).toBe(200);expect(r.json()).toEqual([row]);expect(calls).toEqual([{p_organization_id:org,p_customer_ids:[customer]}]);}finally{await app.close();}
 });
 it('인증·권한·잘못된 배치가 요약 조회를 우회하지 않는다',async()=>{
  let calls=0;
  const app=createApp({customers:{visitFacts:async()=>{calls++;return[row];}},organizations:{requireAccess:async()=>{throw new ApiFailure(403,'Access denied');}}} as never);
  try{
   const url=`/api/v1/organizations/${org}/customers/visit-facts`;
   expect((await app.inject({method:'POST',url,payload:{customer_ids:[customer]}})).statusCode).toBe(401);
   for(const ids of [[customer,customer],['bad'],Array(201).fill(customer)])expect((await app.inject({method:'POST',url,headers:{authorization:'Bearer test'},payload:{customer_ids:ids}})).statusCode).toBe(422);
   expect((await app.inject({method:'POST',url,headers:{authorization:'Bearer test'},payload:{customer_ids:[customer]}})).statusCode).toBe(403);expect(calls).toBe(0);
  }finally{await app.close();}
 });
 it('조직·고객 불일치 또는 누락·중복 RPC 결과는 거절한다',async()=>{
  for(const value of [[{...row,organization_id:customer}],[{...row,customer_id:org}],[],[row,row]]){
   const gateway=createCustomerGateway({APP_SUPABASE_URL:'https://test.invalid',APP_SUPABASE_PUBLISHABLE_KEY:'test',APP_FILE_BUCKET:'business-files',APP_API_PORT:8000},async()=>new Response(JSON.stringify(value)));
   await expect(gateway.visitFacts('test',org,[customer])).rejects.toMatchObject({status:503});
  }
 });
});
