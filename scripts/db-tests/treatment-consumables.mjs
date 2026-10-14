import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Executes the actual 046 migration and treatment lifecycle RPC in isolated PostgreSQL.
const db = new PGlite();
const org = randomUUID(), otherOrg = randomUUID(), customer = randomUUID();
const owner = randomUUID(), member = randomUUID(), outsider = randomUUID();
const product = randomUUID(), foreignProduct = randomUUID(), service = randomUUID(), foreignService = randomUUID();
const q = (sql, params = []) => db.query(sql, params);
const one = async (sql, params = []) => (await q(sql, params)).rows[0];
const fail = (run, code) => assert.rejects(run, (error) => { assert.equal(error.code, code, error.message); return true; });
const user = async (id = owner) => {
  await db.exec('reset role; set role authenticated');
  await q("select set_config('request.jwt.claim.sub',$1,false)", [id]);
};
const file = (name) => readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
const mutate = (treatmentId, version, action, operation = randomUUID(), values = {}) => one(
  'select * from public.mutate_treatment($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
  [org, customer, treatmentId, version, operation, action, '', JSON.stringify(values)],
);

try {
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create schema private;
    grant usage on schema auth, private, public to authenticated, anon;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create table auth.users(id uuid primary key);
    create table public.organizations(id uuid primary key);
    create table public.memberships(organization_id uuid,user_id uuid,role text);
    create function private.has_organization_role(target uuid,roles text[]) returns boolean
      language sql stable security definer set search_path='' as $$
        select exists(select 1 from public.memberships where organization_id=target
          and user_id=auth.uid() and role=any(roles)) $$;
    create table public.customers(id uuid primary key,organization_id uuid not null,name text,updated_at timestamptz default now());
    create unique index customers_id_org on public.customers(id,organization_id);
    create table public.appointment_services(id uuid primary key,organization_id uuid not null,
      is_active boolean not null default true,unique(organization_id,id));
    create table public.catalog_products(id uuid primary key,organization_id uuid not null,
      kind text not null,is_active boolean not null,stock_quantity integer not null,
      version bigint not null default 1,unique(organization_id,id));
    create table public.catalog_stock_ledger(id uuid primary key default gen_random_uuid(),
      organization_id uuid not null,product_id uuid not null,quantity integer not null,
      reason text not null,operation_id uuid,created_by uuid,movement_kind text not null,sale_line_id uuid);
    create function private.prevent_catalog_ledger_change() returns trigger language plpgsql as $$
      begin raise exception 'Catalog ledger is immutable' using errcode='P0001'; end $$;
  `);
  await q('insert into auth.users values($1),($2),($3)', [owner, member, outsider]);
  await q('insert into organizations values($1),($2)', [org, otherOrg]);
  await q("insert into memberships values($1,$2,'owner'),($1,$3,'member'),($4,$5,'owner')", [org, owner, member, otherOrg, outsider]);
  await q('insert into customers values($1,$2,$3)', [customer, org, '고객']);
  await q('insert into appointment_services values($1,$2,true),($3,$4,true)', [service, org, foreignService, otherOrg]);
  await q("insert into catalog_products values($1,$2,'product',true,1,1),($3,$4,'product',true,5,1)", [product, org, foreignProduct, otherOrg]);
  // 030 backfills pre-existing negative, non-sale stock movements as adjustment.
  await q(`insert into catalog_stock_ledger(organization_id,product_id,quantity,reason,operation_id,created_by,movement_kind)
    values($1,$2,-1,'legacy adjustment',$3,$4,'adjustment')`, [otherOrg, foreignProduct, randomUUID(), owner]);
  await q(`insert into catalog_stock_ledger(organization_id,product_id,quantity,reason,operation_id,created_by,movement_kind)
    values($1,$2,1,'legacy customer return',$3,$4,'customer_return')`, [org, foreignProduct, randomUUID(), owner]);
  await db.exec(await file('014_customer_records.sql'));
  await db.exec(await file('016_treatment_lifecycle.sql'));
  await db.exec(await file('017_treatment_consultation.sql'));
  const treatment = await one(`insert into treatment_records(organization_id,customer_id,treatment_name,created_by)
    values($1,$2,'관리',$3) returning *`, [org, customer, owner]);
  await q(`insert into treatment_record_events(organization_id,customer_id,treatment_id,actor_id,action,
    reason,before_data,after_data,operation_id,request_data)
    values($1,$2,$3,$4,'consult','', '{}'::jsonb,'{}'::jsonb,$5,'{}'::jsonb)`,
  [org, customer, treatment.id, owner, randomUUID()]);
  await db.exec(await file('046_treatment_consumables.sql'));
  assert.equal((await one("select count(*)::int n from catalog_stock_ledger where movement_kind='adjustment'")).n, 1);
  assert.equal((await one("select count(*)::int n from catalog_stock_ledger where movement_kind='customer_return'")).n, 1);
  await user();

  const recipe = JSON.stringify([{ product_id: product, quantity: 2 }]);
  await one('select set_appointment_service_consumables($1,$2,$3::jsonb)', [org, service, recipe]);

  await assert.rejects(
    one('select set_appointment_service_consumables($1,$2,$3::jsonb)', [org, service, JSON.stringify([{ product_id: foreignProduct, quantity: 1 }])]),
    (error) => ['22023', '23503'].includes(error.code),
  );
  await fail(() => one('select set_appointment_service_consumables($1,$2,$3::jsonb)', [org, service, JSON.stringify([{ product_id: product, quantity: 0 }])]), '22023');
  await fail(() => one('select set_treatment_service($1,$2,$3,$4,$5,$6)', [org, customer, treatment.id, foreignService, 1, randomUUID()]), '22023');
  await one('select set_treatment_service($1,$2,$3,$4,$5,$6)', [org, customer, treatment.id, service, 1, randomUUID()]);

  await user(member);
  await fail(() => one('select set_appointment_service_consumables($1,$2,$3::jsonb)', [org, service, recipe]), '42501');
  await fail(() => one('select set_treatment_service($1,$2,$3,$4,$5,$6)', [org, customer, treatment.id, service, 2, randomUUID()]), '42501');
  await user();

  await mutate(treatment.id, 2, 'consult', randomUUID(), {
    goal: '기본 관리', plan: '', acknowledge_cautions: true,
    expected_cautions: { allergies: '', skin_type: null, concerns: [] },
  });
  await mutate(treatment.id, 3, 'start');
  const completeOp = randomUUID();
  await fail(() => mutate(treatment.id, 4, 'complete', completeOp), 'P0001');
  await db.exec('reset role');
  assert.equal((await one('select status from treatment_records where id=$1', [treatment.id])).status, 'in_progress');
  assert.equal((await one('select stock_quantity from catalog_products where id=$1', [product])).stock_quantity, 1);
  assert.equal((await one('select count(*)::int n from catalog_stock_ledger where product_id=$1', [product])).n, 0);

  await q('update catalog_products set stock_quantity=3 where id=$1', [product]);
  await user();
  const completed = await mutate(treatment.id, 4, 'complete', completeOp);
  assert.equal(completed.status, 'completed');
  await db.exec('reset role');
  assert.equal((await one('select stock_quantity from catalog_products where id=$1', [product])).stock_quantity, 1);
  assert.deepEqual((await q('select quantity,movement_kind from catalog_stock_ledger where product_id=$1', [product])).rows,
    [{ quantity: -2, movement_kind: 'treatment_use' }]);
  await user();
  assert.deepEqual(await mutate(treatment.id, 4, 'complete', completeOp), completed);
  await db.exec('reset role');
  assert.equal((await one('select count(*)::int n from catalog_stock_ledger where product_id=$1', [product])).n, 1);

  await db.exec('reset role');
  const legacy = await one(`insert into treatment_records(organization_id,customer_id,treatment_name)
    values($1,$2,'기존 미연결') returning *`, [org, customer]);
  await user();
  const legacyConsulted = await mutate(legacy.id, 1, 'consult', randomUUID(), {
    goal: '기본 관리', plan: '', acknowledge_cautions: true,
    expected_cautions: { allergies: '', skin_type: null, concerns: [] },
  });
  const legacyStarted = await mutate(legacy.id, legacyConsulted.version, 'start');
  await mutate(legacy.id, legacyStarted.version, 'complete');
  await db.exec('reset role');
  assert.equal((await one('select stock_quantity from catalog_products where id=$1', [product])).stock_quantity, 1);

  await user(outsider);
  await fail(() => one('select set_treatment_service($1,$2,$3,$4,$5,$6)', [org, customer, legacy.id, service, legacyStarted.version + 2, randomUUID()]), '42501');
  console.log('PASS TRT-11: recipe validation, tenant/role checks, insufficient-stock rollback, atomic deduction, idempotent completion, and unlinked treatment');
} finally {
  await db.close();
}
