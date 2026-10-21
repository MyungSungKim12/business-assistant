import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
const organizationId='a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const appointment={id:'b9cc39fd-8e8c-4df8-a623-1f23a3a936bd',organization_id:organizationId,customer_id:'c9cc39fd-8e8c-4df8-a623-1f23a3a936bd',staff_id:'d9cc39fd-8e8c-4df8-a623-1f23a3a936bd',service_id:'e9cc39fd-8e8c-4df8-a623-1f23a3a936bd',service_name_snapshot:'피부관리',duration_minutes:60,buffer_minutes:10,start_at:'2026-10-13T01:00:00+00:00',end_at:'2026-10-13T02:00:00+00:00',status:'reserved',source:'manual',cancellation_reason:null,version:1};
describe('appointment list flow',()=>it('requires task access and returns only the route organization appointments',async()=>{const access={requireAccess:async(_t:string,id:string,feature:string)=>{expect(id).toBe(organizationId);expect(feature).toBe('task.basic');return'owner'}};const appointments={list:async()=>[appointment]};const app=createApp({organizations:access as never,appointments:appointments as never});const result=await app.inject({url:`/api/v1/organizations/${organizationId}/appointments`,headers:{authorization:'Bearer access'}});expect(result.statusCode).toBe(200);expect(result.json()).toEqual([appointment]);await app.close()}));

describe('appointment memo route',()=>{
 const id='b9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
 const build=()=>{const calls:string[]=[];const access={requireAccess:async(_t:string,_o:string,feature:string)=>{expect(feature).toBe('task.basic');return'member'}};const appointments={setMemo:async(_t:string,o:string,appointmentId:string,memo:string)=>{calls.push(`${o}:${appointmentId}:${memo}`);return{...appointment,memo}}};return{calls,app:createApp({organizations:access as never,appointments:appointments as never})}};
 it('saves a memo for the route organization and appointment',async()=>{const{app,calls}=build();const result=await app.inject({method:'PUT',url:`/api/v1/organizations/${organizationId}/appointments/${id}/memo`,headers:{authorization:'Bearer access'},payload:{memo:'알레르기 주의'}});expect(result.statusCode).toBe(200);expect(result.json()).toMatchObject({memo:'알레르기 주의'});expect(calls).toEqual([`${organizationId}:${id}:알레르기 주의`]);await app.close()});
 it('rejects over-long memos, unknown fields and bad IDs',async()=>{const{app,calls}=build();const put=(url:string,payload:unknown)=>app.inject({method:'PUT',url,headers:{authorization:'Bearer access'},payload:payload as never});const ok=`/api/v1/organizations/${organizationId}/appointments/${id}/memo`;expect((await put(ok,{memo:'가'.repeat(1001)})).statusCode).toBe(422);expect((await put(ok,{memo:'a',status:'completed'})).statusCode).toBe(422);expect((await put(ok,{})).statusCode).toBe(422);expect((await put(`/api/v1/organizations/${organizationId}/appointments/not-a-uuid/memo`,{memo:'a'})).statusCode).toBe(422);expect(calls).toEqual([]);await app.close()});
 it('allows clearing a memo with an empty string',async()=>{const{app,calls}=build();const result=await app.inject({method:'PUT',url:`/api/v1/organizations/${organizationId}/appointments/${id}/memo`,headers:{authorization:'Bearer access'},payload:{memo:''}});expect(result.statusCode).toBe(200);expect(calls).toEqual([`${organizationId}:${id}:`]);await app.close()});
});

