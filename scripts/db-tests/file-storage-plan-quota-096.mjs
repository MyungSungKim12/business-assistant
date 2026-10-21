import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const migration = await readFile(new URL('../../migrations/096_plan_file_storage_quotas.sql', import.meta.url), 'utf8');
const org = randomUUID(), plan = randomUUID(), user = randomUUID(), operation = randomUUID();
const q = (sql, params = []) => db.query(sql, params);

try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema private; create schema storage;
    grant usage on schema auth,private,storage,public to authenticated,anon;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant execute on function auth.uid() to authenticated;
    create table public.plans(id uuid primary key,code text unique not null,name text not null,is_active boolean not null default true);
    create table public.subscriptions(id uuid primary key,organization_id uuid not null,plan_id uuid not null,status text not null,starts_at timestamptz not null,ends_at timestamptz);
    create table public.organization_file_storage_quotas(organization_id uuid primary key,quota_bytes bigint not null,updated_at timestamptz not null default now());
    create table public.file_storage_upload_reservations(organization_id uuid not null,operation_id uuid not null,storage_path text not null,size_bytes bigint not null,uploaded_by uuid not null,expires_at timestamptz not null,primary key(organization_id,operation_id));
    create table storage.objects(bucket_id text not null,name text not null,metadata jsonb not null);
    create table public.audit_events(organization_id uuid,actor_id uuid,action text,target_type text,target_id text,metadata jsonb,source text);
    create function private.has_organization_role(uuid,text[]) returns boolean language sql stable as $$select true$$;
    create function private.organization_file_storage_bytes(p_org uuid) returns bigint language sql stable as $$
      select coalesce(sum((metadata->>'size')::bigint),0)::bigint from storage.objects where bucket_id='business-files' and split_part(name,'/',1)=p_org::text
    $$;
    grant execute on function private.has_organization_role(uuid,text[]) to authenticated;
  `);
  await db.exec(migration);
  await q('insert into public.plans(id,code,name,file_storage_quota_bytes) values($1,$2,$3,$4)', [plan, 'STANDARD', '스탠다드', 5000]);
  await q('insert into public.subscriptions(id,organization_id,plan_id,status,starts_at) values($1,$2,$3,$4,now()-interval \'1 day\')', [randomUUID(), org, plan, 'active']);
  await q('insert into public.organization_file_storage_quotas(organization_id,quota_bytes) values($1,10000)', [org]);
  await q('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3)', ['business-files', `${org}/${randomUUID()}/asset.pdf`, { size: '3000' }]);

  let usage = (await q('select private.file_storage_usage_snapshot($1) as usage', [org])).rows[0].usage;
  assert.deepEqual({ org: usage.organization_quota_bytes, plan: usage.plan_quota_bytes, effective: usage.quota_bytes, available: usage.available_bytes }, { org: 10000, plan: 5000, effective: 5000, available: 2000 });

  await db.exec('set role authenticated');
  await q("select set_config('request.jwt.claim.sub',$1,false)", [user]);
  await assert.rejects(q('select public.reserve_file_storage_upload($1,$2,$3,$4)', [org, randomUUID(), `${org}/${randomUUID()}/large.pdf`, 2001]), error => error.code === '22023');
  const reservationPath = `${org}/${randomUUID()}/small.pdf`;
  const reserved = (await q('select public.reserve_file_storage_upload($1,$2,$3,$4) as usage', [org, operation, reservationPath, 1000])).rows[0].usage;
  assert.equal(reserved.reserved_bytes, 1000);
  assert.equal(reserved.available_bytes, 1000);
  const retry = (await q('select public.reserve_file_storage_upload($1,$2,$3,$4) as usage', [org, operation, reservationPath, 1000])).rows[0].usage;
  assert.equal(retry.reserved_bytes, 1000);
  await assert.rejects(q('select public.reserve_file_storage_upload($1,$2,$3,$4)', [org, operation, `${org}/${randomUUID()}/other.pdf`, 1000]), error => error.code === 'P0001');
  await db.exec('reset role');

  await q('update public.plans set file_storage_quota_bytes=2000 where id=$1', [plan]);
  usage = (await q('select private.file_storage_usage_snapshot($1) as usage', [org])).rows[0].usage;
  assert.equal(usage.quota_bytes, 2000);
  assert.equal(usage.available_bytes, 0);
  await q('update public.organization_file_storage_quotas set quota_bytes=1000 where organization_id=$1', [org]);
  usage = (await q('select private.file_storage_usage_snapshot($1) as usage', [org])).rows[0].usage;
  assert.equal(usage.quota_bytes, 1000);

  await q("update public.subscriptions set status='canceled' where organization_id=$1", [org]);
  usage = (await q('select private.file_storage_usage_snapshot($1) as usage', [org])).rows[0].usage;
  assert.equal(usage.plan_quota_bytes, null);
  assert.equal(usage.quota_bytes, 1000);
  console.log('PASS FILE-11 plan cap, organization cap, active subscription, upload reservation and downgrade overage');
} finally {
  await db.close();
}
