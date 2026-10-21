import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const org = randomUUID(), otherOrg = randomUUID(), owner = randomUUID(), outsider = randomUUID();
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
    create table memberships(organization_id uuid,user_id uuid,role text);
    create function private.has_organization_role(target uuid,roles text[]) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.memberships where organization_id=target and user_id=auth.uid() and role=any(roles))$$;
    create table finance_transactions(organization_id uuid,transaction_type text,amount numeric,category text,transaction_date date,is_archived boolean);
    create table staff_commission_settlements(id uuid,organization_id uuid,from_date date,to_date date);
    create table staff_commission_settlement_lines(organization_id uuid,settlement_id uuid,source_event_date date,commission_amount numeric);
    create function private.get_management_preview(uuid,date,date) returns jsonb language sql stable security definer set search_path='' as $$
      select jsonb_build_object('organization_id',$1,'from_date',$2,'to_date',$3,'recorded_income','1000','recorded_expense','250','recorded_net','750','inventory_cogs','100','inventory_cost_unknown_units',0,'operating_profit_before_commission_tax','650','is_final_profit',false,'excluded_costs',jsonb_build_array('staff_commissions','tax'),'staff_basis_is_commission',false)
    $$;
    create function public.get_management_preview(uuid,date,date) returns jsonb language sql stable as $$select private.get_management_preview($1,$2,$3)$$;
    insert into memberships values('${org}','${owner}','owner'),('${otherOrg}','${owner}','owner');
    insert into finance_transactions values
      ('${org}','expense',100,'세금','2025-01-15',false),
      ('${org}','expense',150,'임대료','2025-01-15',false),
      ('${org}','expense',900,'세금','2025-02-01',false),
      ('${otherOrg}','expense',700,'세금','2025-01-15',false);
    insert into staff_commission_settlements values('${randomUUID()}','${org}','2025-01-01','2025-01-31');
    insert into staff_commission_settlement_lines values('${org}',(select id from staff_commission_settlements where organization_id='${org}'),'2025-01-15',50);
  `);
  await db.exec(await readFile(new URL('../../migrations/086_management_recorded_tax.sql', import.meta.url), 'utf8'));
  await assume(owner);

  const report = (await one("select public.get_management_preview($1,'2025-01-01','2025-01-31') data", [org])).data;
  assert.equal(report.recorded_tax_expense, '100');
  assert.equal(report.operating_profit_before_commission_tax, '750');
  assert.equal(report.commission_expense, '50');
  assert.equal(report.operating_profit_after_commission_before_tax, '700');
  assert.equal(report.operating_profit_after_recorded_tax, '600');
  assert.deepEqual(report.excluded_costs, ['unrecorded_taxes']);
  assert.equal(report.is_final_profit, false);

  const incomplete = (await one("select public.get_management_preview($1,'2025-01-01','2025-02-01') data", [org])).data;
  assert.equal(incomplete.recorded_tax_expense, '1000');
  assert.equal(incomplete.operating_profit_after_recorded_tax, null);
  await assume(outsider);
  await assert.rejects(() => one("select public.get_management_preview($1,'2025-01-01','2025-01-31')", [org]), (error) => error.code === '42501');
  console.log('PASS LAB-10 separates recorded tax expense, pre-tax profit, commission and recorded-tax balance with org and role checks');
} finally {
  await db.close();
}
