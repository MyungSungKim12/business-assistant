import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const db=new PGlite();
const org=randomUUID(),other=randomUUID(),owner=randomUUID(),member=randomUUID(),outsider=randomUUID();
const customer=randomUUID(),otherCustomer=randomUUID();
const q=(sql,values=[])=>db.query(sql,values);
const one=async(sql,values=[])=> (await q(sql,values)).rows[0];
const fail=(action,code)=>assert.rejects(action,error=>{assert.equal(error.code,code,error.message);return true;});
const asUser=async(id)=>{await db.exec('reset role;set role authenticated');await q("select set_config('request.jwt.claim.sub',$1,false)",[id]);};
const admin=async()=>{await db.exec('reset role');};
const file=(name)=>readFile(new URL(`../../migrations/${name}`,import.meta.url),'utf8');
const iso=(value)=>new Date(value).toISOString();
const insertTask=async(extra={})=>{
 const row={title:'정기 점검',due_at:'2099-01-10T01:00:00Z',recurrence:null,customer_id:null,labels:['재고'],checklist:[{id:'a',text:'상자',done:true},{id:'b',text:'주문',done:false}],created_by:owner,...extra};
 return one(`insert into tasks(organization_id,created_by,title,due_at,recurrence,customer_id,labels,checklist,priority)
  values($1,$2,$3,$4,$5,$6,$7,$8,'high') returning *`,[org,row.created_by,row.title,row.due_at,row.recurrence,row.customer_id,row.labels,JSON.stringify(row.checklist)]);
};
const done=(id)=>q("update tasks set status='done' where id=$1",[id]);
const successors=(id)=>q('select * from tasks where recurrence_source_id=$1',[id]).then(r=>r.rows);

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
 await q("insert into customers values($1,$2,'고객','active'),($3,$4,'타조직 고객','active')",[customer,org,otherCustomer,other]);
 for (const name of ['006_tasks.sql','024_visit_sale_carts.sql','034_appointments.sql']) await db.exec(await file(name));
 await db.exec('grant select,insert,update,delete on public.tasks to authenticated;');
 await db.exec(await file('047_ops_memo_labels_consent.sql'));
 await db.exec(await file('048_task_recurrence_customer.sql'));
 await db.exec(await file('048_task_recurrence_customer.sql')); // 멱등

 // --- 제약 ---
 await asUser(owner);
 await fail(()=>insertTask({recurrence:'yearly'}),'23514');
 await fail(()=>insertTask({customer_id:otherCustomer}),'23503');
 const linked=await insertTask({customer_id:customer});
 assert.equal(linked.customer_id,customer);
 assert.equal((await insertTask()).recurrence,null);

 // --- 반복 생성: 일/주/월 ---
 const weekly=await insertTask({recurrence:'weekly',customer_id:customer});
 await done(weekly.id);
 const [w]=await successors(weekly.id);
 assert.equal(iso(w.due_at),'2099-01-17T01:00:00.000Z','매주: 7일 뒤 같은 시각');
 assert.equal(w.status,'open');assert.equal(w.recurrence,'weekly');assert.equal(w.customer_id,customer);
 assert.equal(w.priority,'high');assert.deepEqual(w.labels,['재고']);assert.equal(w.title,'정기 점검');assert.equal(w.created_by,owner);
 assert.deepEqual(w.checklist.map(i=>i.done),[false,false],'체크리스트는 미완료로 되돌려 복사');
 assert.deepEqual(w.checklist.map(i=>i.text),['상자','주문']);
 const daily=await insertTask({recurrence:'daily'});await done(daily.id);
 assert.equal(iso((await successors(daily.id))[0].due_at),'2099-01-11T01:00:00.000Z');
 const monthly=await insertTask({recurrence:'monthly',due_at:'2099-01-31T01:00:00Z'});await done(monthly.id);
 assert.equal(iso((await successors(monthly.id))[0].due_at),'2099-02-28T01:00:00.000Z','매월: 말일 보정');

 // --- 지난 기한은 오늘 이후까지 건너뛴다 ---
 const late=await insertTask({recurrence:'weekly',due_at:'2020-01-01T01:00:00Z'});await done(late.id);
 const lateNext=(await successors(late.id))[0];
 assert.ok(new Date(lateNext.due_at)>new Date(),'과거 기한의 다음 반복은 미래여야 한다');
 assert.equal(new Date(lateNext.due_at).getUTCDay(),new Date('2020-01-01T01:00:00Z').getUTCDay(),'요일은 유지');

 // --- 생성하지 않는 경우와 중복 방지 ---
 const plain=await insertTask();await done(plain.id);
 assert.equal((await successors(plain.id)).length,0);
 const noDue=await insertTask({recurrence:'daily',due_at:null});await done(noDue.id);
 assert.equal((await successors(noDue.id)).length,0,'기한이 없으면 반복하지 않는다');
 const again=await insertTask({recurrence:'daily'});
 await done(again.id);
 await q("update tasks set status='open' where id=$1",[again.id]);
 await done(again.id);
 assert.equal((await successors(again.id)).length,1,'다시 열었다 완료해도 다음 반복은 1건');
 await q("update tasks set status='in_progress' where id=$1",[w.id]);
 assert.equal((await successors(w.id)).length,0,'완료가 아닌 상태 변경은 생성하지 않는다');

 // --- 관리자가 구성원의 반복 할 일을 완료하면 작성자 이름으로 다음 할 일이 생긴다 ---
 await asUser(member);
 const mine=await insertTask({recurrence:'daily',created_by:member});
 await asUser(owner);
 await done(mine.id);
 const [mineNext]=await successors(mine.id);
 assert.equal(mineNext.created_by,member);
 await asUser(member);
 assert.equal((await q('select id from tasks where id=$1',[mineNext.id])).rows.length,1);

 // --- 테넌트 격리와 고객 삭제 ---
 await asUser(outsider);
 assert.equal((await q('select * from tasks where organization_id=$1',[org])).rows.length,0);
 await admin();
 await q('delete from customers where id=$1',[customer]);
 const orphan=await one('select * from tasks where id=$1',[linked.id]);
 assert.ok(orphan,'고객을 지워도 할 일은 남는다');
 assert.equal(orphan.customer_id,null);assert.equal(orphan.organization_id,org);
 console.log('PASS ops-048: recurrence spawning (daily/weekly/monthly, late skip, dedupe), customer link scope, tenants');
} finally {
 await db.close();
}
