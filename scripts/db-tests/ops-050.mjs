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
const asUser=async(id)=>{await db.exec('reset role;set role authenticated');await q("select set_config('request.jwt.claim.sub',$1,false)",[id]);};
const file=(name)=>readFile(new URL(`../../migrations/${name}`,import.meta.url),'utf8');
const setStaff=async(service,ids)=>(await one('select set_appointment_service_staff($1,$2,$3) data',[org,service,ids])).data;
const slot=async(id,staff,service,start,version=null)=>(await one(
 'select save_appointment($1,$2,$3,$4,$5,$6,$7,$8,$9) data',[org,id,customer,staff,service,start,'phone',version,randomUUID()])).data;

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
 for (const name of ['024_visit_sale_carts.sql','034_appointments.sql','037_appointment_availability.sql','038_appointment_resources.sql','050_service_staff.sql']) await db.exec(await file(name));
 await db.exec(await file('050_service_staff.sql')); // 멱등

 await asUser(owner);
 const staffA=(await one('select create_appointment_staff($1,$2) data',[org,'김원장'])).data;
 const staffB=(await one('select create_appointment_staff($1,$2) data',[org,'이실장'])).data;
 const staffC=(await one('select create_appointment_staff($1,$2) data',[org,'박직원'])).data;
 const skin=(await one('select create_appointment_service($1,$2,$3,$4) data',[org,'피부관리',60,10])).data;
 const nail=(await one('select create_appointment_service($1,$2,$3,$4) data',[org,'네일',30,0])).data;
 for (const s of [staffA,staffB,staffC]) {
  await one('select replace_appointment_staff_hours($1,$2,$3,$4,$5,$6) data',[org,s.id,'Asia/Seoul',JSON.stringify([{weekday:4,start:'09:00',end:'20:00'},{weekday:5,start:'09:00',end:'20:00'}]),1,randomUUID()]);
 }

 // --- 지정이 없으면 모든 직원이 가능하다(기본 동작 유지) ---
 const free=await slot(null,staffC.id,skin.id,'2026-10-08T10:00:00+09:00');
 assert.equal(free.staff_id,staffC.id);

 // --- 지정과 조회 ---
 assert.deepEqual(await setStaff(skin.id,[staffA.id,staffB.id]),[staffA.id,staffB.id].sort());
 assert.deepEqual((await q('select staff_id from appointment_service_staff where service_id=$1 order by staff_id',[skin.id])).rows.map(r=>r.staff_id),[staffA.id,staffB.id].sort());
 // 다시 지정하면 통째로 교체된다.
 assert.deepEqual(await setStaff(skin.id,[staffA.id]),[staffA.id]);
 assert.equal((await q('select * from appointment_service_staff where service_id=$1',[skin.id])).rows.length,1);

 // --- 새 예약은 담당 가능 직원만 ---
 const okAppt=await slot(null,staffA.id,skin.id,'2026-10-08T12:00:00+09:00');
 assert.equal(okAppt.staff_id,staffA.id);
 await fail(()=>slot(null,staffB.id,skin.id,'2026-10-08T14:00:00+09:00'),'22023');
 await fail(()=>slot(null,staffC.id,skin.id,'2026-10-08T15:00:00+09:00'),'22023');
 // 다른 서비스는 영향이 없다.
 assert.ok((await slot(null,staffB.id,nail.id,'2026-10-08T14:00:00+09:00')).id);

 // --- 수정: 담당자를 바꿀 때만 검사한다 ---
 const moved=await slot(okAppt.id,staffA.id,skin.id,'2026-10-08T13:00:00+09:00',okAppt.version);
 assert.equal(moved.staff_id,staffA.id);
 await fail(()=>slot(okAppt.id,staffB.id,skin.id,'2026-10-08T18:30:00+09:00',moved.version),'22023');
 // 나중에 목록에서 빠진 직원의 기존 예약은 시간 변경·상태 변경이 계속 가능하다.
 await setStaff(skin.id,[staffB.id]);
 const stillA=await slot(okAppt.id,staffA.id,skin.id,'2026-10-08T16:00:00+09:00',moved.version);
 assert.equal(stillA.staff_id,staffA.id);
 const confirmed=(await one('select transition_appointment($1,$2,$3,$4,$5,$6) data',[org,okAppt.id,'confirmed',null,stillA.version,randomUUID()])).data;
 assert.equal(confirmed.status,'confirmed');
 // 서비스를 바꾸는 수정도 새 서비스의 담당 가능 목록을 따른다.
 await setStaff(nail.id,[staffC.id]);
 await fail(()=>slot(okAppt.id,staffA.id,nail.id,'2026-10-08T16:00:00+09:00',confirmed.version),'22023');

 // --- 빈 배열이면 제한이 풀린다 ---
 assert.deepEqual(await setStaff(skin.id,[]),[]);
 assert.ok((await slot(null,staffC.id,skin.id,'2026-10-08T17:30:00+09:00')).id);

 // --- 입력 검증과 권한 ---
 await fail(()=>setStaff(skin.id,[staffA.id,staffA.id]),'22023');
 await fail(()=>setStaff(skin.id,[randomUUID()]),'22023');
 await fail(()=>setStaff(skin.id,null),'22023');
 await fail(()=>setStaff(randomUUID(),[staffA.id]),'P0002');
 await asUser(member);
 await fail(()=>setStaff(skin.id,[staffA.id]),'42501');
 assert.equal((await q('select * from appointment_service_staff where organization_id=$1',[org])).rows.length,1,'구성원도 목록은 읽을 수 있다');
 await fail(()=>q('insert into appointment_service_staff(organization_id,service_id,staff_id) values($1,$2,$3)',[org,skin.id,staffA.id]),'42501');
 await asUser(outsider);
 await fail(()=>one('select set_appointment_service_staff($1,$2,$3)',[other,skin.id,[staffA.id]]),'P0002');
 assert.equal((await q('select * from appointment_service_staff where organization_id=$1',[org])).rows.length,0);
 console.log('PASS ops-050: service staff mapping, enforcement on create/staff change only, replace semantics, roles, tenants');
} finally {
 await db.close();
}
