// Isolated PostgreSQL/RLS regression matrix. No network, credentials or production data.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const org = randomUUID(), otherOrg = randomUUID(), customer = randomUUID();
const member = randomUUID(), manager = randomUUID(), outsider = randomUUID();
const photo = randomUUID(), file = randomUUID();
const photoPath = `${org}/${customer}/${photo}-audit.png`, filePath = `${org}/${file}-audit.pdf`;
try {
  await db.exec(`create role anon; create role authenticated;
    create schema auth; create schema private; create schema storage;
    grant usage on schema auth,private,storage,public to authenticated;
    create table auth.users(id uuid primary key);
    create table public.organizations(id uuid primary key);
    create table public.customers(id uuid primary key,organization_id uuid not null,unique(id,organization_id));
    create table public.memberships(organization_id uuid,user_id uuid,role text);
    create table public.file_assets(id uuid primary key,organization_id uuid,uploaded_by uuid,storage_path text unique,is_archived boolean default false);
    alter table public.file_assets enable row level security;
    grant select on public.file_assets to authenticated;
  `);
  await db.exec(`create table storage.buckets(id text primary key,public boolean);
    insert into storage.buckets values('business-files',false);
    create table storage.objects(bucket_id text not null,name text not null);
    alter table storage.objects enable row level security;
    grant select,insert on storage.objects to authenticated;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function private.has_organization_role(target uuid,roles text[]) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.memberships where organization_id=target and user_id=auth.uid() and role=any(roles))$$;`);
  for (const id of [member, manager, outsider]) await db.query('insert into auth.users values($1)', [id]);
  for (const id of [org, otherOrg]) await db.query('insert into public.organizations values($1)', [id]);
  await db.query('insert into public.customers values($1,$2)', [customer, org]);
  for (const [o, u, role] of [[org, member, 'member'], [org, manager, 'admin'], [otherOrg, outsider, 'owner']]) await db.query('insert into public.memberships values($1,$2,$3)', [o, u, role]);
  await db.exec(await readFile(new URL('../../migrations/022_customer_photos.sql', import.meta.url), 'utf8'));
  await db.query(`insert into public.customer_photos(id,organization_id,customer_id,uploaded_by,storage_path,original_name,content_type,size_bytes,is_archived)
    values($1,$2,$3,$4,$5,'audit.png','image/png',10,true)`, [photo, org, customer, manager, photoPath]);
  await db.query('insert into public.file_assets values($1,$2,$3,$4,true)', [file, org, member, filePath]);
  for (const path of [photoPath, filePath, `${org}/untracked.png`, 'bad/path', `${otherOrg}/spoof.png`]) await db.query("insert into storage.objects values('business-files',$1)", [path]);
  if (!process.argv.includes('--baseline')) {
    const sql = await readFile(new URL('../../migrations/060_storage_archive_access.sql', import.meta.url), 'utf8');
    await db.exec(sql); await db.exec(sql); // safe to re-run
  }
  async function actor(id) { await db.exec('reset role; set role authenticated'); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]); }
  async function count(table, where = '') { return Number((await db.query(`select count(*) as n from ${table} ${where}`)).rows[0].n); }
  for (const id of [member, manager, outsider]) {
    await actor(id);
    assert.equal(await count('storage.objects'), 0, 'Archived/untracked/malformed/cross-org objects must be denied');
    assert.equal(await count('public.customer_photos'), id === manager ? 1 : 0, 'Only manager sees trash metadata');
    assert.equal(await count('public.file_assets'), id === manager ? 1 : 0);
  }
  await db.exec('reset role; update public.customer_photos set is_archived=false; update public.file_assets set is_archived=false;');
  // 원장이 있어도 조직 접두어·원장 ID·경로 깊이가 틀린 객체는 거절한다.
  for (const [id,path] of [
    [randomUUID(), 'bad/path'],
    [randomUUID(), `${otherOrg}/${randomUUID()}-spoof.pdf`],
    [randomUUID(), `${org}/${randomUUID()}-mismatched-id.pdf`],
  ]) {
    await db.query('insert into public.file_assets values($1,$2,$3,$4,false)',[id,org,member,path]);
    await db.query("insert into storage.objects values('business-files',$1)",[path]);
  }
  const nestedId=randomUUID(),nestedPath=`${org}/${nestedId}-file//extra`;
  await db.query('insert into public.file_assets values($1,$2,$3,$4,false)',[nestedId,org,member,nestedPath]);
  await db.query("insert into storage.objects values('business-files',$1)",[nestedPath]);
  for (const id of [member, manager, outsider]) {
    await actor(id);
    assert.equal(await count('storage.objects'), id === outsider ? 0 : 2, 'Active objects require matching tenant and metadata');
    const access = (await db.query('select private.can_access_business_object($1,true) as photo,private.can_access_business_object($2,true) as file', [photoPath, filePath])).rows[0];
    assert.equal(access.photo, id === manager, 'Photo uploads require manager and matching uploader');
    assert.equal(access.file, id === member, 'File uploads require matching uploader');
    await assert.rejects(() => db.query("insert into storage.objects values('business-files',$1)", [`${org}/${randomUUID()}-untracked.png`]), /row-level security/);
    await assert.rejects(() => db.query("insert into storage.objects values('other-bucket',$1)", [filePath]), /row-level security/);
  }
  await actor(member);
  await db.query("insert into storage.objects values('business-files',$1)", [filePath]);
  await assert.rejects(() => db.query("insert into storage.objects values('business-files',$1)", [photoPath]), /row-level security/);
  await actor(manager);
  await db.query("insert into storage.objects values('business-files',$1)", [photoPath]);
  await actor('');
  assert.equal(await count('storage.objects'), 0, 'Missing user denied');
  await db.exec('reset role; set role anon');
  await assert.rejects(() => db.query('select private.can_access_business_object($1,false)', [filePath]), /permission denied/);
  console.log('060 PASS: archive/restore, tenant, metadata, path, uploader, role, bucket, anonymous, actual insert policies and repeat application.');
} finally { await db.close(); }
