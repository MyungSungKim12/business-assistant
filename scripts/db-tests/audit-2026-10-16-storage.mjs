// Audit snapshot of current RLS. Ephemeral PGlite only; never connects to Supabase.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const org = randomUUID(), customer = randomUUID(), member = randomUUID(), photo = randomUUID();
const path = `${org}/${customer}/${photo}-audit.png`;
try {
  await db.exec(`create role anon; create role authenticated;
    create schema auth; create schema private; create schema storage;
    grant usage on schema auth,private,storage,public to authenticated;
    create table auth.users(id uuid primary key);
    create table public.organizations(id uuid primary key);
    create table public.customers(id uuid primary key,organization_id uuid not null,unique(id,organization_id));
    create table public.memberships(organization_id uuid,user_id uuid,role text);
    create table storage.objects(bucket_id text not null,name text not null);
    alter table storage.objects enable row level security;
    grant select on storage.objects to authenticated;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function private.has_organization_role(target uuid,roles text[]) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.memberships where organization_id=target and user_id=auth.uid() and role=any(roles))$$;`);
  await db.query('insert into auth.users values($1)', [member]);
  await db.query('insert into public.organizations values($1)', [org]);
  await db.query('insert into public.customers values($1,$2)', [customer, org]);
  await db.query("insert into public.memberships values($1,$2,'member')", [org, member]);
  await db.exec(await readFile(new URL('../../migrations/022_customer_photos.sql', import.meta.url), 'utf8'));
  await db.query(`insert into public.customer_photos(id,organization_id,customer_id,uploaded_by,storage_path,original_name,content_type,size_bytes,is_archived)
    values($1,$2,$3,$4,$5,'audit.png','image/png',10,true)`, [photo, org, customer, member, path]);
  await db.query("insert into storage.objects values('business-files',$1)", [path]);
  await db.exec('set role authenticated');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [member]);
  const metadata = await db.query('select is_archived,storage_path from public.customer_photos where id=$1', [photo]);
  const objects = await db.query('select name from storage.objects where name=$1', [path]);
  assert.equal(metadata.rows[0].is_archived, true);
  assert.equal(objects.rows.length, 1, 'Audit snapshot changed: re-evaluate archived-object policy');
  console.log('SEC-STORAGE reproduced: member can SELECT archived photo metadata and its Storage object using the repository RLS.');
  console.log('No live Storage request or production database access was made.');
} finally { await db.close(); }
