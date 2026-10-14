import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const db=new PGlite();
const org=randomUUID(),other=randomUUID();
const owner=randomUUID(),creator=randomUUID(),worker=randomUUID(),bystander=randomUUID(),outsider=randomUUID(),noProfile=randomUUID();
const q=(sql,values=[])=>db.query(sql,values);
const one=async(sql,values=[])=> (await q(sql,values)).rows[0];
const fail=(action,code)=>assert.rejects(action,error=>{assert.equal(error.code,code,error.message);return true;});
const asUser=async(id)=>{await db.exec('reset role;set role authenticated');await q("select set_config('request.jwt.claim.sub',$1,false)",[id]);};
const admin=async()=>{await db.exec('reset role');};
const file=(name)=>readFile(new URL(`../../migrations/${name}`,import.meta.url),'utf8');
const task=(id)=>one('select * from tasks where id=$1',[id]);
const newTask=async(extra={})=>one(`insert into tasks(organization_id,created_by,title,due_at,assignee_id,recurrence,checklist)
 values($1,$2,$3,$4,$5,$6,$7) returning *`,[org,extra.created_by??creator,extra.title??'매장 청소',extra.due_at??null,extra.assignee_id??null,extra.recurrence??null,JSON.stringify(extra.checklist??[{id:'a',text:'바닥',done:false}])]);