describe('예약 대기 목록 route',()=>{
 const id='a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
 const build=()=>{const calls:string[]=[];const access={requireAccess:async(_t:string,_o:string,feature:string,write=false)=>{expect(feature).toBe('task.basic');calls.push(`access:${write}`);return'member'}};const appointments={listWaitlist:async(_t:string,o:string)=>{calls.push(`list:${o}`);return[]},createWaitlist:async(_t:string,o:string,input:unknown)=>{calls.push(`create:${o}:${JSON.stringify(input)}`);return{id,organization_id:o,status:'waiting',version:1}},updateWaitlist:async(_t:string,o:string,w:string,input:unknown)=>{calls.push(`update:${o}:${w}:${JSON.stringify(input)}`);return{id:w,organization_id:o,status:'contacted',version:2}},bookWaitlist:async(_t:string,o:string,w:string,input:unknown)=>{calls.push(`book:${o}:${w}:${JSON.stringify(input)}`);return{appointment:{...appointment,customer_id:id,service_id:id,source:'manual'},waitlist:{id:w,organization_id:o,customer_id:id,service_id:id,status:'booked',version:3},replayed:false}}};return{calls,app:createApp({organizations:access as never,appointments:appointments as never})}};
 it('lists, idempotently creates and updates an organization-scoped internal entry',async()=>{const{app,calls}=build();const base=`/api/v1/organizations/${organizationId}/appointment-waitlist`,headers={authorization:'Bearer access'};expect((await app.inject({url:base,headers})).statusCode).toBe(200);const payload={customer_id:id,service_id:id,staff_id:null,preferred_date:'2026-10-18',note:'오전 가능',operation_id:'c9cc39fd-8e8c-4df8-a623-1f23a3a936bd'};expect((await app.inject({method:'POST',url:base,headers,payload})).statusCode).toBe(201);expect((await app.inject({method:'PATCH',url:`${base}/${id}`,headers,payload:{expected_version:1,status:'contacted'}})).statusCode).toBe(200);expect(calls).toContain(`create:${organizationId}:${JSON.stringify(payload)}`);expect(calls).toContain(`list:${organizationId}`);expect(calls).toContain(`access:false`);await app.close()});
 it('books a waitlist row with a versioned, retriable request and returns both records',async()=>{const{app,calls}=build(),headers={authorization:'Bearer access'},url=`/api/v1/organizations/${organizationId}/appointment-waitlist/${id}/book`,payload={staff_id:id,start_at:'2026-10-18T10:00:00+09:00',resource_ids:[],expected_version:2,operation_id:'d9cc39fd-8e8c-4df8-a623-1f23a3a936bd'};const result=await app.inject({method:'POST',url,headers,payload});expect(result.statusCode).toBe(200);expect(result.json()).toMatchObject({appointment:{customer_id:id,service_id:id,source:'manual'},waitlist:{id,status:'booked',version:3}});expect(calls).toContain(`book:${organizationId}:${id}:${JSON.stringify(payload)}`);await app.close()});
 it('rejects invalid scope, status and payload before reaching the gateway',async()=>{const{app,calls}=build(),headers={authorization:'Bearer access'},base=`/api/v1/organizations/${organizationId}/appointment-waitlist`;expect((await app.inject({method:'POST',url:base,headers,payload:{customer_id:id,service_id:id,preferred_date:'18/10/2026',unexpected:true}})).statusCode).toBe(422);expect((await app.inject({method:'PATCH',url:`${base}/bad`,headers,payload:{status:'waiting',expected_version:1}})).statusCode).toBe(422);expect(calls).toEqual([]);await app.close()});
});

