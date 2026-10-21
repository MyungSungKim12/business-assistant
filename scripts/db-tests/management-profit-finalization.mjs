import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const org = randomUUID(), otherOrg = randomUUID(), owner = randomUUID(), admin = randomUUID(), member = randomUUID(), stranger = randomUUID();
const op1 = randomUUID(), op2 = randomUUID();
const q = (sql, params = []) => db.query(sql, params);
const one = async (sql, params = []) => (await q(sql, params)).rows[0];
const assume = async (user) => {
  await db.exec('reset role; set role authenticated');
  await q("select set_config('request.jwt.claim.sub',$1,false)", [user]);
};

try {
  await db.exec(`
    create role anon; create role authenticated; create schema auth; create schema private;
    grant usage on schema auth, private, public to authenticated, anon;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table organizations(id uuid primary key);
    create table memberships(organization_id uuid,user_id uuid,role text);
    create function private.has_organization_role(target uuid,roles text[]) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.memberships where organization_id=target and user_id=auth.uid() and role=any(roles))$$;
    create table finance_transactions(organization_id uuid,transaction_type text,amount numeric,category text,transaction_date date,is_archived boolean);
    create table staff_commission_settlements(id uuid,organization_id uuid,from_date date,to_date date);
    create table staff_commission_settlement_lines(organization_id uuid,settlement_id uuid,source_event_date date,commission_amount numeric);
    create table audit_events(id uuid primary key default gen_random_uuid(),organization_id uuid,actor_id uuid,action text,target_type text,target_id text,metadata jsonb,source text default 'api_user');
    create function private.get_management_preview(uuid,date,date) returns jsonb language sql stable security definer set search_path='' as $$
      select jsonb_build_object('organization_id',$1,'from_date',$2,'to_date',$3,'recorded_income','1000','recorded_expense','250','recorded_net','750','transaction_count',2,'visit_receipts','1000','visit_refunds','0','inventory_cogs',case when $2=date '2025-03-01' then null else '100' end,'inventory_cost_unknown_units',case when $2=date '2025-03-01' then 1 else 0 end,'operating_profit_before_commission_tax','650','is_final_profit',false,'excluded_costs',jsonb_build_array('staff_commissions','tax'),'staff_basis_is_commission',false,'staff_sales_basis','[]'::jsonb)
    $$;
    create function public.get_management_preview(uuid,date,date) returns jsonb language sql stable as $$select private.get_management_preview($1,$2,$3)$$;
    insert into organizations values('${org}'),('${otherOrg}');
    insert into memberships values('${org}','${owner}','owner'),('${org}','${admin}','admin'),('${org}','${member}','member'),('${otherOrg}','${owner}','owner');
    insert into staff_commission_settlements values('${randomUUID()}','${org}','2025-01-01','2025-01-31');
    insert into staff_commission_settlement_lines values('${org}',(select id from staff_commission_settlements where organization_id='${org}'),'2025-01-15',50);
  `);
  await db.exec(await readFile(new URL('../../migrations/086_management_recorded_tax.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../../migrations/089_management_profit_finalization.sql', import.meta.url), 'utf8'));
  await assume(owner);

  const first = await one("select public.finalize_management_profit($1,'2025-01-01','2025-01-31',$2,true,'') data", [org, op1]);
  assert.equal(first.data.revision, 1);
  assert.equal(first.data.result.is_final_profit, true);
  assert.equal(first.data.result.operating_profit_after_recorded_tax, '600');
  const replay = await one("select public.finalize_management_profit($1,'2025-01-01','2025-01-31',$2,true,'') data", [org, op1]);
  assert.deepEqual(replay.data, first.data);
  await assert.rejects(() => one("select public.finalize_management_profit($1,'2025-01-01','2025-01-31',$2,true,'')", [org, op2]), (error) => error.code === '22023');
  const second = await one("select public.finalize_management_profit($1,'2025-01-01','2025-01-31',$2,true,'원장 수정 반영') data", [org, op2]);
  assert.equal(second.data.revision, 2);
  await assert.rejects(() => q("select revision from public.management_profit_finalizations where organization_id=$1 order by revision", [org]), (error) => error.code === '42501');
  await db.exec('reset role');
  assert.equal((await q("select revision from public.management_profit_finalizations where organization_id=$1 order by revision", [org])).rows.length, 2);
  assert.equal((await one("select count(*)::int n from audit_events where organization_id=$1 and action='management.profit_finalize'", [org])).n, 2);
  const listed = await one("select public.list_management_profit_finalizations($1,'2025-01-01','2025-01-31') data", [org]);
  assert.deepEqual(listed.data.map((row) => row.revision), [2, 1]);
  await assert.rejects(() => q('update public.management_profit_finalizations set reason=\'tamper\' where id=$1', [first.data.id]), /immutable/i);
  await assert.rejects(() => q('delete from public.management_profit_finalizations where id=$1', [first.data.id]), /immutable/i);

  await assert.rejects(() => one("select public.finalize_management_profit($1,'2025-03-01','2025-03-31',$2,true,'')", [org, randomUUID()]), (error) => error.code === '22023');
  await assert.rejects(() => one("select public.finalize_management_profit($1,'2025-02-01','2025-02-28',$2,true,'')", [org, randomUUID()]), (error) => error.code === '22023');
  await assert.rejects(() => one("select public.finalize_management_profit($1,'2025-01-01','2025-01-31',$2,false,'')", [org, randomUUID()]), (error) => error.code === '22023');
  await assert.rejects(() => one("select public.finalize_management_profit($1,'2025-01-01','2025-01-31',$2,true,'')", [otherOrg, randomUUID()]), (error) => error.code === '22023' || error.code === '42501');
  await assume(member);
  await assert.rejects(() => one("select public.finalize_management_profit($1,'2025-01-01','2025-01-31',$2,true,'')", [org, randomUUID()]), (error) => error.code === '42501');
  await assert.rejects(() => one("select public.list_management_profit_finalizations($1,'2025-01-01','2025-01-31')", [org]), (error) => error.code === '42501');
  await assume(stranger);
  await assert.rejects(() => one("select public.list_management_profit_finalizations($1,'2025-01-01','2025-01-31')", [otherOrg]), (error) => error.code === '42501');
  console.log('PASS LAB-10 finalization preconditions, roles, org boundary, idempotent revisions, audit and immutable snapshots');
} finally {
  await db.close();
}