try {
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema private;
 grant usage on schema auth,private,public to authenticated,anon;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table auth.users(id uuid primary key,email text);create table organizations(id uuid primary key);
 create table profiles(id uuid primary key references auth.users(id),display_name text not null default '');
 create table memberships(organization_id uuid,user_id uuid,role text);
 create table customers(id uuid primary key,organization_id uuid not null,name text,status text default 'active');
 create unique index customers_org_id on customers(id,organization_id);
 create function private.has_organization_role(target uuid,roles text[]) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.memberships where organization_id=target and user_id=auth.uid() and role=any(roles))$$;
 create table treatment_sale_drafts(id uuid primary key,organization_id uuid not null,customer_id uuid not null,description text not null,amount numeric(14,2) not null,source_snapshot jsonb not null);
 create table finance_transactions(id uuid primary key default gen_random_uuid(),organization_id uuid not null,transaction_type text not null,amount numeric(14,2) not null,transaction_date date not null,category text not null,counterparty text not null default '',memo text not null default '',is_archived boolean not null default false,created_by uuid not null,created_at timestamptz default now(),updated_at timestamptz default now());
 grant select,insert,update,delete on finance_transactions to authenticated;`);
 await q("insert into auth.users values($1,'owner@example.com'),($2,'creator@example.com'),($3,'worker@example.com'),($4,'bystander@example.com'),($5,'outsider@example.com'),($6,'nobody@example.com')",[owner,creator,worker,bystander,outsider,noProfile]);
 await q("insert into profiles values($1,'원장'),($2,'박직원'),($3,'김담당'),($4,'')",[owner,creator,worker,bystander]);
 await q('insert into organizations values($1),($2)',[org,other]);
 await q("insert into memberships values($1,$2,'owner'),($1,$3,'member'),($1,$4,'member'),($1,$5,'member'),($1,$6,'member'),($7,$8,'owner')",[org,owner,creator,worker,bystander,noProfile,other,outsider]);
 for (const name of ['006_tasks.sql','024_visit_sale_carts.sql','034_appointments.sql','047_ops_memo_labels_consent.sql','048_task_recurrence_customer.sql']) await db.exec(await file(name));
 await db.exec('grant select,insert,update,delete on public.tasks to authenticated;');
 await db.exec(await file('049_task_assignee_completion.sql'));
 await db.exec(await file('049_task_assignee_completion.sql')); // 멱등

 // --- 담당자는 같은 조직 구성원이어야 한다 ---
 await asUser(creator);
 await fail(()=>newTask({assignee_id:outsider}),'22023');
 const t1=await newTask({assignee_id:worker});
 assert.equal(t1.assignee_id,worker);assert.equal(t1.completed_by,null);

 // --- 담당자는 상태·체크리스트만 바꿀 수 있고, 완료자는 DB가 기록한다 ---
 await asUser(worker);
 await fail(()=>q("update tasks set title='바꿈' where id=$1",[t1.id]),'42501');
 await fail(()=>q('update tasks set assignee_id=$2 where id=$1',[t1.id,bystander]),'42501');
 await fail(()=>q("update tasks set description='메모' where id=$1",[t1.id]),'42501');
 await q('update tasks set checklist=$2 where id=$1',[t1.id,JSON.stringify([{id:'a',text:'바닥',done:true}])]);
 // 위조된 완료자 값은 무시된다.
 await q("update tasks set status='done',completed_by=$2,completed_by_name='위조',completed_at='2000-01-01' where id=$1",[t1.id,owner]);
 const done1=await task(t1.id);
 assert.equal(done1.status,'done');assert.equal(done1.completed_by,worker);assert.equal(done1.completed_by_name,'김담당');
 assert.ok(new Date(done1.completed_at).getFullYear()>=2024);
 assert.equal(done1.checklist[0].done,true);
 // 다시 열면 지워진다.
 await q("update tasks set status='open' where id=$1",[t1.id]);
 const reopened=await task(t1.id);
 assert.equal(reopened.completed_by,null);assert.equal(reopened.completed_at,null);assert.equal(reopened.completed_by_name,null);

 // --- 담당자가 아닌 다른 구성원은 수정할 수 없다(RLS가 행을 숨긴다) ---
 await asUser(bystander);
 assert.equal((await q("update tasks set status='done' where id=$1",[t1.id])).affectedRows,0);
 assert.equal((await task(t1.id)).status,'open');

 // --- 작성자와 관리자는 모든 필드를 수정하고, 완료자는 실제로 누른 사람이다 ---
 await asUser(creator);
 await q("update tasks set title='제목 수정' where id=$1",[t1.id]);
 await asUser(owner);
 await q("update tasks set status='done' where id=$1",[t1.id]);
 const byOwner=await task(t1.id);
 assert.equal(byOwner.completed_by,owner);assert.equal(byOwner.completed_by_name,'원장');
 assert.equal(byOwner.title,'제목 수정');
 await q('update tasks set assignee_id=$2 where id=$1',[t1.id,bystander]);
 assert.equal((await task(t1.id)).assignee_id,bystander);

 // --- 이름: 프로필 이름이 없으면 이메일 앞부분만(전체 이메일은 노출하지 않는다) ---
 await asUser(bystander);
 const t2=await newTask({created_by:bystander});
 await q("update tasks set status='done' where id=$1",[t2.id]);
 assert.equal((await task(t2.id)).completed_by_name,'bystander');
 await admin();
 const t3=await newTask({assignee_id:noProfile,created_by:creator});
 await asUser(noProfile);
 await q("update tasks set status='done' where id=$1",[t3.id]);
 assert.equal((await task(t3.id)).completed_by_name,'nobody');

 // --- 구성원에서 빠져도 완료자 기록은 남는다 ---
 await admin();
 await q('delete from memberships where user_id=$1',[noProfile]);
 assert.equal((await task(t3.id)).completed_by_name,'nobody');
 assert.equal((await task(t3.id)).completed_by,noProfile);

 // --- 구성원 이름 목록 ---
 await asUser(bystander);
 const people=(await q('select * from list_task_people($1)',[org])).rows;
 assert.deepEqual(people.map(p=>p.name).sort(),['bystander','김담당','박직원','원장'].sort());
 assert.deepEqual(Object.keys(people[0]).sort(),['name','user_id'],'이메일 컬럼이 없다');
 await asUser(outsider);
 await fail(()=>q('select * from list_task_people($1)',[org]),'42501');
 assert.equal((await q('select * from tasks where organization_id=$1',[org])).rows.length,0);

 // --- 반복 할 일: 담당자를 이어받고, 담당자가 나갔으면 비운 채 생성한다 ---
 await asUser(creator);
 const rec=await newTask({assignee_id:worker,recurrence:'weekly',due_at:'2099-01-10T01:00:00Z',title:'주간 점검'});
 await asUser(worker);
 await q("update tasks set status='done' where id=$1",[rec.id]);
 await admin();
 const next=await one('select * from tasks where recurrence_source_id=$1',[rec.id]);
 assert.equal(next.assignee_id,worker);assert.equal(next.completed_by,null);assert.equal(next.status,'open');
 const rec2=await one(`insert into tasks(organization_id,created_by,title,due_at,assignee_id,recurrence) values($1,$2,'월간',$3,$4,'monthly') returning *`,[org,creator,'2099-01-10T01:00:00Z',worker]);
 await q('delete from memberships where user_id=$1',[worker]);
 await asUser(owner);
 await q("update tasks set status='done' where id=$1",[rec2.id]);
 await admin();
 const next2=await one('select * from tasks where recurrence_source_id=$1',[rec2.id]);
 assert.ok(next2,'담당자가 나가도 완료와 다음 회차 생성은 성공한다');
 assert.equal(next2.assignee_id,null);
 console.log('PASS ops-049: assignee scope, DB-stamped completer, forged values ignored, names without email, recurrence carries assignee');
} finally {
 await db.close();
}