describe('반복 예약 route',()=>{
 it('updates only validated future series settings through write authorization',async()=>{
  const seriesId='f9cc39fd-8e8c-4df8-a623-1f23a3a936bd',staffId='d9cc39fd-8e8c-4df8-a623-1f23a3a936bd',serviceId='e9cc39fd-8e8c-4df8-a623-1f23a3a936bd',calls:string[]=[];
  const access={requireAccess:async(_t:string,o:string,feature:string,write=false)=>{calls.push(`access:${o}:${feature}:${write}`);return'owner'}};
  const appointments={updateSeriesFuture:async(_t:string,o:string,id:string,input:unknown)=>{calls.push(`update:${o}:${id}:${JSON.stringify(input)}`);return{series_id:seriesId,updated:[],replayed:false}}};
  const app=createApp({organizations:access as never,appointments:appointments as never}),url=`/api/v1/organizations/${organizationId}/appointment-series/${seriesId}/update-future`,headers={authorization:'Bearer access'};
  const payload={staff_id:staffId,service_id:serviceId,operation_id:'c9cc39fd-8e8c-4df8-a623-1f23a3a936bd'};
  expect((await app.inject({method:'POST',url,headers,payload})).statusCode).toBe(200);expect(calls[0]).toBe(`access:${organizationId}:task.basic:true`);expect(calls[1]).toContain(`update:${organizationId}:${seriesId}:`);
  expect((await app.inject({method:'POST',url,headers,payload:{...payload,unexpected:true}})).statusCode).toBe(422);await app.close();
 });
 it('reschedules future series cadence and resources through write authorization',async()=>{
  const seriesId='f9cc39fd-8e8c-4df8-a623-1f23a3a936bd',calls:string[]=[];
  const access={requireAccess:async(_t:string,o:string,feature:string,write=false)=>{calls.push(`access:${o}:${feature}:${write}`);return'owner'}};
  const appointments={rescheduleSeriesFuture:async(_t:string,o:string,id:string,input:unknown)=>{calls.push(`reschedule:${o}:${id}:${JSON.stringify(input)}`);return{series_id:seriesId,updated:[],replayed:false}}};
  const app=createApp({organizations:access as never,appointments:appointments as never}),url=`/api/v1/organizations/${organizationId}/appointment-series/${seriesId}/reschedule-future`,headers={authorization:'Bearer access'};
  const payload={from_occurrence_number:2,start_at:'2027-02-01T17:00:00+09:00',frequency:'monthly',interval_count:1,resource_ids:['a9cc39fd-8e8c-4df8-a623-1f23a3a936bd'],operation_id:'c9cc39fd-8e8c-4df8-a623-1f23a3a936bd'};
  expect((await app.inject({method:'POST',url,headers,payload})).statusCode).toBe(200);expect(calls[0]).toBe(`access:${organizationId}:task.basic:true`);expect(calls[1]).toContain(`reschedule:${organizationId}:${seriesId}:`);
  expect((await app.inject({method:'POST',url,headers,payload:{...payload,frequency:'daily'}})).statusCode).toBe(422);
  expect((await app.inject({method:'POST',url,headers,payload:{...payload,resource_ids:[...payload.resource_ids,...payload.resource_ids]}})).statusCode).toBe(422);await app.close();
 });
 it('cancels future series occurrences through write-authorized route',async()=>{
  const seriesId='f9cc39fd-8e8c-4df8-a623-1f23a3a936bd',calls:string[]=[];
  const access={requireAccess:async(_t:string,o:string,feature:string,write=false)=>{calls.push(`access:${o}:${feature}:${write}`);return'owner'}};
  const appointments={cancelSeriesFuture:async(_t:string,o:string,id:string,input:unknown)=>{calls.push(`cancel:${o}:${id}:${JSON.stringify(input)}`);return{series_id:seriesId,canceled:[],replayed:false}}};
  const app=createApp({organizations:access as never,appointments:appointments as never}),url=`/api/v1/organizations/${organizationId}/appointment-series/${seriesId}/cancel-future`;
  const payload={from_date:'2026-12-01',reason:'정기 시술 일정 종료',operation_id:'c9cc39fd-8e8c-4df8-a623-1f23a3a936bd'};
  expect((await app.inject({method:'POST',url,headers:{authorization:'Bearer access'},payload})).statusCode).toBe(200);
  expect(calls[0]).toBe(`access:${organizationId}:task.basic:true`);expect(calls[1]).toContain(`cancel:${organizationId}:${seriesId}:`);
  expect((await app.inject({method:'POST',url,headers:{authorization:'Bearer access'},payload:{...payload,from_date:'bad'}})).statusCode).toBe(422);
  await app.close();
 });
 it('lists bounded series only after organization read authorization',async()=>{
  const calls:string[]=[];const access={requireAccess:async(_t:string,o:string,feature:string,write=false)=>{calls.push(`access:${o}:${feature}:${write}`);return'member'}};
  const appointments={listSeries:async(_t:string,o:string,limit:number)=>{calls.push(`list:${o}:${limit}`);return[]}};
  const app=createApp({organizations:access as never,appointments:appointments as never}),url=`/api/v1/organizations/${organizationId}/appointment-series`;
  expect((await app.inject({url,headers:{authorization:'Bearer access'}})).statusCode).toBe(200);
  expect((await app.inject({url:`${url}?limit=101`,headers:{authorization:'Bearer access'}})).statusCode).toBe(422);
  expect(calls).toEqual([`access:${organizationId}:task.basic:false`,`list:${organizationId}:50`]);await app.close();
 });
 it('writes the organization-scoped recurring booking only after write authorization',async()=>{
  const calls:string[]=[];const access={requireAccess:async(_t:string,o:string,feature:string,write=false)=>{calls.push(`access:${o}:${feature}:${write}`);return'owner'}};
  const appointments={createSeries:async(_t:string,o:string,input:unknown)=>{calls.push(`series:${o}:${JSON.stringify(input)}`);return{series_id:'f9cc39fd-8e8c-4df8-a623-1f23a3a936bd',created:[{number:1,appointment}],skipped:[]}}};
  const app=createApp({organizations:access as never,appointments:appointments as never});const url=`/api/v1/organizations/${organizationId}/appointment-series`;
  const payload={customer_id:appointment.customer_id,staff_id:appointment.staff_id,service_id:appointment.service_id,start_at:'2026-10-20T10:00:00+09:00',frequency:'weekly',interval_count:1,occurrence_count:8,resource_ids:[],source:'manual',exception_dates:['2026-11-10'],operation_id:'c9cc39fd-8e8c-4df8-a623-1f23a3a936bd'};
  const result=await app.inject({method:'POST',url,headers:{authorization:'Bearer access'},payload});expect(result.statusCode).toBe(201);expect(result.json().created).toHaveLength(1);
  expect(calls[0]).toBe(`access:${organizationId}:task.basic:true`);expect(calls[1]).toContain(`series:${organizationId}:`);await app.close();
 });
 it('rejects malformed recurrence, duplicate resources and unknown fields',async()=>{
  const calls:string[]=[];const app=createApp({organizations:{requireAccess:async()=>{calls.push('access');return'owner'}} as never,appointments:{createSeries:async()=>{calls.push('write');return{}}} as never});const url=`/api/v1/organizations/${organizationId}/appointment-series`,headers={authorization:'Bearer access'};
  const payload={customer_id:appointment.customer_id,staff_id:appointment.staff_id,service_id:appointment.service_id,start_at:'2026-10-20T10:00:00+09:00',frequency:'daily',interval_count:13,occurrence_count:1,resource_ids:[],source:'manual',exception_dates:[],operation_id:'c9cc39fd-8e8c-4df8-a623-1f23a3a936bd',unexpected:true};
  expect((await app.inject({method:'POST',url,headers,payload})).statusCode).toBe(422);expect(calls).toEqual([]);await app.close();
 });
});

