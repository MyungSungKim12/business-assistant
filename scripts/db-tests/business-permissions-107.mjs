import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const db=new PGlite(),org=randomUUID(),other=randomUUID(),owner=randomUUID(),admin=randomUUID(),member=randomUUID(),outsider=randomUUID();
async function actor(id){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');}
try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create schema private;grant usage on schema public,auth,private to authenticated;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table public.organizations(id uuid primary key);create table public.memberships(id uuid primary key default gen_random_uuid(),organization_id uuid,user_id uuid,role text,unique(organization_id,user_id));
 create table public.audit_events(id uuid primary key default gen_random_uuid(),organization_id uuid,actor_id uuid,action text,target_type text,target_id text,metadata jsonb,source text,created_at timestamptz default now());
 create function private.has_organization_role(o uuid,r text[]) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.memberships where organization_id=o and user_id=auth.uid() and role=any(r))$$;
 insert into organizations values('${org}'),('${other}');insert into memberships(organization_id,user_id,role) values('${org}','${owner}','owner'),('${org}','${admin}','admin'),('${org}','${member}','member'),('${other}','${outsider}','owner');`);
 try{await db.exec(await readFile(new URL('../../migrations/107_business_permissions.sql',import.meta.url),'utf8'));await db.exec(await readFile(new URL('../../migrations/108_business_permission_role_ceiling.sql',import.meta.url),'utf8'));}catch(error){throw new Error(error.message);}
 await actor(member);
 const baseline=(await db.query('select public.get_organization_business_permissions($1) p',[org])).rows[0].p;
 assert.equal(baseline['customer.read'],true);assert.equal(baseline['customer.manage'],false);assert.equal(baseline['payment.collect'],false);
 assert.equal((await db.query("select public.has_organization_business_permission($1,'customer.read') allowed",[org])).rows[0].allowed,true);
 assert.equal((await db.query("select public.has_organization_business_permission($1,'customer.manage') allowed",[org])).rows[0].allowed,false);
 await actor(owner);
 const grant={...baseline,'customer.manage':false,'treatment.manage':false,'payment.collect':false,'refund.approve':false,'data.export':true};
 await assert.rejects(db.query('select public.set_organization_member_permissions($1,$2,$3::jsonb)',[org,member,JSON.stringify({...grant,'customer.manage':true})]));
 const saved=(await db.query('select public.set_organization_member_permissions($1,$2,$3::jsonb) result',[org,member,JSON.stringify(grant)])).rows[0].result;
 assert.equal(saved.permissions['customer.manage'],false);assert.equal(saved.permissions['data.export'],true);
 await db.exec('reset role');assert.equal((await db.query('select count(*)::int n from audit_events')).rows[0].n,1);
 await actor(member);assert.equal((await db.query("select public.has_organization_business_permission($1,'customer.manage') allowed",[org])).rows[0].allowed,false);assert.equal((await db.query("select public.has_organization_business_permission($1,'data.export') allowed",[org])).rows[0].allowed,true);await assert.rejects(db.query('select public.get_organization_business_permissions($1)',[other]));
 await actor(admin);await assert.rejects(db.query('select public.set_organization_member_permissions($1,$2,$3::jsonb)',[org,member,JSON.stringify(grant)]));
 await actor(owner);await assert.rejects(db.query('select public.set_organization_member_permissions($1,$2,$3::jsonb)',[org,owner,JSON.stringify(grant)]));
 await assert.rejects(db.query('select public.set_organization_member_permissions($1,$2,$3::jsonb)',[org,outsider,JSON.stringify(grant)]));
 await assert.rejects(db.query('select public.set_organization_member_permissions($1,$2,$3::jsonb)',[org,member,JSON.stringify({...grant,'unknown.code':true})]));
 await db.exec('reset role');await db.query('delete from memberships where organization_id=$1 and user_id=$2',[org,member]);assert.equal((await db.query('select count(*)::int n from organization_member_permissions')).rows[0].n,0);
 console.log('business permissions SQL107 checks passed');
}finally{await db.close();}
