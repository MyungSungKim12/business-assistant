import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const db=new PGlite();
const org=randomUUID(),other=randomUUID(),owner=randomUUID(),member=randomUUID(),outsider=randomUUID();
const customer=randomUUID();
const legacyAppointment=randomUUID(),legacyOperation=randomUUID();
const q=(sql,values=[])=>db.query(sql,values);
const one=async(sql,values=[])=> (await q(sql,values)).rows[0];
const fail=(action,code)=>assert.rejects(action,error=>{assert.equal(error.code,code,error.message);return true;});
const user=async(id=owner)=>{await db.exec('reset role;set role authenticated');await q("select set_config('request.jwt.claim.sub',$1,false)",[id]);};
const slot=async(id,staff,service,start,version=null,op=randomUUID(),customerId=customer)=>(await one(
 'select save_appointment($1,$2,$3,$4,$5,$6,$7,$8,$9) data',
 [org,id,customerId,staff,service,start,'phone',version,op])).data;
const move=async(id,status,version,reason=null,op=randomUUID())=>(await one(
 'select transition_appointment($1,$2,$3,$4,$5,$6) data',[org,id,status,reason,version,op])).data;
const resourceSlot=async(id,staff,service,start,resources,version=null,op=randomUUID())=>(await one(
 'select save_appointment_with_resources($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) data',
 [org,id,customer,staff,service,start,'phone',version,op,resources])).data;

