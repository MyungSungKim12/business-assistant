import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const migration = await readFile(new URL('../../migrations/097_customer_retention_controls.sql', import.meta.url), 'utf8');
const query = (sql, params = []) => db.query(sql, params);
const orgA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const orgB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const customerA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create schema private;
    create table private.test_access (user_id uuid not null, organization_id uuid not null, role text not null);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function private.has_organization_role(p_org uuid, p_roles text[]) returns boolean
      language sql stable security definer set search_path = '' as $$
      select exists(select 1 from private.test_access a where a.user_id = auth.uid() and a.organization_id = p_org and a.role = any(p_roles))
    $$;
    create table public.organizations (id uuid primary key);
    create table public.customers (
      id uuid primary key, organization_id uuid not null references public.organizations(id), unique(id, organization_id)
    );
    create table public.appointments (organization_id uuid not null, customer_id uuid not null, status text not null);
    create table public.customer_wallets (organization_id uuid not null, customer_id uuid not null, money_balance numeric not null, count_balance integer not null);
    create table public.audit_events (
      id uuid primary key default gen_random_uuid(), organization_id uuid, actor_id uuid,
      action text not null, target_type text not null, target_id text, metadata jsonb not null default '{}'::jsonb,
      request_id text, ip inet, source text not null default 'api_user', created_at timestamptz not null default now()
    );
    insert into public.organizations values ('${orgA}'), ('${orgB}');
    insert into public.customers(id, organization_id) values ('${customerA}', '${orgA}');
    insert into private.test_access values
      ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '${orgA}', 'owner'),
      ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '${orgA}', 'member'),
      ('ffffffff-ffff-4fff-8fff-ffffffffffff', '${orgB}', 'owner');
    grant select on public.customers to authenticated;
    grant insert, delete on public.appointments, public.customer_wallets to authenticated;
  `);
  await db.exec(migration);
  await db.exec(migration);

  await db.exec("set role authenticated; set request.jwt.claim.sub = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'");
  const initial = await query(`select * from public.save_customer_retention_policy(
    $1, 0, null, null, null, null, null, null, null
  )`, [orgA]);
  assert.equal(initial.rows[0].version, 1);
  const unset = await query('select count(*)::int as configured from public.customer_retention_policies where organization_id = $1 and profile_days is not null', [orgA]);
  assert.equal(unset.rows[0].configured, 0, 'policy must not invent a retention period');
  await assert.rejects(query(`select * from public.save_customer_retention_policy($1, 1, 0, null, null, null, null, null, null)`, [orgA]), /retention period/i);

  await query(`select * from public.save_customer_retention_policy($1, 1, 365, 90, 180, 365, 1825, 1095, 3650)`, [orgA]);
  await assert.rejects(query(`select * from public.save_customer_retention_policy($1, 1, 365, 90, 180, 365, 1825, 1095, 3650)`, [orgA]), /version/i);
  await assert.rejects(query(`select * from public.save_customer_retention_policy($1, 2, 365, 90, 180, 365, 1825, 1095, 3650)`, [orgB]), /access denied/i);
  await assert.rejects(query(`select * from public.set_customer_relationship_end($1, $2, now() + interval '1 day', '종료')`, [orgA, customerA]), /future/i);

  await db.exec(`insert into public.appointments values ('${orgA}', '${customerA}', 'confirmed')`);
  await assert.rejects(query(`select public.set_customer_relationship_end($1, $2, now() - interval '100 days', '종료')`, [orgA, customerA]), /active appointments/i);
  await db.exec('delete from public.appointments');
  await db.exec(`insert into public.customer_wallets values ('${orgA}', '${customerA}', 10000, 0)`);
  await assert.rejects(query(`select public.set_customer_relationship_end($1, $2, now() - interval '100 days', '종료')`, [orgA, customerA]), /membership balances/i);
  await db.exec('delete from public.customer_wallets');

  await query(`select public.set_customer_relationship_end($1, $2, now() - interval '100 days', '고객 요청')`, [orgA, customerA]);
  const ended = await query('select ended_at is not null as ended from public.customer_relationship_status where customer_id = $1', [customerA]);
  assert.equal(ended.rows[0].ended, true);
  await query(`select public.set_customer_legal_hold($1, $2, true, '분쟁 처리 중')`, [orgA, customerA]);
  const held = await query(`select count(*)::int as active from public.customer_legal_holds where customer_id = $1 and released_at is null`, [customerA]);
  assert.equal(held.rows[0].active, 1);
  await assert.rejects(query(`select public.set_customer_legal_hold($1, $2, true, '중복')`, [orgA, customerA]), /already active/i);
  await db.exec("set request.jwt.claim.sub = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'");
  await assert.rejects(query(`select public.set_customer_legal_hold($1, $2, false, '해제')`, [orgA, customerA]), /access denied/i);
  await db.exec("set request.jwt.claim.sub = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'");
  await query(`select public.set_customer_legal_hold($1, $2, false, '분쟁 종료')`, [orgA, customerA]);
  await assert.rejects(query(`select public.set_customer_legal_hold($1, $2, false, '중복 해제')`, [orgA, customerA]), /no active hold/i);

  const events = await query('select action, count(*)::int as count from public.customer_retention_events group by action order by action');
  assert.deepEqual(events.rows.map(row => row.action), ['hold_created', 'hold_released', 'policy_updated', 'relationship_ended']);
  const purgeRpc = await query("select count(*)::int as count from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='purge_customer'");
  assert.equal(purgeRpc.rows[0].count, 0, 'this migration must not expose a destructive purge RPC');
  console.log('PASS CRM-014 retention periods stay unset by default; manager, version, relationship, legal hold and audit boundaries enforced');
} finally {
  await db.close();
}
