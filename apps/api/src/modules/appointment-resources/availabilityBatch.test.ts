import { expect,it } from 'vitest';
import { createAppointmentResourceGateway } from './gateway.js';
import { loadAvailability } from './availabilityRoutes.js';
import { ORG,OTHER_ORG,testConfig } from '../catalog/testkit.js';
const id=(n:number)=>`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`,service=id(9999),date='2026-12-14';
function fixture(count:number,options:{foreign?:boolean;failed?:boolean;wrongStaff?:boolean;missingCount?:boolean;cap?:number;timeOff?:unknown[];zone?:string;appointments?:unknown[]}={}){
 const calls:URL[]=[],people=Array.from({length:count},(_,n)=>({id:id(n),organization_id:ORG,name:`담당${n}`,is_active:true,schedule_version:1}));
 const fetcher=(async(input:Parameters<typeof fetch>[0])=>{
  const url=new URL(String(input)),table=url.pathname.split('/').at(-1)!;calls.push(url);
  const selected=url.searchParams.get('staff_id')?.replace(/^in\.\(/,'').replace(/^eq\./,'').replace(/\)$/,'').split(',')??people.map(p=>p.id);
  if(options.failed&&table==='appointment_staff_working_hours')return new Response('{}',{status:503});
  const rows:Record<string,unknown[]>={appointment_services:[{id:service,organization_id:ORG,name:'관리',duration_minutes:60,buffer_minutes:0,is_active:true,resource_version:1}],appointment_staff:people,appointment_resources:[],appointment_service_staff:[],appointment_service_resource_requirements:[],appointments:options.appointments??[],appointment_staff_working_hours:selected.map(staff_id=>({id:id(10000+people.findIndex(p=>p.id===staff_id)),organization_id:options.foreign?OTHER_ORG:ORG,staff_id:options.wrongStaff?id(5555):staff_id,weekday:1,start_time:'09:00:00',end_time:'18:00:00',timezone_name:options.zone??'Asia/Seoul'})),appointment_staff_time_off:options.timeOff??[]};
  const all=rows[table]??[],offset=Number(url.searchParams.get('offset')??0),limit=Math.min(Number(url.searchParams.get('limit')??200),['appointment_staff_working_hours','appointments'].includes(table)?(options.cap??250):250),batch=all.slice(offset,offset+limit);
  return new Response(JSON.stringify(batch),{headers:options.missingCount&&table==='appointment_staff_working_hours'?{}:{'Content-Range':all.length?`${offset}-${offset+batch.length-1}/${all.length}`:'*/0'}});
 }) as typeof fetch;
 return {gateway:createAppointmentResourceGateway(testConfig,fetcher),calls};
}
it('직원 10명은 9회 조회로 계산하고 직원별 재조회를 하지 않는다',async()=>{
 const {gateway,calls}=fixture(10);
 const result=await loadAvailability(gateway,'token',ORG,{service_id:service,date},new Date('2026-10-19T01:00:00Z'));
 expect(result.staff).toHaveLength(10);expect(result.slots.find(slot=>slot.start==='09:00')?.staff_ids).toHaveLength(10);
 expect(calls).toHaveLength(9);
 expect(calls.filter(url=>url.pathname.endsWith('/appointment_staff'))).toHaveLength(1);
});
it('100명도 50명씩 묶고 선택한 담당자만 조회할 수 있다',async()=>{
 const {gateway,calls}=fixture(100);
 await loadAvailability(gateway,'token',ORG,{service_id:service,date});
 const hours=calls.filter(url=>url.pathname.endsWith('/appointment_staff_working_hours'));
 expect(calls).toHaveLength(11);
 expect(hours).toHaveLength(2);expect(hours.every(url=>url.searchParams.get('staff_id')!.split(',').length===50)).toBe(true);
 calls.length=0;
 await loadAvailability(gateway,'token',ORG,{service_id:service,date,staff_id:id(20)});
 expect(calls.filter(url=>url.pathname.endsWith('/appointment_staff_working_hours'))).toHaveLength(1);
});
it('묶음 조회의 다른 조직·중간 실패를 제한 없음으로 바꾸지 않는다',async()=>{
 for(const options of [{foreign:true},{failed:true},{wrongStaff:true},{missingCount:true}]){
  const {gateway}=fixture(10,options);
  await expect(loadAvailability(gateway,'token',ORG,{service_id:service,date})).rejects.toMatchObject({status:503});
 }
});
it('서버가 작은 페이지를 돌려줘도 근무시간 누락 없이 전부 읽는다',async()=>{
 const {gateway}=fixture(10,{cap:1});
 expect(await gateway.getStaffSchedules('token',ORG,Array.from({length:10},(_,n)=>id(n)),date)).toHaveLength(10);
 const result=await loadAvailability(gateway,'token',ORG,{service_id:service,date});
 expect(result.slots.find(slot=>slot.start==='09:00')?.staff_ids).toHaveLength(10);
});
it('다른 시간대의 자정 이후 후보에도 휴무와 다음날 예약 충돌을 반영한다',async()=>{
 const off={id:id(50000),organization_id:ORG,staff_id:id(0),start_at:'2026-12-15T00:00:00+09:00',end_at:'2026-12-15T01:00:00+09:00',reason:'휴무',status:'active',version:1};
 const {gateway,calls}=fixture(1,{zone:'America/New_York',timeOff:[off]});
 const result=await loadAvailability(gateway,'token',ORG,{service_id:service,date});
 expect(result.slots.find(slot=>slot.start==='23:30')?.blocked).toContainEqual({code:'time_off',staff_id:id(0)});
 expect(calls.find(url=>url.pathname.endsWith('/appointment_staff_time_off'))?.searchParams.get('and')).toBe('(start_at.lt.2026-12-16T00:00:00+09:00,end_at.gt.2026-12-14T00:00:00+09:00)');
 const appointment={id:id(777),organization_id:ORG,customer_id:id(778),staff_id:id(0),service_id:service,service_name_snapshot:'관리',duration_minutes:30,buffer_minutes:0,start_at:off.start_at,end_at:'2026-12-15T00:30:00+09:00',status:'confirmed',source:'phone',cancellation_reason:null,version:1,resource_ids:[]};
 const second=fixture(1,{zone:'America/New_York',appointments:[appointment]});
 const booked=await loadAvailability(second.gateway,'token',ORG,{service_id:service,date});
 expect(booked.slots.find(slot=>slot.start==='23:30')?.blocked).toContainEqual({code:'staff_busy',staff_id:id(0)});
 expect(second.calls.find(url=>url.pathname.endsWith('/appointments'))?.searchParams.get('and')).toContain('start_at.lt.2026-12-16');
});
it('잘못된 직원 목록과 과도한 직원 묶음은 조회 전에 거절한다',async()=>{
 const {gateway,calls}=fixture(1);
 for(const ids of [[id(0),id(0)],['bad'],Array.from({length:2001},(_,n)=>id(n))])await expect(gateway.getStaffSchedules('token',ORG,ids,date)).rejects.toMatchObject({status:503});
 expect(calls).toHaveLength(0);
});
it('서버 한도 뒤쪽의 예약도 끝까지 읽어 충돌을 놓치지 않는다',async()=>{
 const row={organization_id:ORG,customer_id:id(333),staff_id:id(0),service_id:service,service_name_snapshot:'관리',duration_minutes:60,buffer_minutes:0,start_at:'2026-12-14T09:00:00+09:00',end_at:'2026-12-14T10:00:00+09:00',status:'canceled',source:'manual',cancellation_reason:'취소',version:1,resource_ids:[]};
 const {gateway}=fixture(1,{cap:1,appointments:[{...row,id:id(200)},{...row,id:id(201),status:'confirmed',cancellation_reason:null}]});
 const result=await loadAvailability(gateway,'token',ORG,{service_id:service,date});
 expect(result.slots.find(slot=>slot.start==='09:00')?.available).toBe(false);
});
it('active 휴무 조회에 취소·다른 직원의 휴무가 섞이면 실패한다',async()=>{
 const base={id:id(50000),organization_id:ORG,staff_id:id(0),start_at:'2026-12-14T09:00:00+09:00',end_at:'2026-12-14T10:00:00+09:00',reason:'휴무',status:'active',version:1};
 for(const off of [{...base,status:'canceled'},{...base,staff_id:id(100)}]){
  const {gateway}=fixture(1,{timeOff:[off]});
  await expect(loadAvailability(gateway,'token',ORG,{service_id:service,date})).rejects.toMatchObject({status:503});
 }
});
