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
  await db.exec(await readFile(new URL('../../migrations/017_treatment_consultation.sql', import.meta.url), 'utf8'));
  const cautions = { allergies: '', skin_type: null, concerns: [] };
  const consultation = { goal: 'Improve comfort', plan: 'Gentle service', acknowledge_cautions: true, expected_cautions: cautions };
  const consult = (row, patch = {}, options = {}) => mutate(row.id, row.version, 'consult', { ...options, values: { ...consultation, ...patch } });
  await asUser(owner);
  let row = await create();
  await check('historical records retain unknown consultation', async () => {
    const old = await one('select * from treatment_records where id=$1', [legacy]);
    assert.equal(old.status, 'legacy'); assert.equal(old.consultation_goal, '');
    assert.equal(old.cautions_acknowledged_at, null);
    await fails(() => mutate(legacy, 1, 'consult', {values: consultation}), 'P0001');
  });
  await check('start requires consultation and blank draft save remains allowed', async () => {
    await fails(() => mutate(row.id, row.version, 'start'), 'P0001');
    row = await consult(row, {goal: '', plan: '', acknowledge_cautions: false});
    assert.equal(row.consultation_goal, ''); assert.equal(row.cautions_acknowledged_by, null);
    await fails(() => mutate(row.id, row.version, 'start'), 'P0001');
  });
  await check('acknowledgment stores actor/time/snapshot and atomic audit', async () => {
    const beforeVersion = row.version;
    row = await consult(row);
    assert.equal(row.version, beforeVersion + 1);
    assert.deepEqual(row.cautions_snapshot, cautions);
    assert.equal(row.cautions_acknowledged_by, owner); assert.ok(row.cautions_acknowledged_at);
    const event = await one("select * from treatment_record_events where treatment_id=$1 and action='consult' order by occurred_at desc limit 1", [row.id]);
    assert.equal(event.before_data.version, beforeVersion);
    assert.equal(event.after_data.cautions_acknowledged_by, owner);
    assert.deepEqual(event.after_data.cautions_snapshot, cautions);
  });
  await check('stale displayed profile cannot be acknowledged or started', async () => {
    await db.exec('reset role');
    await sql("update customers set allergies='New allergy' where id=$1", [customer]);
    await asUser(owner);
    await fails(() => consult(row), 'P0001');
    await fails(() => mutate(row.id, row.version, 'start'), 'P0001');
    cautions.allergies = 'New allergy';
    row = await consult(row);
  });
  await check('unchecking acknowledgment clears metadata; whitespace goal cannot start', async () => {
    row = await consult(row, {acknowledge_cautions: false});
    assert.deepEqual(row.cautions_snapshot, {}); assert.equal(row.cautions_acknowledged_at, null);
    await fails(() => mutate(row.id, row.version, 'start'), 'P0001');
    row = await consult(row, {goal: ' \t\n'});
    await fails(() => mutate(row.id, row.version, 'start'), 'P0001');
    row = await consult(row);
  });
  await check('replay retains idempotency after customer changes and start', async () => {
    const operation = randomUUID(), version = row.version;
    row = await mutate(row.id, version, 'start', {operation});
    assert.equal(row.status, 'in_progress'); assert.ok(row.started_at);
    await db.exec('reset role');
    await sql("update customers set skin_type='Sensitive' where id=$1", [customer]);
    await asUser(owner);
    assert.equal((await mutate(row.id, version, 'start', {operation})).version, row.version);
    await fails(() => mutate(row.id, version, 'start', {operation, reason: 'changed'}), 'P0001');
    await fails(() => consult(row), 'P0001');
    row = await mutate(row.id, row.version, 'complete');
    assert.equal(row.status, 'completed');
    await fails(() => consult(row), 'P0001');
    cautions.skin_type = 'Sensitive';
  });
  let draft = await create();
  await check('consult replay and version conflicts preserve state', async () => {
    const operation = randomUUID();
    const original = draft;
    draft = await consult(draft, {}, {operation});
    assert.equal((await consult(original, {}, {operation})).version, draft.version);
    await fails(() => consult(original), 'P0001');
    await fails(() => consult(original, {plan: 'Other'}, {operation}), 'P0001');
  });
  await check('exact fields/types/lengths reject metadata and malformed cautions atomically', async () => {
    for (const patch of [
      {goal: null}, {goal: 1}, {goal: 'x'.repeat(2001)}, {plan: 'x'.repeat(5001)},
      {plan: null}, {acknowledge_cautions: 'true'}, {acknowledge_cautions: null},
      {actor_id: owner}, {cautions_acknowledged_at: '2026-01-01'},
      {expected_cautions: null}, {expected_cautions: []}, {expected_cautions: {}},
      {expected_cautions: {...cautions, extra: true}}, {expected_cautions: {...cautions, allergies: null}},
      {expected_cautions: {...cautions, skin_type: 1}}, {expected_cautions: {...cautions, concerns: [null]}},
      {expected_cautions: {...cautions, concerns: ['ok', {}]}}, {expected_cautions: {...cautions, concerns: 'bad'}},
    ]) await fails(() => consult(draft, patch), '22023');
    await fails(() => mutate(draft.id, draft.version, 'consult', {values: {goal: ''}}), '22023');
    assert.equal((await one('select version from treatment_records where id=$1', [draft.id])).version, draft.version);
    assert.equal((await sql('select * from treatment_record_events where treatment_id=$1', [draft.id])).rows.length, 1);
  });
  await check('direct metadata writes and v16 bypass are denied', async () => {
    for (const column of ['consultation_goal','consultation_plan','cautions_snapshot','cautions_acknowledged_by','cautions_acknowledged_at']) {
      await fails(() => sql(`insert into treatment_records(organization_id,customer_id,treatment_name,${column}) values ($1,$2,'Spoof',default)`, [org,customer]), '42501');
    }
    await fails(() => sql("update treatment_records set consultation_goal='spoof' where id=$1", [draft.id]), '42501');
    await fails(() => sql("select * from private.mutate_treatment_v16($1,$2,$3,$4,$5,'start','', '{}'::jsonb)", [org,customer,draft.id,draft.version,randomUUID()]), '42501');
  });
  await check('organization/customer/auth/role scope enforced for consult', async () => {
    await fails(() => consult(draft, {}, {customer: otherCustomer}), 'P0002');
    await fails(() => consult(draft, {}, {org: otherOrg}), '42501');
    for (const actor of [member, outsider, null]) {
      await asUser(actor); await fails(() => consult(draft), '42501');
    }
    await asUser(owner, 'anon'); await fails(() => consult(draft), '42501');
    await asUser(owner);
  });
  await check('consult audit failure rolls back all consultation fields/version', async () => {
    await db.exec(`reset role;
      create function private.reject_test_event() returns trigger language plpgsql as
      $$ begin raise exception 'injected audit failure'; end $$;
      create trigger reject_test_event before insert on treatment_record_events
      for each row execute function private.reject_test_event();`);
    await asUser(owner);
    await fails(() => consult(draft, {goal: 'Must roll back'}), 'P0001');
    const unchanged = await one('select * from treatment_records where id=$1', [draft.id]);
    assert.equal(unchanged.consultation_goal, draft.consultation_goal);
    assert.equal(unchanged.version, draft.version);
    await db.exec('reset role; drop trigger reject_test_event on treatment_record_events');
    await asUser(owner);
  });
  await check('boundary lengths save, ordinary edit preserves consult, cancelled consult denied', async () => {
    draft = await consult(draft, {goal: 'x'.repeat(2000), plan: 'y'.repeat(5000)});
    draft = await mutate(draft.id, draft.version, 'edit');
    assert.equal(draft.consultation_goal.length, 2000);
    assert.equal(draft.consultation_plan.length, 5000);
    assert.deepEqual(draft.cautions_snapshot, cautions);
    draft = await mutate(draft.id, draft.version, 'cancel', {reason: 'Customer cancelled'});
    await fails(() => consult(draft), 'P0001');
  });
  console.log(`PASS ${checks} consultation database checks (isolated PGlite PostgreSQL)`);
} finally { await db.close(); }
