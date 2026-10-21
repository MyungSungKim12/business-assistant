import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const db=new PGlite(),org=randomUUID(),other=randomUUID(),member=randomUUID(),admin=randomUUID(),file=randomUUID(),legacyPath=`${org}/${randomUUID()}-legacy.pdf`;
const q=(sql,args=[])=>db.query(sql,args),one=async(sql,args=[]) => (await q(sql,args)).rows[0];
async function asUser(id){await db.exec('reset role; set role authenticated');await q("select set_config('request.jwt.claim.sub',$1,false)",[id]);}
async function fails(fn,code){await assert.rejects(fn,e=>{assert.equal(e.code,code,e.message);return true})}
let checks=0;async function check(name,fn){await fn();console.log(`PASS ${name}`);checks++}
try{
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema private;create schema storage;grant usage on schema public,auth,private,storage to authenticated,anon;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table auth.users(id uuid primary key);create table public.organizations(id uuid primary key);create table storage.objects(bucket_id text not null,name text not null,metadata jsonb not null,primary key(bucket_id,name));
 create table public.file_assets(id uuid primary key,organization_id uuid not null references organizations(id),uploaded_by uuid not null references auth.users(id),storage_path text not null unique,original_name text not null,content_type text not null,size_bytes bigint not null,is_archived boolean not null default false,created_at timestamptz not null default now(),updated_at timestamptz not null default now());
 create table public.memberships(organization_id uuid,user_id uuid,role text);
 create function private.has_organization_role(target uuid,roles text[]) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.memberships where organization_id=target and user_id=auth.uid() and role=any(roles))$$;
 create function private.prevent_catalog_ledger_change() returns trigger language plpgsql as $$begin raise exception 'immutable' using errcode='42501';end$$;
 grant select,insert,update on public.file_assets to authenticated;`);
 await q('insert into auth.users values($1),($2)',[member,admin]);await q('insert into organizations values($1),($2)',[org,other]);await q("insert into memberships values($1,$2,'member'),($3,$2,'member'),($1,$4,'admin')",[org,member,other,admin]);
 await q('insert into file_assets(id,organization_id,uploaded_by,storage_path,original_name,content_type,size_bytes) values($1,$2,$3,$4,$5,$6,2048)',[file,org,member,legacyPath,'legacy.pdf','application/pdf']);
 await db.exec(await readFile(new URL('../../migrations/076_file_asset_versions.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../migrations/088_file_storage_quotas.sql',import.meta.url),'utf8'));
 await db.exec(`create table public.audit_events(id uuid primary key default gen_random_uuid(),organization_id uuid,actor_id uuid,action text not null check(action ~ '^[a-z][a-z0-9_]{1,40}(\\.[a-z][a-z0-9_]{1,40}){1,2}$'),target_type text not null,target_id text,metadata jsonb not null,source text not null default 'api_user',created_at timestamptz not null default now());`);
 await db.exec(await readFile(new URL('../../migrations/090_file_storage_quota_management.sql',import.meta.url),'utf8'));
 await q("insert into storage.objects values('business-files',$1,jsonb_build_object('size','2048'))",[legacyPath]);
 await db.exec('reset role');await q('update organization_file_storage_quotas set quota_bytes=5000 where organization_id=$1',[org]);
 await asUser(member);
 await check('파일 저장 한도는 owner/admin만 바꾸며 변경을 감사 기록한다',async()=>{
  await fails(()=>one('select set_organization_file_storage_quota($1,10737418240)',[org]),'42501');
  await fails(()=>q('update organization_file_storage_quotas set quota_bytes=999999 where organization_id=$1',[org]),'42501');
  await asUser(admin);const changed=await one('select set_organization_file_storage_quota($1,10737418240) usage',[org]);assert.equal(changed.usage.quota_bytes,10737418240);assert.equal(changed.usage.used_bytes,2048);
  await db.exec('reset role');const audit=await one("select action,metadata->>'quota_bytes' quota from audit_events where organization_id=$1",[org]);assert.equal(audit.action,'files.storage_quota_update');assert.equal(audit.quota,'10737418240');
  await asUser(admin);
  await fails(()=>one('select set_organization_file_storage_quota($1,1099511627777)',[org]),'22023');
  await one('select set_organization_file_storage_quota($1,5000)',[org]);
  await asUser(member);
 });
 await check('actual Storage usage and active reservations enforce the organization limit',async()=>{
  const usage=await one('select get_file_storage_usage($1) usage',[org]);assert.equal(usage.usage.used_bytes,2048);assert.equal(usage.usage.quota_bytes,5000);
  const reserve=randomUUID(),reservationPath=`${org}/${reserve}-within.pdf`;
  const held=await one('select reserve_file_storage_upload($1,$2,$3,$4) usage',[org,reserve,reservationPath,2952]);assert.equal(held.usage.available_bytes,0);assert.equal(held.usage.reserved_bytes,2952);
  await fails(()=>one('select reserve_file_storage_upload($1,$2,$3,$4)',[org,randomUUID(),`${org}/too-much.pdf`,1]),'22023');
  await q('select release_file_storage_upload($1,$2)',[org,reserve]);assert.equal((await one('select get_file_storage_usage($1) usage',[org])).usage.reserved_bytes,0);
  const foreign=randomUUID();await fails(()=>one('select reserve_file_storage_upload($1,$2,$3,$4)',[foreign,randomUUID(),`${foreign}/foreign.pdf`,1]),'42501');
 });
 await check('기존 파일은 버전 1로 이관되고 Storage 경로를 그대로 보존한다',async()=>{const v=await one('select * from file_asset_versions where file_id=$1',[file]);assert.equal(v.version_number,1);assert.equal(v.storage_path,legacyPath);assert.equal((await one('select version_number from file_assets where id=$1',[file])).version_number,1)});
 const operation=randomUUID(),path=`${org}/${operation}-new.pdf`;
 await check('활성 조직 구성원은 최신 버전을 원자적으로 추가하고 동일 요청을 멱등 재시도한다',async()=>{await q('select reserve_file_storage_upload($1,$2,$3,$4)',[org,operation,path,2048]);await db.exec('reset role');await q("insert into storage.objects values('business-files',$1,jsonb_build_object('size','2048'))",[path]);await asUser(member);const args=[org,file,1,operation,path,'new.pdf','application/pdf',2048];const saved=await one('select public.create_file_asset_version($1,$2,$3,$4,$5,$6,$7,$8) as saved',args);const retry=await one('select public.create_file_asset_version($1,$2,$3,$4,$5,$6,$7,$8) as saved',args);assert.equal(saved.saved.version_number,2);assert.deepEqual(retry.saved,saved.saved);assert.equal((await q('select * from file_asset_versions where file_id=$1 order by version_number',[file])).rows.length,2);assert.equal((await one('select get_file_storage_usage($1) usage',[org])).usage.used_bytes,4096);await fails(()=>q('select public.create_file_asset_version($1,$2,$3,$4,$5,$6,$7,$8)',[org,file,1,operation,`${org}/${operation}-changed.pdf`,'different.pdf','application/pdf',2048]),'P0001')});
 await check('Storage 실제 바이트가 예약값과 다르면 버전 게시를 거절한다',async()=>{const op=randomUUID(),wrongPath=`${org}/${op}-wrong.pdf`;await q('select reserve_file_storage_upload($1,$2,$3,100)',[org,op,wrongPath]);await db.exec('reset role');await q("insert into storage.objects values('business-files',$1,jsonb_build_object('size','99'))",[wrongPath]);await asUser(member);await fails(()=>q('select public.create_file_asset_version($1,$2,2,$3,$4,$5,$6,100)',[org,file,op,wrongPath,'wrong.pdf','application/pdf']),'22023');assert.equal((await one('select version_number from file_assets where id=$1',[file])).version_number,2)});
 await check('다른 조직·잘못된 버전·잘못된 경로를 거부한다',async()=>{const otherOp=randomUUID(),staleOp=randomUUID();await fails(()=>q('select public.create_file_asset_version($1,$2,2,$3,$4,$5,$6,1)',[other,file,otherOp,`${other}/${otherOp}-x`,'x','application/pdf']),'P0002');await fails(()=>q('select public.create_file_asset_version($1,$2,1,$3,$4,$5,$6,1)',[org,file,staleOp,`${org}/${staleOp}-x`,'x','application/pdf']),'P0001');await fails(()=>q('select public.create_file_asset_version($1,$2,2,$3,$4,$5,$6,1)',[org,file,randomUUID(),'other/x','x','application/pdf']),'22023')});
 await check('구성원은 버전 이력을 바꾸거나 삭제할 수 없다',async()=>{await fails(()=>q("update file_asset_versions set original_name='tampered' where file_id=$1",[file]),'42501');await fails(()=>q('delete from file_asset_versions where file_id=$1',[file]),'42501')});
 console.log(`file version tests passed: ${checks} groups`);
}finally{await db.close()}