describe('대기 예약 제안 route',()=>{
 it('lists ranked proposals and records an accepted action under write access',async()=>{
  const calls:string[]=[];const offerId='f9cc39fd-8e8c-4df8-a623-1f23a3a936bd';const waitId='a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
  const access={requireAccess:async(_t:string,o:string,feature:string,write=false)=>{calls.push(`${o}:${feature}:${write}`);return'member'}};
  const offer={id:offerId,organization_id:organizationId,offer_group_id:'c9cc39fd-8e8c-4df8-a623-1f23a3a936bd',waitlist_id:waitId,rank:1,staff_id:appointment.staff_id,start_at:'2026-11-20T06:00:00Z',resource_ids:[],status:'offered',version:1,acted_by:null,acted_at:null,appointment_id:null,created_at:'2026-10-20T00:00:00Z'};
  const appointments={listWaitlistOffers:async()=>[offer],createWaitlistOffers:async(_t:string,_o:string,_id:string,input:unknown)=>{calls.push(JSON.stringify(input));return[offer]},actOnWaitlistOffer:async(_t:string,_o:string,id:string,input:unknown)=>{calls.push(`${id}:${JSON.stringify(input)}`);return{offer:{...offer,status:'accepted',version:2},appointment,replayed:false}}};
  const app=createApp({organizations:access as never,appointments:appointments as never}),headers={authorization:'Bearer access'},base=`/api/v1/organizations/${organizationId}/appointment-waitlist/${waitId}/offers`;
  expect((await app.inject({url:base,headers})).json()).toHaveLength(1);
  const payload={offers:[{staff_id:appointment.staff_id,start_at:'2026-11-20T15:00:00+09:00',resource_ids:[]}],expires_at:'2026-10-21T10:00:00+09:00',operation_id:'d9cc39fd-8e8c-4df8-a623-1f23a3a936bd'};
  expect((await app.inject({method:'POST',url:base,headers,payload})).statusCode).toBe(201);
  const action=await app.inject({method:'POST',url:`${base}/${offerId}/actions`,headers,payload:{action:'accept',expected_version:1,operation_id:'e9cc39fd-8e8c-4df8-a623-1f23a3a936bd'}});
  expect(action.statusCode).toBe(200);expect(action.json()).toMatchObject({offer:{status:'accepted'},appointment:{id:appointment.id}});
  expect(calls).toContain(`${organizationId}:task.basic:true`);await app.close();
 });
 it('rejects invalid actions and malformed ranked slots',async()=>{
  const calls:string[]=[];const app=createApp({organizations:{requireAccess:async()=>{calls.push('access');return'owner'}} as never,appointments:{createWaitlistOffers:async()=>{calls.push('create');return[]},actOnWaitlistOffer:async()=>{calls.push('act');return{}}} as never});const headers={authorization:'Bearer access'},base=`/api/v1/organizations/${organizationId}/appointment-waitlist/a9cc39fd-8e8c-4df8-a623-1f23a3a936bd/offers`;
  expect((await app.inject({method:'POST',url:base,headers,payload:{offers:[],expires_at:'bad',operation_id:'bad'}})).statusCode).toBe(422);
  expect((await app.inject({method:'POST',url:`${base}/bad/actions`,headers,payload:{action:'charge_fee',expected_version:1,operation_id:'bad'}})).statusCode).toBe(422);
  expect(calls).toEqual([]);await app.close();
 });
});
