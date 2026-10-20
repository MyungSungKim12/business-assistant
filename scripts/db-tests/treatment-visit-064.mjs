import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite();
const org=randomUUID(), other=randomUUID(), customer=randomUUID(), second=randomUUID(), owner=randomUUID(), member=randomUUID(), outsider=randomUUID();
const q=(text,values=[])=>db.query(text,values), one=async(text,values=[])=>(await q(text,values)).rows[0];
const fail=(run,code)=>assert.rejects(run,e=>{assert.equal(e.code,code,e.message);return true;});
const file=name=>readFile(new URL(`../../migrations/${name}`,import.meta.url),'utf8');
const user=async(id=owner)=>{await db.exec('reset role;set role authenticated');await q("select set_config('request.jwt.claim.sub',$1,false)",[id]);};
let checks=0; const check=async(name,fn)=>{await fn();checks++;console.log(`PASS ${name}`);};
try {
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema private;
 grant usage on schema auth,private,public to authenticated,anon;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table auth.users(id uuid primary key);create table organizations(id uuid primary key);
 create table memberships(organization_id uuid,user_id uuid,role text);
 create function private.has_organization_role(target uuid,roles text[]) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.memberships where organization_id=target and user_id=auth.uid() and role=any(roles))$$;
 create table customers(id uuid primary key,organization_id uuid not null,name text,status text default 'active',allergies text default '',skin_type text,concerns text[] default '{}',updated_at timestamptz default now(),unique(id,organization_id));
 create table treatment_sale_drafts(id uuid primary key,organization_id uuid not null,customer_id uuid not null,description text not null,amount numeric(14,2) not null,source_snapshot jsonb not null);`);
 await q('insert into auth.users values($1),($2),($3)',[owner,member,outsider]);await q('insert into organizations values($1),($2)',[org,other]);
 await q("insert into memberships values($1,$2,'owner'),($1,$3,'member'),($4,$5,'owner')",[org,owner,member,other,outsider]);
 await q("insert into customers(id,organization_id,name) values($1,$2,'고객'),($3,$2,'다른 고객')",[customer,org,second]);
 for(const name of ['014_customer_records.sql','016_treatment_lifecycle.sql','017_treatment_consultation.sql','024_visit_sale_carts.sql','034_appointments.sql'])await db.exec(await file(name));
 const migration=await file('064_treatment_visit_link.sql');await db.exec(migration);await db.exec(migration);
 await user();
 const staff=(await one('select create_appointment_staff($1,$2) data',[org,'담당'])).data;
 const service=(await one('select create_appointment_service($1,$2,$3,$4) data',[org,'관리',30,0])).data;
 const appointment=async(c=customer,start='2026-10-20T01:00:00Z')=>(await one('select save_appointment($1,null,$2,$3,$4,$5,$6,null,$7) data',[org,c,staff.id,service.id,start,'phone',randomUUID()])).data;
 const a=await appointment(), b=await appointment(second,'2026-10-20T03:00:00Z');
 const checked=(await one("select transition_appointment($1,$2,'checked_in',null,1,$3) data",[org,a.id,randomUUID()])).data;
 assert.equal(checked.status,'checked_in');
 const visit=await one('select * from customer_visits where appointment_id=$1',[a.id]);
 const treatment=await one("insert into treatment_records(organization_id,customer_id,treatment_name) values($1,$2,'관리') returning *",[org,customer]);
 const args=[org,customer,treatment.id,a.id,visit.id,1,randomUUID(),'접수 기록 연결'];
 const link=(values=args)=>one('select * from set_treatment_visit_link($1,$2,$3,$4,$5,$6,$7,$8)',values);
 await check('예약·방문 연결과 감사 이벤트 원자 저장',async()=>{
  const saved=await link();assert.equal(saved.appointment_id,a.id);assert.equal(saved.visit_id,visit.id);assert.equal(saved.version,2);
  const event=await one("select * from treatment_record_events where treatment_id=$1 and action='visit_link'",[treatment.id]);
  assert.equal(event.before_data.visit_id,null);assert.equal(event.after_data.visit_id,visit.id);assert.equal(event.reason,'접수 기록 연결');
 });
 await check('응답 유실 재시도는 이벤트·버전 중복 없음',async()=>{assert.equal((await link()).version,2);assert.equal((await one('select count(*)::int n from treatment_record_events where treatment_id=$1',[treatment.id])).n,1);});
 await check('멱등 키 변경 입력 및 낡은 버전 거절',async()=>{
  await fail(()=>link([...args.slice(0,7),'다른 사유']),'P0001');
  await fail(()=>link([...args.slice(0,6),randomUUID(),args[7]]),'P0001');
 });
 await check('다른 고객 예약·예약 없는 방문과 잘못 조합 거절',async()=>{
  await fail(()=>link([org,customer,treatment.id,b.id,null,2,randomUUID(),'다른 고객']),'22023');
  await fail(()=>link([org,customer,treatment.id,null,visit.id,2,randomUUID(),'잘못 조합']),'22023');
 });
 await check('다른 조직·member·미인증 변경 차단',async()=>{
  await user(outsider);await fail(()=>link(),'42501');await user(member);await fail(()=>link(),'42501');
  await user('');await fail(()=>link(),'42501');await user();
  await fail(()=>link([other,customer,treatment.id,null,null,2,randomUUID(),'조직 불일치']),'42501');
 });
 await check('클라이언트 직접 연결 필드 쓰기 차단',async()=>{await fail(()=>q('update treatment_records set visit_id=null where id=$1',[treatment.id]),'42501');});
 await check('한 방문에 여러 시술 연결 허용·추가 방문/수납 생성 없음',async()=>{
  const next=await one("insert into treatment_records(organization_id,customer_id,treatment_name) values($1,$2,'두 번째 관리') returning *",[org,customer]);
  await link([org,customer,next.id,a.id,visit.id,1,randomUUID(),'추가 시술']);
  assert.equal((await one('select count(*)::int n from customer_visits')).n,1);
  assert.equal((await one('select count(*)::int n from sale_carts')).n,1);
 });
 await check('연결 해제도 사유·버전·이력 보존',async()=>{
  const saved=await link([org,customer,treatment.id,null,null,2,randomUUID(),'잘못 연결하여 해제']);assert.equal(saved.version,3);assert.equal(saved.visit_id,null);
 });
 await check('워크인 방문 연결 허용·취소된 방문/예약 신규 연결 거절',async()=>{
  await db.exec('reset role');
  const walk=await one('insert into customer_visits(organization_id,customer_id,created_by,updated_by) values($1,$2,$3,$3) returning *',[org,customer,owner]);
  await user();assert.equal((await link([org,customer,treatment.id,null,walk.id,3,randomUUID(),'워크인 관리'])).visit_id,walk.id);
  await db.exec('reset role');await q("update customer_visits set status='canceled',closed_at=now() where id=$1",[walk.id]);await user();
  await fail(()=>link([org,customer,treatment.id,null,walk.id,4,randomUUID(),'취소 방문']),'22023');
  const canceled=await appointment(customer,'2026-10-21T01:00:00Z');
  await one("select transition_appointment($1,$2,'canceled','취소',1,$3)",[org,canceled.id,randomUUID()]);
  await fail(()=>link([org,customer,treatment.id,canceled.id,null,4,randomUUID(),'취소 예약']),'22023');
 });
 await check('방문 예약을 나중에 바꿔 기존 연결을 깨뜨릴 수 없다',async()=>{
  await db.exec('reset role');await fail(()=>q('update customer_visits set appointment_id=null where id=$1',[visit.id]),'23514');await user();
 });
 await check('완료 기록 연결 변경 금지',async()=>{
  await db.exec('reset role');await q("update treatment_records set status='completed' where id=$1",[treatment.id]);await user();
  await fail(()=>link([org,customer,treatment.id,a.id,visit.id,4,randomUUID(),'완료 후 변경']),'P0001');
 });
 await check('고객 병합처럼 한 트랜잭션에서 원장 고객 이동 허용',async()=>{
  await db.exec('reset role;begin');
  await q('update appointments set customer_id=$1 where id=$2',[second,a.id]);
  // Existing visit/cart constraints need their customer moves in one statement.
  await q('with v as (update customer_visits set customer_id=$1 where id=$2) update sale_carts set customer_id=$1 where visit_id=$2',[second,visit.id]);
  await q('with moved as (update treatment_records set customer_id=$1 where visit_id=$2 returning id) update treatment_record_events set customer_id=$1 where treatment_id in (select id from moved)',[second,visit.id]);
  await db.exec('commit');
 });
 await check('연결 후 부모 예약 고객만 바꾸는 잘못된 변경 차단',async()=>{
  await fail(()=>q('update appointments set customer_id=$1 where id=$2',[customer,a.id]),'23503');
 });
 console.log(`${checks} treatment visit link groups passed`);
} finally {await db.close();}
