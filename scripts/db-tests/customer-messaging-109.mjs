import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';

const db=new PGlite();
const org=randomUUID(),otherOrg=randomUUID(),owner=randomUUID(),admin=randomUUID(),member=randomUUID(),outsider=randomUUID();
const templateId=randomUUID(),marketingOk=randomUUID(),marketingNo=randomUUID(),inactive=randomUUID(),noPhone=randomUUID(),otherCustomer=randomUUID();
const op=randomUUID();
async function actor(id){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');}
try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create schema private;grant usage on schema public,auth,private to authenticated;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table public.organizations(id uuid primary key);create table public.memberships(id uuid primary key default gen_random_uuid(),organization_id uuid,user_id uuid,role text,unique(organization_id,user_id));
 create table public.audit_events(id uuid primary key default gen_random_uuid(),organization_id uuid,actor_id uuid,action text,target_type text,target_id text,metadata jsonb,source text,created_at timestamptz default now());
 create table public.customers(id uuid primary key,organization_id uuid,name text,phone text,status text,marketing_consent boolean,unique(organization_id,id));
 create function private.has_organization_role(o uuid,r text[]) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.memberships where organization_id=o and user_id=auth.uid() and role=any(r))$$;
 insert into organizations values('${org}'),('${otherOrg}');
 insert into memberships(organization_id,user_id,role) values('${org}','${owner}','owner'),('${org}','${admin}','admin'),('${org}','${member}','member'),('${otherOrg}','${outsider}','owner');
 insert into customers values('${marketingOk}','${org}','동의 고객','01011112222','active',true),('${marketingNo}','${org}','미동의 고객','01022223333','active',false),('${inactive}','${org}','휴면 고객','01033334444','archived',true),('${noPhone}','${org}','연락처 없는 고객',null,'active',true),('${otherCustomer}','${otherOrg}','다른 조직 고객','01044445555','active',true);`);
 try{await db.exec(await readFile(new URL('../../migrations/109_customer_messaging_outbox.sql',import.meta.url),'utf8'));}catch(error){console.error(error.code,error.message?.slice(0,500),error.cause?.message);throw error;}
 await actor(owner);
 const saved=(await db.query(`select public.save_organization_message_template($1,null,'재방문 안내','sms','marketing','#{customer_name}님, 다시 방문해 주세요.',null) result`,[org])).rows[0].result;
 const tid=saved.template.id;assert.equal(saved.template.version,1);
 await actor(member);await assert.rejects(db.query(`select public.save_organization_message_template($1,null,'불법 템플릿','sms','marketing','홍보',null)`,[org]));
 await actor(owner);
 const preview=(await db.query('select public.preview_organization_message_audience($1,$2,$3::uuid[]) result',[org,tid,[marketingOk,marketingNo,inactive,noPhone,otherCustomer]])).rows[0].result;
 assert.equal(preview.eligible.length,1);assert.equal(preview.eligible[0].customer_id,marketingOk);
 assert.deepEqual(new Set(preview.excluded.map(x=>x.reason)),new Set(['marketing_consent_required','customer_inactive','phone_missing','customer_not_found']));
 const first=(await db.query('select public.enqueue_organization_messages($1,$2,$3::uuid[],$4,$5) result',[org,tid,[marketingOk,marketingNo,inactive,noPhone,otherCustomer],null,op])).rows[0].result;
 assert.equal(first.created,1);assert.equal(first.excluded.length,4);
 const audience=[marketingOk,marketingNo,inactive,noPhone,otherCustomer];
 const repeated=(await db.query('select public.enqueue_organization_messages($1,$2,$3::uuid[],$4,$5) result',[org,tid,audience,null,op])).rows[0].result;
 assert.equal(repeated.created,0);assert.equal(repeated.messages.length,1);
 await assert.rejects(db.query('select public.enqueue_organization_messages($1,$2,$3::uuid[],$4,$5)',[org,tid,[marketingOk],null,op]));
 await db.exec('reset role');await db.query('update customers set marketing_consent=false where id=$1',[marketingOk]);await actor(owner);
 const withdrawn=(await db.query('select public.enqueue_organization_messages($1,$2,$3::uuid[],$4,$5) result',[org,tid,[marketingOk],null,randomUUID()])).rows[0].result;
 assert.equal(withdrawn.created,0);assert.equal(withdrawn.excluded[0].reason,'marketing_consent_required');
 const outboxId=first.messages[0].id,retryOp=randomUUID();
 await db.exec('reset role');await db.query("update organization_message_outbox set status='failed',attempt_count=1,failure_code='provider_timeout' where id=$1",[outboxId]);await actor(owner);
 await assert.rejects(db.query('select public.retry_organization_message($1,$2,1,$3)',[org,outboxId,retryOp]));
 await db.exec('reset role');await db.query('update customers set marketing_consent=true where id=$1',[marketingOk]);await actor(owner);
 const retry=(await db.query('select public.retry_organization_message($1,$2,1,$3) result',[org,outboxId,retryOp])).rows[0].result;assert.equal(retry.status,'queued');assert.equal(retry.provider_ready,false);
 const retryAgain=(await db.query('select public.retry_organization_message($1,$2,1,$3) result',[org,outboxId,retryOp])).rows[0].result;assert.equal(retryAgain.status,'queued');
 const cancelled=(await db.query('select public.cancel_organization_message($1,$2,1) result',[org,outboxId])).rows[0].result;assert.equal(cancelled.cancelled,true);
 const cancelAgain=(await db.query('select public.cancel_organization_message($1,$2,1) result',[org,outboxId])).rows[0].result;assert.equal(cancelAgain.cancelled,true);
 await db.exec('reset role');assert.equal((await db.query('select count(*)::int n from organization_message_outbox')).rows[0].n,1);assert.equal((await db.query("select count(*)::int n from audit_events where action like 'marketing.%'")).rows[0].n,3);
 await actor(outsider);await assert.rejects(db.query('select public.preview_organization_message_audience($1,$2,$3::uuid[])',[org,tid,[marketingOk]]));
 await db.exec('reset role');
 assert.equal((await db.query("select has_table_privilege('authenticated','public.organization_message_outbox','select') as allowed")).rows[0].allowed,false);
 console.log('customer messaging SQL109 checks passed');
}finally{await db.close();}
