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
const admin=async()=>{await db.exec('reset role');};
const file=(name)=>readFile(new URL(`../../migrations/${name}`,import.meta.url),'utf8');

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
 for (const name of ['006_tasks.sql','024_visit_sale_carts.sql','034_appointments.sql']) await db.exec(await file(name));
 await db.exec('grant select,insert,update,delete on public.tasks to authenticated;');
 await db.exec(await file('047_ops_memo_labels_consent.sql'));
 // 두 번 적용해도 안전하다(멱등).
 await db.exec(await file('047_ops_memo_labels_consent.sql'));

 // --- 할 일 라벨·체크리스트 ---
 await asUser(owner);
 const task=await one('insert into tasks(organization_id,created_by,title,labels,checklist) values($1,$2,$3,$4,$5) returning *',
  [org,owner,'정리',['재고','월말'],JSON.stringify([{id:'a',text:'상자 확인',done:false}])]);
 assert.deepEqual(task.labels,['재고','월말']);
 assert.equal(task.checklist[0].text,'상자 확인');
 const plain=await one('insert into tasks(organization_id,created_by,title) values($1,$2,$3) returning *',[org,owner,'기본']);
 assert.deepEqual(plain.labels,[]);assert.deepEqual(plain.checklist,[]);
 await fail(()=>q('update tasks set labels=$2 where id=$1',[task.id,Array.from({length:11},(_,i)=>`l${i}`)]),'23514');
 await fail(()=>q('update tasks set labels=$2 where id=$1',[task.id,['x'.repeat(301)]]),'23514');
 await fail(()=>q('update tasks set checklist=$2 where id=$1',[task.id,JSON.stringify(Array.from({length:51},(_,i)=>({id:String(i),text:'t',done:false})))]),'23514');
 await fail(()=>q('update tasks set checklist=$2 where id=$1',[task.id,JSON.stringify({a:1})]),'23514');
 await q('update tasks set checklist=$2 where id=$1',[task.id,JSON.stringify([{id:'a',text:'상자 확인',done:true}])]);
 assert.equal((await one('select checklist from tasks where id=$1',[task.id])).checklist[0].done,true);
 await asUser(outsider);
 assert.equal((await q('select * from tasks where organization_id=$1',[org])).rows.length,0);

 // --- 고객 마케팅 수신 동의 ---
 await admin();
 const fresh=randomUUID();
 const inserted=await one("insert into customers(id,organization_id,name,marketing_consent,marketing_consent_at) values($1,$2,'신규',true,'2000-01-01') returning *",[fresh,org]);
 assert.equal(inserted.marketing_consent,true);
 assert.ok(new Date(inserted.marketing_consent_at).getFullYear()>=2024,'동의 시각은 DB가 직접 찍는다');
 const base=await one('select * from customers where id=$1',[customer]);
 assert.equal(base.marketing_consent,false);assert.equal(base.marketing_consent_at,null);
 await q("update customers set name='이름 변경',marketing_consent_at='2001-01-01' where id=$1",[fresh]);
 const kept=await one('select * from customers where id=$1',[fresh]);
 assert.equal(kept.marketing_consent_at.toISOString(),inserted.marketing_consent_at.toISOString(),'다른 값 변경은 동의 시각을 건드리지 않는다');
 await q('update customers set marketing_consent=false where id=$1',[fresh]);
 assert.equal((await one('select marketing_consent_at from customers where id=$1',[fresh])).marketing_consent_at,null);
 await q('update customers set marketing_consent=true where id=$1',[customer]);
 assert.ok((await one('select marketing_consent_at from customers where id=$1',[customer])).marketing_consent_at);

 // --- 예약 메모 ---
 await asUser(owner);
 const staff=(await one('select create_appointment_staff($1,$2) data',[org,'담당자'])).data;
 const service=(await one('select create_appointment_service($1,$2,$3,$4) data',[org,'관리',60,10])).data;
 await admin();
 const appt=await one(`insert into appointments(organization_id,customer_id,staff_id,service_id,service_name_snapshot,duration_minutes,buffer_minutes,start_at,end_at,created_by,updated_by)
  values($1,$2,$3,$4,'관리',60,10,'2026-11-01T01:00:00Z','2026-11-01T02:00:00Z',$5,$5) returning *`,[org,customer,staff.id,service.id,owner]);
 assert.equal(appt.memo,'');
 await asUser(member);
 const saved=(await one('select set_appointment_memo($1,$2,$3) data',[org,appt.id,'알레르기 주의, 조용한 방'])).data;
 assert.equal(saved.memo,'알레르기 주의, 조용한 방');
 assert.equal(Number(saved.version),Number(appt.version),'메모 변경은 예약 버전을 올리지 않는다');
 assert.equal(saved.status,'reserved');
 assert.equal((await one('select set_appointment_memo($1,$2,$3) data',[org,appt.id,''])).data.memo,'');
 await fail(()=>one('select set_appointment_memo($1,$2,$3)',[org,appt.id,'가'.repeat(1001)]),'22023');
 await fail(()=>one('select set_appointment_memo($1,$2,$3)',[org,appt.id,null]),'22023');
 await fail(()=>one('select set_appointment_memo($1,$2,$3)',[org,randomUUID(),'없음']),'P0002');
 await asUser(outsider);
 await fail(()=>one('select set_appointment_memo($1,$2,$3)',[org,appt.id,'침입']),'42501');
 await fail(()=>q("update appointments set memo='직접 수정' where id=$1",[appt.id]),'42501');
 await fail(()=>one('select set_appointment_memo($1,$2,$3)',[other,appt.id,'다른 조직']),'P0002');
 console.log('PASS ops-047: task labels/checklist limits, marketing consent stamping, appointment memo roles and tenants');
} finally {
 await db.close();
}
