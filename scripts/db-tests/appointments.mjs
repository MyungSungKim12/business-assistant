import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const db=new PGlite();
const org=randomUUID(),other=randomUUID(),owner=randomUUID(),member=randomUUID(),outsider=randomUUID();
const customer=randomUUID();
const q=(sql,values=[])=>db.query(sql,values);
const one=async(sql,values=[])=> (await q(sql,values)).rows[0];
const fail=(action,code)=>assert.rejects(action,error=>{assert.equal(error.code,code,error.message);return true;});
const user=async(id=owner)=>{await db.exec('reset role;set role authenticated');await q("select set_config('request.jwt.claim.sub',$1,false)",[id]);};
const slot=async(id,staff,service,start,version=null,op=randomUUID(),customerId=customer)=>(await one(
 'select save_appointment($1,$2,$3,$4,$5,$6,$7,$8,$9) data',
 [org,id,customerId,staff,service,start,'phone',version,op])).data;
const move=async(id,status,version,reason=null,op=randomUUID())=>(await one(
 'select transition_appointment($1,$2,$3,$4,$5,$6) data',[org,id,status,reason,version,op])).data;

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
 await user();
 const staff=(await one('select create_appointment_staff($1,$2) data',[org,'담당자'])).data;
 const service=(await one('select create_appointment_service($1,$2,$3,$4) data',[org,'관리',60,10])).data;
 const otherStaff=(await one('select create_appointment_staff($1,$2) data',[org,'다른 담당자'])).data;
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
 let appointment=await slot(null,staff.id,service.id,start,null,op);
 assert.deepEqual(await slot(null,staff.id,service.id,start,null,op),appointment);
 await fail(()=>slot(null,staff.id,service.id,'2026-10-08T11:00:00+09:00',null,op),'P0001');
 await fail(()=>slot(null,staff.id,service.id,'2026-10-08T11:00:00+09:00'),'P0001');
 await fail(()=>one('select save_appointment($1,$2,$3,$4,$5,$6,$7,$8,$9)',
  [org,null,customer,staff.id,service.id,start,null,null,randomUUID()]),'22023');
 assert.ok((await slot(null,staff.id,service.id,'2026-10-08T11:10:00+09:00')).id);
 await fail(()=>slot(null,staff.id,service.id,'2026-10-08T08:00:00+09:00'),'P0001');
 await fail(()=>slot(null,staff.id,service.id,'2026-10-08T17:00:00+09:00'),'P0001');
 const leave=(await one('select create_appointment_staff_time_off($1,$2,$3,$4,$5,$6) data',[
  org,staff.id,'2026-10-08T15:00:00+09:00','2026-10-08T16:00:00+09:00','교육',randomUUID()])).data;
 await fail(()=>one('select create_appointment_staff_time_off($1,$2,$3,$4,$5,$6)',[
  org,staff.id,'2026-10-08T15:30:00+09:00','2026-10-08T16:30:00+09:00','중복',randomUUID()]),'P0001');
 await fail(()=>slot(null,staff.id,service.id,'2026-10-08T14:30:00+09:00'),'P0001');
 const canceledLeave=(await one('select cancel_appointment_staff_time_off($1,$2,$3,$4) data',[
  org,leave.id,1,randomUUID()])).data;
 assert.equal(canceledLeave.status,'canceled');
 assert.ok((await slot(null,staff.id,service.id,'2026-10-08T14:30:00+09:00')).id);
 assert.ok((await slot(null,otherStaff.id,service.id,start)).id);
 await fail(()=>slot(appointment.id,staff.id,service.id,'2026-10-08T13:00:00+09:00',99),'P0001');
 appointment=await slot(appointment.id,staff.id,service.id,'2026-10-08T13:00:00+09:00',appointment.version);
 assert.equal(appointment.version,2);
 await user(member);
 await fail(()=>one('select create_appointment_staff($1,$2)',[org,'권한 없음']),'42501');
 await fail(()=>one('select create_appointment_service($1,$2,$3,$4)',[org,'권한 없음',60,0]),'42501');
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
 const pending=await slot(null,staff.id,service.id,'2026-10-09T10:00:00+09:00');
 await fail(()=>move(pending.id,'canceled',pending.version),'22023');
 const canceled=await move(pending.id,'canceled',pending.version,'고객 요청');
 assert.equal(canceled.cancellation_reason,'고객 요청');
 assert.ok((await slot(null,staff.id,service.id,'2026-10-09T10:00:00+09:00')).id);
 await user(outsider);
 assert.equal((await q('select * from appointments where organization_id=$1',[org])).rows.length,0);
 await fail(()=>slot(null,staff.id,service.id,'2026-10-10T10:00:00+09:00'),'42501');
 await fail(()=>one('select create_appointment_staff($1,$2)',[org,'침입']),'42501');
 await user();
 await fail(()=>one('select save_appointment($1,$2,$3,$4,$5,$6,$7,$8,$9)',[
  other,null,customer,staff.id,service.id,start,'phone',null,randomUUID()]),'42501');
 await fail(()=>q("update appointments set status='completed' where id=$1",[canceled.id]),'42501');
 console.log('PASS appointments: buffers, retries, versions, transitions, visit, roles, tenants');
} finally {await db.close();}
