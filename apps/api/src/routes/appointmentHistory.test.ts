import { expect,it,vi } from 'vitest';
import { createApp } from '../app.js';
import { createAppointmentGateway } from '../supabase/appointments.js';
import { ApiFailure } from '../errors.js';
const org='11111111-1111-4111-8111-111111111111',apt='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333';
const event={id,organization_id:org,appointment_id:apt,appointment_version:2,previous_status:'reserved',next_status:'no_show',reason:'연락 불가',actor_id:id,occurred_at:'2026-10-19T01:00:00Z'};
const config={APP_SUPABASE_URL:'https://test.invalid',APP_SUPABASE_PUBLISHABLE_KEY:'public',APP_FILE_BUCKET:'files',APP_API_PORT:8000};
const url=`/api/v1/organizations/${org}/appointments/${apt}/status-events`,headers={authorization:'Bearer token'};
it('상태 이력을 조직·예약·읽기 권한으로 조회한다',async()=>{
 const fetcher=vi.fn(async(_input:Parameters<typeof fetch>[0],_init?:RequestInit)=>new Response(JSON.stringify([event])));
 const requireAccess=vi.fn(async()=> 'member');
 const app=createApp({appointments:createAppointmentGateway(config,fetcher),organizations:{requireAccess} as never});
 try{const r=await app.inject({url,headers});expect(r.statusCode).toBe(200);expect(r.json()).toEqual([event]);expect(requireAccess).toHaveBeenCalledWith('token',org,'task.basic');const body=JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));expect(body).toEqual({p_organization_id:org,p_appointment_id:apt});}finally{await app.close();}
});
it('인증·권한 거절은 이력 조회를 실행하지 않는다',async()=>{
 const history=vi.fn(),app=createApp({appointments:{history} as never,organizations:{requireAccess:async()=>{throw new ApiFailure(403,'Denied');}} as never});
 try{expect((await app.inject({url})).statusCode).toBe(401);expect((await app.inject({url,headers})).statusCode).toBe(403);expect(history).not.toHaveBeenCalled();}finally{await app.close();}
});
it('조직·예약 혼입·중복·역순은 거절한다',async()=>{
 for(const rows of [[{...event,organization_id:apt}],[{...event,appointment_id:org}],[event,event],[{...event,appointment_version:3},{...event,id:apt} ]]){
  const gateway=createAppointmentGateway(config,async()=>new Response(JSON.stringify(rows)));
  await expect(gateway.history!('token',org,apt)).rejects.toMatchObject({status:503});
 }
});
it('사유 없는 신규 노쇼 거절은 DB에서 판정해 이전 성공 요청의 재시도를 막지 않는다',async()=>{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({code:'22023'}),{status:400}));
 const app=createApp({appointments:createAppointmentGateway(config,fetcher),organizations:{requireAccess:async()=> 'member'} as never});
 try{const r=await app.inject({method:'POST',url:url.replace('/status-events','/transitions'),headers,payload:{target_status:'no_show',reason:null,expected_version:1,operation_id:id}});expect(r.statusCode).toBe(422);expect(fetcher).toHaveBeenCalledOnce();}finally{await app.close();}
});
it('사유 없는 이전 노쇼 성공 스냅샷도 API에서 복구할 수 있다',async()=>{
 const legacy={id:apt,organization_id:org,customer_id:id,staff_id:id,service_id:id,service_name_snapshot:'시술',duration_minutes:60,buffer_minutes:0,start_at:'2026-10-19T01:00:00Z',end_at:'2026-10-19T02:00:00Z',status:'no_show',source:'phone',cancellation_reason:null,version:2};
 const app=createApp({appointments:createAppointmentGateway(config,async()=>new Response(JSON.stringify(legacy))),organizations:{requireAccess:async()=> 'member'} as never});
 try{const r=await app.inject({method:'POST',url:url.replace('/status-events','/transitions'),headers,payload:{target_status:'no_show',reason:null,expected_version:1,operation_id:id}});expect(r.statusCode).toBe(200);expect(r.json()).toMatchObject(legacy);}finally{await app.close();}
});
