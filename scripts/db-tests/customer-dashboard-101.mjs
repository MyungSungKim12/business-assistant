import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const db=new PGlite(),org=randomUUID(),other=randomUUID(),user=randomUUID(),customer=randomUUID(),empty=randomUUID(),foreign=randomUUID();
try{
 await db.exec(`create role anon;create role authenticated;create schema private;create schema auth;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table public.memberships(organization_id uuid,user_id uuid,role text);
 create function private.has_organization_role(o uuid,r text[]) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.memberships where organization_id=o and user_id=auth.uid() and role=any(r))$$;
 create table public.customers(id uuid primary key,organization_id uuid,last_visit_date date,next_visit_date date);
 create table public.customer_visits(id uuid primary key,organization_id uuid,customer_id uuid,status text,opened_at timestamptz);
 create table public.appointments(id uuid primary key,organization_id uuid,customer_id uuid,status text,start_at timestamptz);
 create table public.treatment_records(id uuid primary key,organization_id uuid,customer_id uuid,status text,treatment_date date,next_visit_date date);
 grant usage on schema public,private,auth to authenticated;
 grant select on public.customers,public.customer_visits,public.appointments,public.treatment_records to authenticated;`);
 for(const table of ['customers','customer_visits','appointments','treatment_records'])await db.exec(`alter table public.${table} enable row level security;create policy tenant on public.${table} for select to authenticated using(private.has_organization_role(organization_id,array['owner','admin','member']::text[]));`);
 await db.query("insert into public.memberships values($1,$2,'member')",[org,user]);
 for(const [id,o]of[[customer,org],[empty,org],[foreign,other]])await db.query("insert into public.customers values($1,$2,'1990-01-01','2099-01-01')",[id,o]);
 const sql=await readFile(new URL('../../migrations/061_customer_visit_facts.sql',import.meta.url),'utf8');await db.exec(sql);await db.exec(sql);
 for(const [status,offset]of[['open','-5 days'],['closed','-4 days'],['canceled','-1 day'],['open','1 day']])await db.query('insert into public.customer_visits values($1,$2,$3,$4,now()+$5::interval)',[randomUUID(),org,customer,status,offset]);
 for(const [status,offset]of[['confirmed','3 days'],['reserved','2 days'],['no_show','1 day'],['canceled','1 day'],['checked_in','1 day'],['reserved','-1 day']])await db.query('insert into public.appointments values($1,$2,$3,$4,now()+$5::interval)',[randomUUID(),org,customer,status,offset]);
 for(const [status,offset,next]of[['completed',-3,7],['completed',-8,10],['draft',-1,5],['cancelled',0,1],['completed',1,9]])await db.query("insert into public.treatment_records values($1,$2,$3,$4,(now()at time zone 'Asia/Seoul')::date+$5::int,(now()at time zone 'Asia/Seoul')::date+$6::int)",[randomUUID(),org,customer,status,offset,next]);

 await db.exec("alter table public.customers add column name text default '고객';alter table public.customers add column status text default 'active';");
 const migration=await readFile(new URL('../../migrations/101_customer_dashboard_queries.sql',import.meta.url),'utf8');
 await db.exec(migration);await db.exec(migration);
 // More than any search page; counts must cover the organization, payload stays bounded.
 await db.query("insert into public.customers(id,organization_id,name,status) select gen_random_uuid(),$1,'추가'||n,'active' from generate_series(1,1500)n",[org]);
 await db.query("insert into public.appointments(id,organization_id,customer_id,status,start_at) select gen_random_uuid(),organization_id,id,'confirmed',now()+interval '1 day' from public.customers where organization_id=$1",[org]);
 await db.query("update public.customers set status='archived' where id=$1",[empty]);
 await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);
 const today=(await db.query("select ((now() at time zone 'Asia/Seoul')::date)::text as today")).rows[0].today;
 const dashboard=async(o=org)=>(await db.query('select public.get_customer_dashboard($1,$2::date) as result',[o,today])).rows[0].result;
 const result=await dashboard();
 assert.equal(result.active_count,1501);assert.equal(result.upcoming_count,1501);
 assert.equal(result.upcoming.length,10);assert.equal(result.recent.length,1);
 assert.equal(result.recent[0].id,customer);assert.equal(result.recent[0].last_visit_date,(await db.query("select ((now()at time zone 'Asia/Seoul')::date-3)::text as last")).rows[0].last);
 assert.ok(result.upcoming.every(row=>row.organization_id===org&&row.status!=='archived'));
 await assert.rejects(()=>dashboard(other),/access denied/);
 await db.query("select set_config('request.jwt.claim.sub','',false)");await assert.rejects(()=>dashboard(),/access denied/);
 await db.exec('reset role;set role anon');await assert.rejects(()=>dashboard(),/permission denied/);
 console.log('101 PASS: exact 1501 counts, bounded 10/5 payload, actual visit semantics, archived exclusion, tenant/JWT/anon denial, reapply.');
}finally{await db.close();}
