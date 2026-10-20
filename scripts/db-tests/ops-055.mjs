import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const org = randomUUID(), other = randomUUID(), owner = randomUUID(), outsider = randomUUID();
const customer = randomUUID(), otherCustomer = randomUUID(), staff = randomUUID(), service = randomUUID();
const appointment = randomUUID(), otherAppointment = randomUUID();
const q = (sql, values = []) => db.query(sql, values);
const one = async (sql, values = []) => (await q(sql, values)).rows[0];
const fails = (run, code) => assert.rejects(run, (error) => { assert.equal(error.code, code, error.message); return true; });
const file = (name) => readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
const asUser = async (id) => { await db.exec('reset role; set role authenticated'); await q("select set_config('request.jwt.claim.sub',$1,false)", [id]); };
const admin = async () => db.exec('reset role');

try {
  await db.exec(`create role anon; create role authenticated; create schema auth; create schema private;
    grant usage on schema auth, private, public to authenticated, anon;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table auth.users(id uuid primary key,email text); create table organizations(id uuid primary key);
    create table profiles(id uuid primary key,display_name text);
    create table memberships(organization_id uuid,user_id uuid,role text);
    create table customers(id uuid primary key,organization_id uuid not null,name text,status text default 'active');
    create unique index customers_org_id on customers(id,organization_id);
    create function private.has_organization_role(target uuid,roles text[]) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.memberships where organization_id=target and user_id=auth.uid() and role=any(roles))$$;
    create table treatment_sale_drafts(id uuid primary key,organization_id uuid not null,customer_id uuid not null,description text not null,amount numeric(14,2) not null,source_snapshot jsonb not null);
    create table finance_transactions(id uuid primary key default gen_random_uuid(),organization_id uuid not null,transaction_type text not null,amount numeric(14,2) not null,transaction_date date not null,category text not null,counterparty text not null default '',memo text not null default '',is_archived boolean not null default false,created_by uuid not null,created_at timestamptz default now(),updated_at timestamptz default now());
    grant select,insert,update,delete on finance_transactions to authenticated;`);
  await q('insert into auth.users values($1,$2),($3,$4)', [owner, 'owner@example.test', outsider, 'other@example.test']);
  await q('insert into organizations values($1),($2)', [org, other]);
  await q("insert into memberships values($1,$2,'owner'),($3,$4,'owner')", [org, owner, other, outsider]);
  await q("insert into customers values($1,$2,'고객','active'),($3,$4,'다른 조직 고객','active')", [customer, org, otherCustomer, other]);
  for (const name of ['006_tasks.sql', '024_visit_sale_carts.sql', '034_appointments.sql']) await db.exec(await file(name));
  await db.exec('grant select,insert,update,delete on public.tasks to authenticated;');
  await db.exec(await file('047_ops_memo_labels_consent.sql'));
  await db.exec(await file('048_task_recurrence_customer.sql'));
  await db.exec(await file('049_task_assignee_completion.sql'));
  await db.exec(await file('055_task_appointment_link.sql'));
  await db.exec(await file('055_task_appointment_link.sql')); // 멱등

  await admin();
  await q(`insert into appointment_staff(id,organization_id,name,created_by) values($1,$2,'담당자',$3),($4,$5,'다른 매장',$6)`, [staff, org, owner, randomUUID(), other, outsider]);
  await q(`insert into appointment_services(id,organization_id,name,duration_minutes,created_by) values($1,$2,'시술',60,$3),($4,$5,'다른 시술',60,$6)`, [service, org, owner, randomUUID(), other, outsider]);
  await q(`insert into appointments(id,organization_id,customer_id,staff_id,service_id,service_name_snapshot,duration_minutes,buffer_minutes,start_at,end_at,created_by,updated_by)
    values($1,$2,$3,$4,$5,'시술',60,0,'2099-01-01 01:00Z','2099-01-01 02:00Z',$6,$6),
          ($7,$8,$9,$10,$11,'다른 시술',60,0,'2099-01-01 01:00Z','2099-01-01 02:00Z',$12,$12)`,
    [appointment, org, customer, staff, service, owner, otherAppointment, other, otherCustomer, (await one('select id from appointment_staff where organization_id=$1', [other])).id, (await one('select id from appointment_services where organization_id=$1', [other])).id, outsider]);

  await asUser(owner);
  const linked = await one(`insert into tasks(organization_id,created_by,title,appointment_id,customer_id)
    values($1,$2,'예약 준비',$3,$4) returning *`, [org, owner, appointment, otherCustomer]);
  assert.equal(linked.appointment_id, appointment);
  assert.equal(linked.customer_id, customer, '예약의 고객으로 고객 연결을 맞춘다');
  await fails(() => q(`insert into tasks(organization_id,created_by,title,appointment_id)
    values($1,$2,'다른 매장 예약',$3)`, [org, owner, otherAppointment]), '23503');

  await q('update tasks set appointment_id=null where id=$1', [linked.id]);
  const unlinked = await one('select appointment_id,customer_id from tasks where id=$1', [linked.id]);
  assert.equal(unlinked.appointment_id, null);
  assert.equal(unlinked.customer_id, customer, '예약 연결 해제 시 기존 고객 연결을 보존한다');

  await q(`update tasks set appointment_id=$1 where id=$2`, [appointment, linked.id]);
  await admin();
  await q('delete from appointments where id=$1', [appointment]);
  const afterDelete = await one('select appointment_id,customer_id from tasks where id=$1', [linked.id]);
  assert.equal(afterDelete.appointment_id, null, '예약 삭제는 연결만 해제한다');
  assert.equal(afterDelete.customer_id, customer);

  console.log('055 isolated PostgreSQL tests passed: same-tenant link, cross-tenant rejection, customer sync, unlink/delete behavior, idempotency.');
} finally {
  await db.close();
}