try {
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema private;
 grant usage on schema auth,private,public to authenticated,anon;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table auth.users(id uuid primary key);create table organizations(id uuid primary key);
 create table memberships(organization_id uuid,user_id uuid,role text);
 create table customers(id uuid primary key,organization_id uuid not null,name text,status text default 'active');
 create unique index customers_org_id on customers(id,organization_id);
 create function private.has_organization_role(target uuid,roles text[]) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.memberships where organization_id=target and user_id=auth.uid() and role=any(roles))$$;
 create table treatment_sale_drafts(id uuid primary key,organization_id uuid not null,customer_id uuid not null,description text not null,amount numeric(14,2) not null,source_snapshot jsonb not null);
 create table finance_transactions(id uuid primary key default gen_random_uuid(),organization_id uuid not null,transaction_type text not null,amount numeric(14,2) not null,transaction_date date not null,category text not null,counterparty text not null default '',memo text not null default '',is_archived boolean not null default false,created_by uuid not null,created_at timestamptz default now(),updated_at timestamptz default now());
 grant select,insert,update,delete on finance_transactions to authenticated;`);
 await q('insert into auth.users values($1),($2),($3)',[owner,member,outsider]);
 await q('insert into organizations values($1),($2)',[org,other]);
 await q("insert into memberships values($1,$2,'owner'),($1,$3,'member'),($4,$5,'owner')",[org,owner,member,other,outsider]);
 await q("insert into customers values($1,$2,'고객','active')",[customer,org]);
 await db.exec(await readFile(new URL('../../migrations/024_visit_sale_carts.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../migrations/034_appointments.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../migrations/037_appointment_availability.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../migrations/038_appointment_resources.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../migrations/056_appointment_waitlist.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../migrations/059_waitlist_idempotent_booking.sql',import.meta.url),'utf8'));
 if(process.argv.includes('--history')){
  // 034의 사유 없는 성공 노쇼 + 응답 유실을 그대로 남긴 업그레이드 상황.
  await q("insert into appointment_operations(organization_id,operation_id,actor_id,fingerprint,result_snapshot) values($1,$2,$3,md5(jsonb_build_object('id',$4::uuid,'status','no_show','reason',null,'version',1)::text),jsonb_build_object('id',$4::uuid,'status','no_show'))",[org,legacyOperation,owner,legacyAppointment]);
  const sql=await readFile(new URL('../../migrations/062_appointment_status_history.sql',import.meta.url),'utf8');
  await db.exec(sql);await db.exec(sql);
 }
 await user();
 if(process.argv.includes('--staff-profile')){
  await db.exec('reset role');
  const sql=await readFile(new URL('../../migrations/063_staff_profile_lifecycle.sql',import.meta.url),'utf8');
  await db.exec(sql);await db.exec(sql);await user();
  const worker=(await one('select create_appointment_staff($1,$2) data',[org,'수정 전'])).data;
  const operation=randomUUID();
  const args=[org,worker.id,'수정 이름',false,1,operation];
  const saved=(await one('select update_appointment_staff_profile($1,$2,$3,$4,$5,$6) data',args)).data;
  assert.equal(saved.name,'수정 이름');assert.equal(saved.is_active,false);assert.equal(saved.profile_version,2);
  assert.deepEqual((await one('select update_appointment_staff_profile($1,$2,$3,$4,$5,$6) data',args)).data,saved);
  await fail(()=>one('select update_appointment_staff_profile($1,$2,$3,$4,$5,$6)',[org,worker.id,'다른 입력',true,1,randomUUID()]),'P0001');
 }
 const staff=(await one('select create_appointment_staff($1,$2) data',[org,'담당자'])).data;
 const service=(await one('select create_appointment_service($1,$2,$3,$4) data',[org,'관리',60,10])).data;
 const otherStaff=(await one('select create_appointment_staff($1,$2) data',[org,'다른 담당자'])).data;
 const roomCreateOp=randomUUID();
 const room=(await one('select create_appointment_resource($1,$2,$3,$4) data',[
  org,'관리실 1','room',roomCreateOp])).data;
 assert.deepEqual((await one('select create_appointment_resource($1,$2,$3,$4) data',[
  org,'관리실 1','room',roomCreateOp])).data,room);
 await fail(()=>one('select create_appointment_resource($1,$2,$3,$4)',[
  org,'다른 이름','room',roomCreateOp]),'P0001');
 const equipment=(await one('select create_appointment_resource($1,$2,$3,$4) data',[
  org,'레이저 1','equipment',randomUUID()])).data;
 const requirementOp=randomUUID();
 const requirementPayload=JSON.stringify([{kind:'room',quantity:1},{kind:'equipment',quantity:1}]);
 const requirements=(await one('select replace_appointment_service_resource_requirements($1,$2,$3,$4,$5) data',[
  org,service.id,requirementPayload,1,requirementOp])).data;
 assert.equal(requirements.resource_version,2);
 assert.equal(requirements.requirements.length,2);
 assert.deepEqual((await one('select replace_appointment_service_resource_requirements($1,$2,$3,$4,$5) data',[
  org,service.id,requirementPayload,1,requirementOp])).data,requirements);
 const waitOperation=randomUUID();
 const waitInput=[org,customer,service.id,staff.id,'2026-10-16','오전 연락',waitOperation];
 const waitEntry=(await one('select create_appointment_waitlist($1,$2,$3,$4,$5,$6,$7) data',waitInput)).data;
 assert.equal(waitEntry.status,'waiting');
 assert.deepEqual((await one('select create_appointment_waitlist($1,$2,$3,$4,$5,$6,$7) data',waitInput)).data,waitEntry);
 await fail(()=>one('select create_appointment_waitlist($1,$2,$3,$4,$5,$6,$7) data',[
  org,customer,service.id,staff.id,'2026-10-17','다른 내용',waitOperation]),'P0001');
 const bookingOp=randomUUID(), bookingInput=[org,waitEntry.id,staff.id,'2026-10-16T11:10:00+09:00',[room.id,equipment.id],1,bookingOp];
 const converted=(await one('select book_appointment_from_waitlist($1,$2,$3,$4,$5,$6,$7) data',bookingInput)).data;
 assert.equal(converted.waitlist.status,'booked');
 assert.equal(converted.appointment.customer_id,customer);
 assert.equal(converted.appointment.service_id,service.id);
 assert.equal(converted.replayed,false);
 assert.equal((await one('select book_appointment_from_waitlist($1,$2,$3,$4,$5,$6,$7) data',bookingInput)).data.replayed,true);
 await fail(()=>one('select book_appointment_from_waitlist($1,$2,$3,$4,$5,$6,$7) data',[
  org,waitEntry.id,staff.id,'2026-10-16T12:30:00+09:00',[room.id,equipment.id],1,randomUUID()]),'P0001');
 await fail(()=>one('select book_appointment_from_waitlist($1,$2,$3,$4,$5,$6,$7) data',[
  other,waitEntry.id,staff.id,'2026-10-16T11:10:00+09:00',[room.id,equipment.id],1,randomUUID()]),'42501');
 await fail(()=>one('select replace_appointment_service_resource_requirements($1,$2,$3,$4,$5)',[
  org,service.id,JSON.stringify([{kind:'room',quantity:2}]),1,requirementOp]),'P0001');
 const hoursOp=randomUUID();
 const hours=(await one('select replace_appointment_staff_hours($1,$2,$3,$4,$5,$6) data',[
  org,staff.id,'Asia/Seoul',JSON.stringify([
   {weekday:4,start:'09:00',end:'18:00'},
   {weekday:5,start:'09:00',end:'18:00'},
  ]),1,hoursOp])).data;
 assert.equal(hours.schedule_version,2);
 assert.equal(hours.hours.length,2);
 assert.equal(hours.hours[0].organization_id,org);
 assert.equal(hours.hours[0].staff_id,staff.id);
 assert.equal(hours.hours[0].start_time,'09:00:00');
 assert.equal(hours.hours[0].end_time,'18:00:00');
 assert.deepEqual((await one('select replace_appointment_staff_hours($1,$2,$3,$4,$5,$6) data',[
  org,staff.id,'Asia/Seoul',JSON.stringify([
   {weekday:4,start:'09:00',end:'18:00'},
   {weekday:5,start:'09:00',end:'18:00'},
  ]),1,hoursOp])).data,hours);
 await fail(()=>one('select replace_appointment_staff_hours($1,$2,$3,$4,$5,$6)',[
  org,staff.id,'Asia/Seoul',JSON.stringify([{weekday:4,start:'10:00',end:'18:00'}]),1,hoursOp]),'P0001');
 const start='2026-10-08T10:00:00+09:00';
 const op=randomUUID();
 let appointment=await resourceSlot(null,staff.id,service.id,start,[room.id,equipment.id],null,op);
 assert.deepEqual(await resourceSlot(null,staff.id,service.id,start,[room.id,equipment.id],null,op),appointment);
 await fail(()=>resourceSlot(null,staff.id,service.id,'2026-10-08T11:00:00+09:00',[room.id,equipment.id],null,op),'P0001');
 await fail(()=>resourceSlot(null,staff.id,service.id,'2026-10-08T11:00:00+09:00',[room.id,equipment.id]),'P0001');
 await fail(()=>resourceSlot(null,otherStaff.id,service.id,'2026-10-09T12:00:00+09:00',[room.id,room.id,equipment.id]),'22023');
 await fail(()=>one('select update_appointment_resource($1,$2,$3,$4,$5,$6)',[
  org,room.id,'관리실 1',false,1,randomUUID()]),'P0001');
 await fail(()=>one('select save_appointment($1,$2,$3,$4,$5,$6,$7,$8,$9)',
  [org,null,customer,staff.id,service.id,start,null,null,randomUUID()]),'22023');
 const room2=(await one('select create_appointment_resource($1,$2,$3,$4) data',[
  org,'관리실 2','room',randomUUID()])).data;
 const equipment2=(await one('select create_appointment_resource($1,$2,$3,$4) data',[
  org,'레이저 2','equipment',randomUUID()])).data;
 assert.ok((await resourceSlot(null,staff.id,service.id,'2026-10-08T11:10:00+09:00',[room.id,equipment.id])).id);
 await fail(()=>resourceSlot(null,staff.id,service.id,'2026-10-08T08:00:00+09:00',[room.id,equipment.id]),'P0001');
 await fail(()=>resourceSlot(null,staff.id,service.id,'2026-10-08T17:00:00+09:00',[room.id,equipment.id]),'P0001');
 await fail(()=>resourceSlot(null,otherStaff.id,service.id,start,[room.id,equipment2.id]),'P0001');
 assert.ok((await resourceSlot(null,otherStaff.id,service.id,start,[room2.id,equipment2.id])).id);
 await fail(()=>resourceSlot(null,otherStaff.id,service.id,'2026-10-09T12:00:00+09:00',[room2.id]),'22023');
 const leave=(await one('select create_appointment_staff_time_off($1,$2,$3,$4,$5,$6) data',[
  org,staff.id,'2026-10-08T15:00:00+09:00','2026-10-08T16:00:00+09:00','교육',randomUUID()])).data;
 await fail(()=>one('select create_appointment_staff_time_off($1,$2,$3,$4,$5,$6)',[
  org,staff.id,'2026-10-08T15:30:00+09:00','2026-10-08T16:30:00+09:00','중복',randomUUID()]),'P0001');
 await fail(()=>resourceSlot(null,staff.id,service.id,'2026-10-08T14:30:00+09:00',[room.id,equipment.id]),'P0001');
 const canceledLeave=(await one('select cancel_appointment_staff_time_off($1,$2,$3,$4) data',[
  org,leave.id,1,randomUUID()])).data;
 assert.equal(canceledLeave.status,'canceled');
 assert.ok((await resourceSlot(null,staff.id,service.id,'2026-10-08T14:30:00+09:00',[room.id,equipment.id])).id);
 await fail(()=>resourceSlot(appointment.id,staff.id,service.id,'2026-10-08T13:00:00+09:00',[room.id,equipment.id],99),'P0001');
 appointment=await resourceSlot(appointment.id,staff.id,service.id,'2026-10-08T13:00:00+09:00',[room.id,equipment.id],appointment.version);
 assert.equal(appointment.version,2);
 appointment=await slot(
  appointment.id,staff.id,service.id,'2026-10-08T12:30:00+09:00',appointment.version
 );
 assert.deepEqual(appointment.resource_ids.sort(),[room.id,equipment.id].sort());
 await user(member);
 await fail(()=>one('select create_appointment_staff($1,$2)',[org,'권한 없음']),'42501');
 await fail(()=>one('select create_appointment_service($1,$2,$3,$4)',[org,'권한 없음',60,0]),'42501');
 await fail(()=>one('select update_appointment_resource($1,$2,$3,$4,$5,$6)',[
  org,room2.id,'권한 없음',false,1,randomUUID()]),'42501');
 await fail(()=>one('select replace_appointment_staff_hours($1,$2,$3,$4,$5,$6)',[
  org,staff.id,'Asia/Seoul','[]',2,randomUUID()]),'42501');
 await fail(()=>one('select create_appointment_staff_time_off($1,$2,$3,$4,$5,$6)',[
  org,staff.id,'2026-10-09T12:00:00+09:00','2026-10-09T13:00:00+09:00','권한 없음',randomUUID()]),'42501');
 appointment=await move(appointment.id,'confirmed',appointment.version);
 appointment=await move(appointment.id,'checked_in',appointment.version);
 assert.equal((await one('select count(*)::int n from customer_visits where appointment_id=$1',[appointment.id])).n,1);
 assert.equal((await one('select count(*)::int n from sale_carts c join customer_visits v on v.id=c.visit_id where v.appointment_id=$1',[appointment.id])).n,1);
 await fail(()=>move(appointment.id,'canceled',appointment.version,'취소'),'P0001');
 appointment=await move(appointment.id,'completed',appointment.version);
 await fail(()=>move(appointment.id,'completed',appointment.version),'P0001');
 await user();
 const pending=await resourceSlot(null,staff.id,service.id,'2026-10-09T10:00:00+09:00',[room.id,equipment.id]);
 await fail(()=>move(pending.id,'canceled',pending.version),'22023');
 const canceled=await move(pending.id,'canceled',pending.version,'고객 요청');
 assert.equal(canceled.cancellation_reason,'고객 요청');
 const nextAppointment=await resourceSlot(null,staff.id,service.id,'2026-10-09T10:00:00+09:00',[room.id,equipment.id]);
 assert.ok(nextAppointment.id);
 if(process.argv.includes('--history')){
  await fail(()=>move(nextAppointment.id,'no_show',1,''),'22023');
  await fail(()=>move(nextAppointment.id,'no_show',1,'x'.repeat(1001)),'22023');
  assert.equal((await one('select get_appointment_status_events($1,$2) data',[org,nextAppointment.id])).data.length,0);
  const operation=randomUUID(),reason='  연락 불가  ';
  assert.deepEqual(await move(legacyAppointment,'no_show',1,null,legacyOperation),{id:legacyAppointment,status:'no_show'});
  assert.equal((await one('select count(*)::int n from appointment_status_events where appointment_id=$1',[legacyAppointment])).n,0);
  const noShow=await move(nextAppointment.id,'no_show',1,reason,operation);
  assert.equal(noShow.no_show_reason,'연락 불가');
  assert.equal(noShow.cancellation_reason,null);
  assert.deepEqual(await move(nextAppointment.id,'no_show',1,reason,operation),noShow);
  const events=(await one('select get_appointment_status_events($1,$2) data',[org,nextAppointment.id])).data;
  assert.equal(events.length,1);assert.equal(events[0].reason,'연락 불가');
  assert.equal(events[0].previous_status,'reserved');assert.equal(events[0].next_status,'no_show');
  assert.equal(events[0].actor_id,owner);
  assert.equal((await one('select get_appointment_status_events($1,$2) data',[org,appointment.id])).data.length,3);
  await fail(()=>move(nextAppointment.id,'no_show',1,reason,randomUUID()),'P0001');
  assert.equal((await one('select get_appointment_status_events($1,$2) data',[org,nextAppointment.id])).data.length,1);
  await fail(()=>q('insert into appointment_status_events(organization_id,appointment_id,appointment_version,previous_status,next_status,reason,actor_id,operation_id) values($1,$2,5,$3,$4,$5,$6,$7)',[org,nextAppointment.id,'reserved','no_show','침입',owner,randomUUID()]),'42501');
  await fail(()=>q('delete from appointment_status_events where appointment_id=$1',[nextAppointment.id]),'42501');
  await user(member);
  assert.equal((await one('select get_appointment_status_events($1,$2) data',[org,nextAppointment.id])).data.length,1);
  await fail(()=>q("update appointment_status_events set reason='변조' where appointment_id=$1",[nextAppointment.id]),'42501');
  await user(outsider);
  assert.equal((await q('select * from appointment_status_events where organization_id=$1',[org])).rows.length,0);
  await fail(()=>one('select get_appointment_status_events($1,$2)',[org,nextAppointment.id]),'42501');
  await user();
  await fail(()=>one('select get_appointment_status_events($1,$2)',[other,nextAppointment.id]),'42501');
  await fail(()=>one('select get_appointment_status_events($1,$2)',[org,randomUUID()]),'P0002');
  const rollback=await resourceSlot(null,staff.id,service.id,'2026-10-09T10:00:00+09:00',[room.id,equipment.id]);
  await db.exec("reset role;create function private.test_event_failure() returns trigger language plpgsql as $$begin raise exception 'event write failed' using errcode='P0001';end$$;create trigger test_event_failure before insert on appointment_status_events for each row execute function private.test_event_failure();");
  await user();
  const rollbackOperation=randomUUID();
  await fail(()=>move(rollback.id,'checked_in',1,null,rollbackOperation),'P0001');
  assert.equal((await one('select status from appointments where id=$1',[rollback.id])).status,'reserved');
  assert.equal((await one('select count(*)::int n from customer_visits where appointment_id=$1',[rollback.id])).n,0);
  assert.equal((await one('select count(*)::int n from appointment_operations where operation_id=$1',[rollbackOperation])).n,0);
  await db.exec('reset role;drop trigger test_event_failure on appointment_status_events;drop function private.test_event_failure();');
  await user();
  await db.exec('reset role;set role anon');
  await fail(()=>one('select get_appointment_status_events($1,$2)',[org,nextAppointment.id]),'42501');
  await user();
 }
 await user(outsider);
 assert.equal((await q('select * from appointments where organization_id=$1',[org])).rows.length,0);
 await fail(()=>slot(null,staff.id,service.id,'2026-10-10T10:00:00+09:00'),'42501');
 await fail(()=>one('select create_appointment_staff($1,$2)',[org,'침입']),'42501');
 await user();
 await fail(()=>one('select save_appointment($1,$2,$3,$4,$5,$6,$7,$8,$9)',[
  other,null,customer,staff.id,service.id,start,'phone',null,randomUUID()]),'42501');
 await fail(()=>q("update appointments set status='completed' where id=$1",[canceled.id]),'42501');
 if(process.argv.includes('--staff-profile')){
  const worker=(await one('select create_appointment_staff($1,$2) data',[org,'예약 있는 직원'])).data;
  const plainService=(await one('select create_appointment_service($1,$2,$3,$4) data',[org,'단순 관리',60,0])).data;
  const upcoming=randomUUID(),op=randomUUID();
  await db.exec('reset role');
  await q("insert into appointments(id,organization_id,customer_id,staff_id,service_id,service_name_snapshot,duration_minutes,buffer_minutes,start_at,end_at,created_by,updated_by) values($1,$2,$3,$4,$5,'기록',60,0,now()+interval '1 day',now()+interval '1 day 1 hour',$6,$6)",[upcoming,org,customer,worker.id,plainService.id,owner]);
  await user();
  const update=(active,version=1,operation=op)=>one('select update_appointment_staff_profile($1,$2,$3,$4,$5,$6) data',[org,worker.id,'이름 보존',active,version,operation]);
  await fail(()=>update(false),'P0001');
  assert.equal((await one('select profile_version from appointment_staff where id=$1',[worker.id])).profile_version,1);
  await user(member);await fail(()=>update(false),'42501');
  await user(outsider);await fail(()=>update(true),'42501');
  await db.exec("reset role;update appointments set status='checked_in',end_at=now()-interval '1 minute',start_at=now()-interval '2 hours' where id='"+upcoming+"'");
  await user();await fail(()=>update(false),'P0001');
  await db.exec("reset role;update appointments set status='completed' where id='"+upcoming+"'");
  await user();
  assert.equal((await update(false)).data.is_active,false);
  assert.equal((await one('select status from appointments where id=$1',[upcoming])).status,'completed');
  await db.exec('reset role');
  await fail(()=>q("insert into appointments(organization_id,customer_id,staff_id,service_id,service_name_snapshot,duration_minutes,buffer_minutes,start_at,end_at,created_by,updated_by) values($1,$2,$3,$4,'관리',60,0,now()+interval '2 days',now()+interval '2 days 1 hour',$5,$5)",[org,customer,worker.id,plainService.id,owner]),'22023');
  await user();assert.equal((await update(true,2,randomUUID())).data.is_active,true);
  const past=randomUUID();
  await db.exec('reset role');
  await q("insert into appointments(id,organization_id,customer_id,staff_id,service_id,service_name_snapshot,duration_minutes,buffer_minutes,start_at,end_at,created_by,updated_by) values($1,$2,$3,$4,$5,'지난 예약',60,0,now()-interval '2 days 1 hour',now()-interval '2 days',$6,$6)",[past,org,customer,worker.id,plainService.id,owner]);
  await user();await update(false,3,randomUUID());
  await fail(()=>move(past,'checked_in',1),'22023');
  assert.equal((await one('select status from appointments where id=$1',[past])).status,'reserved');
  assert.equal((await one('select count(*)::int n from customer_visits where appointment_id=$1',[past])).n,0);
 }
 console.log(process.argv.includes('--staff-profile')?'063 PASS: profile/version/replay, roles, future booking and checked-in guards, inactive assignment, history retention, reactivation, reapply':process.argv.includes('--history')?'062 PASS: no-show reasons, status events, legacy retries, atomic rollback, stale versions, direct DML/anonymous/tenant denial, check-in carts, reapply':'PASS appointments: staff/resource conflicts, retries, transitions, roles, tenants');
} finally {await db.close();}
