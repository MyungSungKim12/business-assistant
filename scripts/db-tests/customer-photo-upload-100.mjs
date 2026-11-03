// Isolated PostgreSQL only: no Supabase network or real customer data.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const db=new PGlite();
const org=randomUUID(),other=randomUUID(),admin=randomUUID(),member=randomUUID(),outsider=randomUUID(),customer=randomUUID();
try{
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema private;create schema storage;
 grant usage on schema public,private,auth,storage to authenticated;
 create table auth.users(id uuid primary key);create table public.organizations(id uuid primary key);
 create table public.customers(id uuid primary key,organization_id uuid,unique(id,organization_id));
 create table public.memberships(organization_id uuid,user_id uuid,role text);
 create table storage.buckets(id text primary key,public boolean);insert into storage.buckets values('business-files',false);
 create table storage.objects(bucket_id text,name text,metadata jsonb);
 alter table storage.objects enable row level security;grant select,insert on storage.objects to authenticated;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function private.has_organization_role(target uuid,roles text[]) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.memberships where organization_id=target and user_id=auth.uid() and role=any(roles))$$;
 create function private.person_name(uuid) returns text language sql as $$select 'test'::text$$;`);
 for(const id of [admin,member,outsider])await db.query('insert into auth.users values($1)',[id]);
 for(const id of [org,other])await db.query('insert into organizations values($1)',[id]);
 await db.query('insert into customers values($1,$2)',[customer,org]);
 for(const [o,u,r] of [[org,admin,'admin'],[org,member,'member'],[other,outsider,'owner']])await db.query('insert into memberships values($1,$2,$3)',[o,u,r]);
 for(const file of ['022_customer_photos.sql','053_customer_photo_trash.sql'])await db.exec(await readFile(new URL(`../../migrations/${file}`,import.meta.url),'utf8'));
 const legacyMissing=randomUUID(),legacyValid=randomUUID();
 for(const id of [legacyMissing,legacyValid])await db.query(`insert into customer_photos(id,organization_id,customer_id,uploaded_by,storage_path,original_name,content_type,size_bytes) values($1,$2,$3,$4,$5,'legacy.png','image/png',4)`,[id,org,customer,admin,`legacy-${id}`]);
 await db.query(`insert into storage.objects values('business-files',$1,'{"size":4,"mimetype":"image/png"}')`,[`legacy-${legacyValid}`]);
 await db.exec(await readFile(new URL('../../migrations/100_customer_photo_upload_completion.sql',import.meta.url),'utf8'));
 assert.equal((await db.query('select upload_state from customer_photos where id=$1',[legacyMissing])).rows[0].upload_state,'pending');
 assert.equal((await db.query('select upload_state from customer_photos where id=$1',[legacyValid])).rows[0].upload_state,'ready');
 await db.exec(await readFile(new URL('../../migrations/100_customer_photo_upload_completion.sql',import.meta.url),'utf8'));
 async function actor(id){await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);}
 async function photo(age=0){await actor(admin);const id=randomUUID(),path=`${org}/${customer}/${id}-test.png`;await db.query(`insert into customer_photos(id,organization_id,customer_id,uploaded_by,storage_path,original_name,content_type,size_bytes,created_at) values($1,$2,$3,$4,$5,'test.png','image/png',4,now()-($6::integer*interval '1 minute'))`,[id,org,customer,admin,path,age]);return{id,path};}
 async function object(p,size=4,type='image/png'){await db.exec('reset role');await db.query(`insert into storage.objects values('business-files',$1,$2)`,[p.path,JSON.stringify({size,mimetype:type})]);}
 const complete=p=>db.query('select public.complete_customer_photo_upload($1,$2,$3) result',[org,customer,p.id]);
 const state=async p=>(await db.query('select upload_state,is_archived,archived_reason,uploaded_at from customer_photos where id=$1',[p.id])).rows[0];
 const pending=await photo();assert.equal((await state(pending)).upload_state,'pending');
 await assert.rejects(complete(pending)); // no storage object
 await object(pending);await actor(admin);await complete(pending);await complete(pending); // idempotent
 assert.equal((await state(pending)).upload_state,'ready');assert.ok((await state(pending)).uploaded_at);
 const wrong=await photo();await object(wrong,5);await actor(admin);await assert.rejects(complete(wrong));
 const type=await photo();await object(type,4,'text/html');await actor(admin);await assert.rejects(complete(type));
 const crashed=await photo();await object(crashed);const expired=await photo(131);const fresh=await photo(120);
 await actor(member);await assert.rejects(complete(crashed)); // only managers can finalize explicitly
 await db.query('select public.reconcile_customer_photo_uploads($1,$2)',[org,customer]);
 assert.equal((await state(crashed)).upload_state,'ready');
 assert.deepEqual((({upload_state,is_archived,archived_reason})=>({upload_state,is_archived,archived_reason}))(await state(expired)),{upload_state:'failed',is_archived:true,archived_reason:'upload_failed'});
 assert.equal((await state(fresh)).upload_state,'pending');
 await actor(admin);await assert.rejects(db.query('select public.complete_customer_photo_upload($1,$2,$3)',[other,customer,pending.id]));
 await actor(outsider);await assert.rejects(complete(crashed));await assert.rejects(db.query('select public.reconcile_customer_photo_uploads($1,$2)',[org,customer]));
 await actor('');await assert.rejects(db.query('select public.reconcile_customer_photo_uploads($1,$2)',[org,customer]));
 console.log('PASS photo upload 100: missing/size/type, idempotency, crash recovery, expiry grace, role/org/anonymous, repeat migration');
}finally{await db.close();}
