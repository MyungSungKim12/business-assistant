import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const db=new PGlite();
const org=randomUUID(),other=randomUUID(),owner=randomUUID(),member=randomUUID(),outsider=randomUUID(),customer=randomUUID(),otherCustomer=randomUUID();
const q=(sql,values=[])=>db.query(sql,values),one=async(sql,values=[])=> (await q(sql,values)).rows[0];
const denied=(action,code)=>assert.rejects(action,error=>{assert.equal(error.code,code,error.message);return true;});
async function actor(id=owner){await db.exec('reset role;set role authenticated');await q("select set_config('request.jwt.claim.sub',$1,false)",[id]);}

try{
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema private;grant usage on schema auth,private,public to authenticated,anon;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table auth.users(id uuid primary key);create table organizations(id uuid primary key);
 create table memberships(organization_id uuid,user_id uuid,role text);
 create table customers(id uuid primary key,organization_id uuid not null,name text,status text default 'active');create unique index customers_org_id on customers(id,organization_id);
 create function private.has_organization_role(target uuid,roles text[]) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.memberships where organization_id=target and user_id=auth.uid() and role=any(roles))$$;
 create table treatment_sale_drafts(id uuid primary key,organization_id uuid not null,customer_id uuid not null,description text not null,amount numeric(14,2) not null,source_snapshot jsonb not null);
 create table finance_transactions(id uuid primary key default gen_random_uuid(),organization_id uuid not null,transaction_type text not null,amount numeric(14,2) not null,transaction_date date not null,category text not null,counterparty text not null default '',memo text not null default '',is_archived boolean not null default false,created_by uuid not null,created_at timestamptz default now(),updated_at timestamptz default now());grant select,insert,update,delete on finance_transactions to authenticated;`);
 await q('insert into auth.users values($1),($2),($3)',[owner,member,outsider]);await q('insert into organizations values($1),($2)',[org,other]);
 await q("insert into memberships values($1,$2,'owner'),($1,$3,'member'),($4,$5,'owner')",[org,owner,member,other,outsider]);
 await q("insert into customers values($1,$2,'고객','active'),($3,$4,'다른 조직 고객','active')",[customer,org,otherCustomer,other]);
 for(const name of ['024_visit_sale_carts.sql','034_appointments.sql','037_appointment_availability.sql','038_appointment_resources.sql','050_service_staff.sql','062_appointment_status_history.sql','063_staff_profile_lifecycle.sql','073_organization_branches.sql','074_appointment_branch_scope.sql','110_appointment_visit_groups.sql']) await db.exec(await readFile(new URL(`../../migrations/${name}`,import.meta.url),'utf8'));
 await actor();
 const staff1=(await one('select create_appointment_staff($1,$2) data',[org,'직원 1'])).data;
 const staff2=(await one('select create_appointment_staff($1,$2) data',[org,'직원 2'])).data;
 const branchB=(await one('select create_organization_branch($1,$2,$3,$4,$5) data',[org,'BRANCH-2','두 번째 지점','Asia/Seoul',randomUUID()])).data;
 const staff3=(await one('select create_appointment_staff($1,$2) data',[org,'지점 직원'])).data;
 await one('select assign_appointment_staff_branch($1,$2,$3,$4)',[org,staff3.id,branchB.id,staff3.profile_version]);
 const service1=(await one('select create_appointment_service($1,$2,$3,$4) data',[org,'클렌징',30,5])).data;
 const service2=(await one('select create_appointment_service($1,$2,$3,$4) data',[org,'진정관리',45,0])).data;
 const service3=(await one('select create_appointment_service($1,$2,$3,$4) data',[org,'레이저',30,0])).data;
 await one('select set_appointment_service_staff($1,$2,$3)',[org,service1.id,[staff1.id]]);
 const start='2027-04-01T10:00:00+09:00',operation=randomUUID();
 const input=[org,customer,start,'phone',JSON.stringify([
  {service_id:service1.id,staff_id:staff1.id,resource_ids:[]},
  {service_id:service2.id,staff_id:staff2.id,resource_ids:[]},
 ]),operation];
 const created=(await one('select public.create_appointment_visit_group($1,$2,$3,$4,$5::jsonb,$6) data',input)).data;
 assert.equal(created.created[0].visit_group_version,1);assert.equal(created.created[1].visit_group_version,1);
 assert.equal(created.created.length,2);assert.deepEqual(created.created.map(x=>x.visit_order),[1,2]);
 assert.equal(created.created[0].staff_id,staff1.id);assert.equal(created.created[1].staff_id,staff2.id);
 assert.equal(Date.parse(created.created[1].start_at)-Date.parse(created.created[0].start_at),35*60000);
 assert.deepEqual((await one('select public.create_appointment_visit_group($1,$2,$3,$4,$5::jsonb,$6) data',input)).data,created,'same request is replay-safe');
 await denied(one('select public.create_appointment_visit_group($1,$2,$3,$4,$5::jsonb,$6)',[org,customer,'2027-04-01T11:00:00+09:00','phone',JSON.stringify([{service_id:service1.id,staff_id:staff1.id,resource_ids:[]},{service_id:service2.id,staff_id:staff2.id,resource_ids:[]}]),operation]),'P0001');
 await actor(outsider);
 await denied(one('select public.create_appointment_visit_group($1,$2,$3,$4,$5::jsonb,$6)',[org,customer,'2027-04-02T10:00:00+09:00','phone',JSON.stringify([{service_id:service1.id,staff_id:staff1.id,resource_ids:[]},{service_id:service2.id,staff_id:staff2.id,resource_ids:[]}]),randomUUID()]),'42501');
 await actor(owner);
 await denied(one('select public.create_appointment_visit_group($1,$2,$3,$4,$5::jsonb,$6)',[org,otherCustomer,start,'phone',JSON.stringify([{service_id:service1.id,staff_id:staff1.id,resource_ids:[]},{service_id:service2.id,staff_id:staff2.id,resource_ids:[]}]),randomUUID()]),'P0002');
 const blocker=(await one('select save_appointment_with_resources($1,null,$2,$3,$4,$5,$6,null,$7,$8) data',[
  org,customer,staff1.id,service3.id,'2027-04-01T11:00:00+09:00','phone',randomUUID(),[]])).data;
 await db.exec('reset role');const groupCountBefore=(await one('select count(*)::int n from appointment_visit_groups where organization_id=$1',[org])).n;await actor(owner);
 await denied(one('select public.create_appointment_visit_group($1,$2,$3,$4,$5::jsonb,$6)',[org,customer,'2027-04-01T10:45:00+09:00','phone',JSON.stringify([{service_id:service1.id,staff_id:staff1.id,resource_ids:[]},{service_id:service2.id,staff_id:staff2.id,resource_ids:[]}]),randomUUID()]),'P0001');
 await db.exec('reset role');assert.equal((await one('select count(*)::int n from appointment_visit_groups where organization_id=$1',[org])).n,groupCountBefore,'conflicting bundle rolls back group/children');await actor(owner);
 await denied(one('select public.create_appointment_visit_group($1,$2,$3,$4,$5::jsonb,$6)',[org,customer,start,'phone',JSON.stringify([{service_id:service1.id,staff_id:staff1.id,resource_ids:[]}]),randomUUID()]),'22023');
 await denied(one('select public.create_appointment_visit_group($1,$2,$3,$4,$5::jsonb,$6)',[org,customer,'2027-04-03T10:00:00+09:00','phone',JSON.stringify([{service_id:service1.id,staff_id:staff2.id,resource_ids:[]},{service_id:service2.id,staff_id:staff1.id,resource_ids:[]}]),randomUUID()]),'22023');
 await denied(one('select public.create_appointment_visit_group($1,$2,$3,$4,$5::jsonb,$6)',[org,customer,'2027-04-04T10:00:00+09:00','phone',JSON.stringify([{service_id:service1.id,staff_id:staff1.id,resource_ids:[]},{service_id:service2.id,staff_id:staff3.id,resource_ids:[]}]),randomUUID()]),'22023');
 const rows=(await q('select id,visit_group_id,visit_order from appointments where visit_group_id=$1 order by visit_order',[created.visit_group_id])).rows;assert.equal(rows.length,2);
 await denied(one('select public.transition_appointment($1,$2,$3,$4,$5,$6)',[org,rows[0].id,'canceled','단독 취소 금지',1,randomUUID()]),'42501');
 await denied(one('select public.save_appointment_with_resources($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[
  org,rows[0].id,customer,staff2.id,service2.id,'2027-04-15T10:00:00+09:00','phone',1,randomUUID(),[]]),'42501');
 const replaceArgs=[org,created.visit_group_id,1,'2027-04-01T13:00:00+09:00','phone',JSON.stringify([
  {service_id:service2.id,staff_id:staff2.id,resource_ids:[]},
  {service_id:service1.id,staff_id:staff1.id,resource_ids:[]},
 ]),randomUUID()];
 const replaced=(await one('select public.replace_appointment_visit_group($1,$2,$3,$4,$5,$6::jsonb,$7) data',replaceArgs)).data;
 assert.equal(replaced.version,2);assert.equal(replaced.created.length,2);
 assert.equal((await one('select count(*)::int n from appointments where visit_group_id=$1 and is_current',[created.visit_group_id])).n,2);
 assert.equal((await one('select count(*)::int n from appointments where visit_group_id=$1 and not is_current and status=\'canceled\'',[created.visit_group_id])).n,2);
 assert.deepEqual((await one('select public.replace_appointment_visit_group($1,$2,$3,$4,$5,$6::jsonb,$7) data',replaceArgs)).data,replaced,'group replacement is replay-safe');
 const cancelArgs=[org,created.visit_group_id,2,'고객 요청 취소',randomUUID()];
 const canceled=(await one('select public.cancel_appointment_visit_group($1,$2,$3,$4,$5) data',cancelArgs)).data;
 assert.equal(canceled.status,'canceled');assert.equal(canceled.canceled.length,2);assert.equal(canceled.version,3);
 assert.equal((await one('select count(*)::int n from appointments where visit_group_id=$1 and is_current and status=\'canceled\'',[created.visit_group_id])).n,2);
 assert.deepEqual((await one('select public.cancel_appointment_visit_group($1,$2,$3,$4,$5) data',cancelArgs)).data,canceled,'group cancellation is replay-safe');
 assert.equal((await one('select count(*)::int n from appointments where id=$1',[blocker.id])).n,1);
 const checkin=(await one('select public.create_appointment_visit_group($1,$2,$3,$4,$5::jsonb,$6) data',[
  org,customer,'2027-04-01T18:00:00+09:00','phone',JSON.stringify([
   {service_id:service1.id,staff_id:staff1.id,resource_ids:[]},{service_id:service2.id,staff_id:staff2.id,resource_ids:[]},
  ]),randomUUID()])).data;
 const checkedIn=(await one('select public.transition_appointment_visit_group($1,$2,$3,$4,$5,$6) data',[org,checkin.visit_group_id,1,'checked_in',null,randomUUID()])).data;
 assert.equal(checkedIn.status,'active');assert.equal(checkedIn.updated.length,2);
 assert.deepEqual(checkedIn.updated.map(x=>x.visit_group_version),[2,2],'check-in advances the group version on every current segment');
 assert.equal((await one('select count(*)::int n from customer_visits where organization_id=$1 and customer_id=$2',[org,customer])).n,1,'all service segments create one customer visit');
 assert.equal((await one('select count(*)::int n from sale_carts where organization_id=$1',[org])).n,1,'the grouped check-in creates one cart');
 const completionOperation=randomUUID(),completionArgs=[org,checkin.visit_group_id,2,'completed',null,completionOperation];
 const completed=(await one('select public.transition_appointment_visit_group($1,$2,$3,$4,$5,$6) data',completionArgs)).data;
 assert.equal(completed.status,'completed');assert.equal(completed.version,3);assert.equal(completed.updated.length,2);
 assert.deepEqual(completed.updated.map(x=>x.visit_group_version),[3,3],'completion advances the group version on every current segment');
 assert.deepEqual((await one('select public.transition_appointment_visit_group($1,$2,$3,$4,$5,$6) data',completionArgs)).data,completed,'group completion is replay-safe');
 assert.equal((await one("select count(*)::int n from appointments where visit_group_id=$1 and is_current and status='completed'",[checkin.visit_group_id])).n,2);
 const noShow=(await one('select public.create_appointment_visit_group($1,$2,$3,$4,$5::jsonb,$6) data',[org,customer,'2027-04-02T18:00:00+09:00','phone',JSON.stringify([
  {service_id:service1.id,staff_id:staff1.id,resource_ids:[]},{service_id:service2.id,staff_id:staff2.id,resource_ids:[]},
 ]),randomUUID()])).data;
 const noShowArgs=[org,noShow.visit_group_id,1,'no_show','고객 미방문',randomUUID()];
 const markedNoShow=(await one('select public.transition_appointment_visit_group($1,$2,$3,$4,$5,$6) data',noShowArgs)).data;
 assert.equal(markedNoShow.status,'no_show');assert.equal(markedNoShow.updated.length,2);
 assert.deepEqual(markedNoShow.updated.map(x=>x.visit_group_version),[2,2],'no-show advances the group version on every current segment');
 await actor(member);const rls=(await q("select relrowsecurity from pg_class where oid='public.appointment_visit_groups'::regclass")).rows[0];assert.equal(rls.relrowsecurity,true);
 await denied(q('select * from public.appointment_visit_groups'),'42501');
 await db.exec('reset role;set role anon');await denied(one('select public.create_appointment_visit_group($1,$2,$3,$4,$5::jsonb,$6)',[org,customer,start,'phone',JSON.stringify([{service_id:service1.id,staff_id:staff1.id,resource_ids:[]},{service_id:service2.id,staff_id:staff2.id,resource_ids:[]}]),randomUUID()]),'42501');
 console.log('appointment visit group SQL110 checks passed');
}finally{await db.close();}
