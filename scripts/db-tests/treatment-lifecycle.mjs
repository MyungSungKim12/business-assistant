import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

// Fresh in-memory PostgreSQL only: no connection strings, files, or live services.
const db = new PGlite();
let checks = 0;
const org = randomUUID(), otherOrg = randomUUID(), customer = randomUUID();
const otherCustomer = randomUUID(), owner = randomUUID(), member = randomUUID();
const outsider = randomUUID(), legacy = randomUUID();
const sql = (query, params = []) => db.query(query, params);
const one = async (query, params) => (await sql(query, params)).rows[0];
async function check(name, fn) {
  await fn(); checks++; console.log(`PASS ${name}`);
}
async function fails(fn, code) {
  await assert.rejects(fn, error => { assert.equal(error.code, code, error.message); return true; });
}
async function asUser(id, role = 'authenticated') {
  await db.exec(`reset role; set role ${role}`);
  await sql("select set_config('request.jwt.claim.sub', $1, false)", [id ?? '']);
}
const values = { treatment_date: '2026-09-18', treatment_name: 'Care', category: '',
  practitioner: '', notes: 'Original', amount: '123.45', next_visit_date: null };
async function mutate(id, version, action, options = {}) {
  return one('select * from public.mutate_treatment($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
    [options.org ?? org, options.customer ?? customer, id, version,
      options.operation ?? randomUUID(), action, options.reason ?? '',
      JSON.stringify(options.values ?? (['edit','correct'].includes(action) ? values : {}))]);
}
async function create() {
  return one(`insert into public.treatment_records
    (organization_id,customer_id,treatment_date,treatment_name)
    values ($1,$2,'2026-09-18','Draft') returning *`, [org, customer]);
}
try {
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create schema private;
    grant usage on schema auth, private, public to authenticated, anon;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create table auth.users (id uuid primary key);
    create table public.organizations (id uuid primary key);
    create table public.memberships (organization_id uuid, user_id uuid, role text);
    create table public.customers (id uuid primary key, organization_id uuid not null,
      updated_at timestamptz default now());
    create function private.has_organization_role(target_organization_id uuid, permitted_roles text[])
    returns boolean language sql stable security definer set search_path = '' as $$
      select exists(select 1 from public.memberships where organization_id=target_organization_id
        and user_id=(select auth.uid()) and role=any(permitted_roles)) $$;
    revoke all on function private.has_organization_role(uuid,text[]) from public;
    grant execute on function private.has_organization_role(uuid,text[]) to authenticated;
  `);
  await sql('insert into auth.users values ($1),($2),($3)', [owner, member, outsider]);
  await sql('insert into public.organizations values ($1),($2)', [org, otherOrg]);
  await sql('insert into public.customers(id,organization_id) values ($1,$2),($3,$4)', [customer, org, otherCustomer, otherOrg]);
  await sql("insert into public.memberships values ($1,$2,'owner'),($1,$3,'member'),($4,$5,'owner')", [org,owner,member,otherOrg,outsider]);
  await db.exec(await readFile(new URL('../../migrations/014_customer_records.sql', import.meta.url), 'utf8'));
  await sql("insert into public.treatment_records(id,organization_id,customer_id,treatment_name,created_by) values ($1,$2,$3,'Historical',$4)", [legacy,org,customer,owner]);
  await db.exec(await readFile(new URL('../../migrations/016_treatment_lifecycle.sql', import.meta.url), 'utf8'));
  await asUser(owner);
  await check('legacy preserved without invented audit or timestamps', async () => {
    const row = await one('select * from treatment_records where id=$1',[legacy]);
    assert.equal(row.status,'legacy'); assert.equal(row.version,1);
    assert.equal(row.started_at,null); assert.equal(row.ended_at,null);
    assert.equal((await sql('select * from treatment_record_events')).rows.length,0);
  });
  let draft = await create();
  await check('new inserts default to draft and authenticated creator', async () => {
    assert.equal(draft.status,'draft'); assert.equal(draft.created_by,owner); assert.equal(draft.version,1);
  });
  await check('direct lifecycle, update, delete, audit mutations denied', async () => {
    await fails(() => sql("update treatment_records set notes='bypass' where id=$1",[draft.id]),'42501');
    await fails(() => sql('delete from treatment_records where id=$1',[draft.id]),'42501');
    for (const column of ['status','version','started_at','ended_at','created_by','created_at','updated_at']) {
      await fails(() => sql(`insert into treatment_records(organization_id,customer_id,treatment_name,${column}) values ($1,$2,'Spoof',default)`,[org,customer]),'42501');
    }
    for (const query of ['insert into treatment_record_events default values','update treatment_record_events set reason=\'x\'','delete from treatment_record_events']) {
      await fails(() => sql(query),'42501');
    }
  });
  const operation = randomUUID();
  await check('edit creates immutable before/after event', async () => {
    draft = await mutate(draft.id,1,'edit',{operation});
    assert.equal(draft.version,2); assert.equal(draft.notes,'Original');
    const event = await one('select * from treatment_record_events where treatment_id=$1',[draft.id]);
    assert.equal(event.before_data.version,1); assert.equal(event.after_data.version,2);
    assert.equal(event.before_data.notes,''); assert.equal(event.after_data.notes,'Original');
    assert.equal(event.actor_id,owner); assert.equal(event.action,'edit');
  });
  await check('same operation replays, mismatched request and stale versions conflict', async () => {
    assert.equal((await mutate(draft.id,1,'edit',{operation})).version,2);
    assert.equal((await sql('select * from treatment_record_events where treatment_id=$1',[draft.id])).rows.length,1);
    await fails(() => mutate(draft.id,1,'edit',{operation,values:{...values,notes:'Different'}}),'P0001');
    await fails(() => mutate(draft.id,1,'start'),'P0001');
  });
  await check('draft start and in-progress complete use server timestamps', async () => {
    draft = await mutate(draft.id,2,'start'); assert.equal(draft.status,'in_progress');
    assert.ok(draft.started_at); assert.equal(draft.ended_at,null);
    draft = await mutate(draft.id,3,'complete'); assert.equal(draft.status,'completed');
    assert.ok(draft.ended_at >= draft.started_at); assert.equal(draft.version,4);
    // Replaying an earlier operation returns the current row, never a stale snapshot.
    assert.equal((await mutate(draft.id,1,'edit',{operation})).version,4);
    const event = await one('select * from treatment_record_events where operation_id=$1',[operation]);
    assert.equal(event.after_data.status,'draft'); assert.equal(event.after_data.version,2);
  });
  await check('completed requires correction with reason and remains completed', async () => {
    await fails(() => mutate(draft.id,4,'edit'),'P0001');
    await fails(() => mutate(draft.id,4,'correct'),'22023');
    draft = await mutate(draft.id,4,'correct',{reason:'Fix notes',values:{...values,notes:'Corrected'}});
    assert.equal(draft.status,'completed'); assert.equal(draft.version,5);
  });
  await check('cancel draft/in-progress, correction cancelled, legacy edit/correct', async () => {
    for (const start of [false,true]) {
      let row = await create();
      if (start) row = await mutate(row.id,row.version,'start');
      await fails(() => mutate(row.id,row.version,'cancel',{reason:' \t\n '}),'22023');
      row = await mutate(row.id,row.version,'cancel',{reason:'Customer cancelled'});
      assert.equal(row.status,'cancelled'); assert.ok(row.ended_at);
      await fails(() => mutate(row.id,row.version,'start'),'P0001');
      row = await mutate(row.id,row.version,'correct',{reason:'Administrative correction'});
      assert.equal(row.status,'cancelled');
    }
    await fails(() => mutate(legacy,1,'start'),'P0001');
    assert.equal((await mutate(legacy,1,'edit')).status,'legacy');
    assert.equal((await mutate(legacy,2,'correct',{reason:'Correct old entry'})).status,'legacy');
  });
  const invalidRow = await create();
  await check('invalid values and metadata injection rejected without state/audit changes', async () => {
    for (const [patch,code] of [
      [{treatment_name:''},'23514'], [{treatment_name:'\t\n'},'23514'], [{treatment_name:'a'.repeat(201)},'23514'],
      [{category:'a'.repeat(101)},'23514'], [{practitioner:'a'.repeat(101)},'23514'],
      [{notes:'a'.repeat(10001)},'23514'], [{next_visit_date:'2026-09-17'},'23514'],
      [{treatment_date:'2026-02-30'},'22008'], [{treatment_date:'infinity'},'22023'],
      [{amount:'-1'},'22023'], [{amount:'1.001'},'22023'], [{amount:'NaN'},'22023'],
      [{amount:'1000000000000'},'22003'], [{status:'completed'},'22023'], [{notes:null},'22023'],
    ]) await fails(() => mutate(invalidRow.id,1,'edit',{values:{...values,...patch}}),code);
    await fails(() => mutate(invalidRow.id,1,'edit',{values:{treatment_name:'Partial'}}),'22023');
    await fails(() => mutate(invalidRow.id,1,'start',{values:{started_at:'2026-01-01'}}),'22023');
    assert.equal((await one('select version from treatment_records where id=$1',[invalidRow.id])).version,1);
    assert.equal((await sql('select * from treatment_record_events where treatment_id=$1',[invalidRow.id])).rows.length,0);
  });
  await check('wrong customer/id concealed and other organization denied', async () => {
    await fails(() => mutate(draft.id,5,'correct',{reason:'x',customer:otherCustomer}),'P0002');
    await fails(() => mutate(randomUUID(),1,'edit'),'P0002');
    await fails(() => mutate(draft.id,5,'correct',{reason:'x',org:otherOrg}),'42501');
  });
  await check('member can read records/events but cannot mutate or insert', async () => {
    await asUser(member);
    assert.ok((await sql('select * from treatment_records')).rows.length);
    assert.ok((await sql('select * from treatment_record_events')).rows.length);
    await fails(() => mutate(draft.id,5,'correct',{reason:'x'}),'42501');
    await fails(create,'42501');
  });
  await check('other organization sees no records or audit and cannot mutate', async () => {
    await asUser(outsider);
    assert.equal((await sql('select * from treatment_records')).rows.length,0);
    assert.equal((await sql('select * from treatment_record_events')).rows.length,0);
    await fails(() => mutate(draft.id,5,'correct',{reason:'x'}),'42501');
  });
  await check('missing authentication and anonymous RPC calls forbidden', async () => {
    await asUser(null); await fails(() => mutate(draft.id,5,'correct',{reason:'x'}),'42501');
    await asUser(owner,'anon'); await fails(() => mutate(draft.id,5,'correct',{reason:'x'}),'42501');
    await asUser(owner);
  });
  await check('audit insertion failure atomically rolls record back', async () => {
    await db.exec(`reset role;
      create function private.reject_test_event() returns trigger language plpgsql as
      $$ begin raise exception 'injected audit failure'; end $$;
      create trigger reject_test_event before insert on treatment_record_events
        for each row execute function private.reject_test_event();`);
    await asUser(owner);
    await fails(() => mutate(invalidRow.id,1,'start'),'P0001');
    assert.equal((await one('select version from treatment_records where id=$1',[invalidRow.id])).version,1);
    await db.exec('reset role; drop trigger reject_test_event on treatment_record_events');
  });
  await check('customer/treatment cascade cannot erase audited history', async () => {
    await fails(() => sql('delete from treatment_records where id=$1',[draft.id]),'23001');
    await fails(() => sql('delete from customers where id=$1',[customer]),'23001');
    assert.ok((await sql('select * from treatment_record_events')).rows.length);
  });
  console.log(`PASS ${checks} treatment lifecycle database checks (isolated PGlite PostgreSQL)`);
} finally { await db.close(); }
