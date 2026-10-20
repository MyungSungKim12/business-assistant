import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// 고객 병합(merge_customers, 044→065)을 격리 DB에서 실제로 실행한다.
// 병합 함수가 건드리는 테이블만 최소 열로 흉내 내고, 함수 본문은 065 파일의 실제 SQL을 그대로 쓴다.
const dir = new URL('../../migrations/', import.meta.url);
const migration = (name) => readFile(new URL(name, dir), 'utf8');

// 고객 ID 하나만 갖는 이동 대상 테이블. 병합이 옮겨야 하는 테이블 목록의 기준이다.
const simpleMoved = [
  'customer_activities', 'appointment_waitlist', 'customer_photos', 'customer_wallets',
  'treatment_photos', 'treatment_record_events', 'issued_treatment_documents',
];
// 열이 더 필요한 이동 대상(버전·수정자·수정 시각을 함수가 함께 갱신한다).
const versioned = ['appointments', 'customer_visits'];
const stamped = ['sale_carts', 'treatment_records'];
const handledElsewhere = ['treatment_sale_drafts']; // 존재하면 병합을 거절한다.
const known = new Set([...simpleMoved, ...versioned, ...stamped, ...handledElsewhere]);

// 새 마이그레이션이 customer_id 테이블을 추가했는데 이 테스트에 반영되지 않으면 실패한다.
const referencing = new Set();
for (const file of (await readdir(dir)).filter((name) => name.endsWith('.sql'))) {
  const text = await migration(file);
  for (const match of text.matchAll(/create table(?: if not exists)? public\.(\w+)\s*\(([\s\S]*?)\n\s*\);/gi)) {
    if (/\bcustomer_id\b/i.test(match[2])) referencing.add(match[1]);
  }
}
const unknownTables = [...referencing].filter((name) => !known.has(name));
assert.deepEqual(unknownTables, [], `병합 테스트에 없는 customer_id 테이블: ${unknownTables.join(', ')} — 병합 함수와 이 테스트에 추가하세요`);

const db = new PGlite();
const org = randomUUID(), otherOrg = randomUUID(), admin = randomUUID(), member = randomUUID();
const primary = randomUUID(), secondary = randomUUID(), foreignCustomer = randomUUID(), bystander = randomUUID();
const op = randomUUID();

try {
  const moveStubs = simpleMoved.map((t) => `create table public.${t}(id uuid primary key default gen_random_uuid(), organization_id uuid, customer_id uuid);`).join('\n');
  const versionedStubs = versioned.map((t) => `create table public.${t}(id uuid primary key default gen_random_uuid(), organization_id uuid, customer_id uuid, version bigint default 1, updated_by uuid, updated_at timestamptz);`).join('\n');
  const stampedStubs = stamped.map((t) => `create table public.${t}(id uuid primary key default gen_random_uuid(), organization_id uuid, customer_id uuid, updated_by uuid, updated_at timestamptz);`).join('\n');
  await db.exec(`
    create role anon; create role authenticated; create schema private; create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table public.organizations(id uuid primary key);
    create table public.memberships(organization_id uuid, user_id uuid, role text);
    create function private.has_organization_role(o uuid, r text[]) returns boolean language sql stable security definer set search_path='' as $$
      select exists(select 1 from public.memberships m where m.organization_id=o and m.user_id=(select auth.uid()) and m.role=any(r))$$;
    create table public.customers(
      id uuid primary key, organization_id uuid not null, name text not null, email text, phone text, birth_date date,
      skin_type text, allergies text not null default '', notes text not null default '', tags text[] not null default '{}',
      concerns text[] not null default '{}', last_visit_date date, next_visit_date date, status text not null default 'active',
      unique (id, organization_id));
    ${moveStubs}
    ${versionedStubs}
    ${stampedStubs}
    create table public.treatment_sale_drafts(id uuid primary key default gen_random_uuid(), organization_id uuid, customer_id uuid);
    grant usage on schema public, private, auth to authenticated;
  `);

  // 044 의 병합 이력 테이블 정의(읽기 정책 포함)를 그대로 가져와 적용한다.
  const base = await migration('044_customer_crm_tools.sql');
  const history = base.slice(base.indexOf('create table if not exists public.customer_merge_history'), base.indexOf('-- 4) 태그 목록'));
  await db.exec(history);
  // 검증용 조회·삽입은 authenticated 로 해도 되도록 흉내 낸 테이블에만 권한을 준다(병합 함수는 security definer).
  await db.exec('grant select on all tables in schema public to authenticated');

  // 065 의 실제 함수 정의를 적용한다. 두 번 적용해도 같다.
  const sql = await migration('065_merge_customers_waitlist.sql');
  await db.exec(sql);
  await db.exec(sql);

  await db.query("insert into public.organizations values($1),($2)", [org, otherOrg]);
  await db.query("insert into public.memberships values($1,$2,'admin'),($1,$3,'member')", [org, admin, member]);
  const insertCustomer = (id, o, name, extra = {}) => db.query(
    'insert into public.customers(id,organization_id,name,email,phone,notes,tags,concerns,last_visit_date,next_visit_date) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [id, o, name, extra.email ?? null, extra.phone ?? null, extra.notes ?? '', extra.tags ?? [], extra.concerns ?? [], extra.last ?? null, extra.next ?? null]);
  await insertCustomer(primary, org, '김대표', { tags: ['VIP', '단골'], last: '2026-01-10' });
  await insertCustomer(secondary, org, '김중복', { phone: '010-1111-2222', email: 'dup@example.com', tags: ['단골', '신규'], last: '2026-03-05', next: '2026-12-01', notes: '민감성' });
  await insertCustomer(foreignCustomer, otherOrg, '타조직');
  await insertCustomer(bystander, org, '무관고객');

  // 보조 고객의 연결 행 2개씩, 다른 고객/조직의 행 1개씩(옮기면 안 됨)을 만든다.
  const allMoved = [...simpleMoved, ...versioned, ...stamped];
  for (const table of allMoved) {
    for (let i = 0; i < 2; i += 1) await db.query(`insert into public.${table}(organization_id, customer_id) values($1,$2)`, [org, secondary]);
    await db.query(`insert into public.${table}(organization_id, customer_id) values($1,$2)`, [org, bystander]);
    await db.query(`insert into public.${table}(organization_id, customer_id) values($1,$2)`, [otherOrg, foreignCustomer]);
  }
  const count = async (table, customer) => Number((await db.query(`select count(*) as n from public.${table} where customer_id=$1`, [customer])).rows[0].n);

  const as = async (user) => {
    await db.exec('reset role; set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user ?? '']);
  };
  const merge = (o, p, s, operation = op, resolved = null) => db.query('select public.merge_customers($1,$2,$3,$4,$5) as result', [o, p, s, operation, resolved]);

  // 권한: 구성원·비로그인은 거절, 입력 검사.
  await as(member);
  await assert.rejects(() => merge(org, primary, secondary), /merge permission required/i);
  await as(null);
  await assert.rejects(() => merge(org, primary, secondary), /merge permission required/i);
  await as(admin);
  await assert.rejects(() => merge(org, primary, primary), /Invalid customer merge/);
  await assert.rejects(() => merge(org, primary, secondary, op, { id: 'x' }), /Invalid customer merge field/);
  await assert.rejects(() => merge(org, primary, foreignCustomer), /Secondary customer not found/);
  await assert.rejects(() => merge(otherOrg, primary, secondary), /merge permission required/i);
  for (const table of allMoved) assert.equal(await count(table, secondary), 2, `${table} 거절된 요청은 아무것도 옮기지 않는다`);

  // 정상 병합.
  const first = (await merge(org, primary, secondary)).rows[0].result;
  for (const table of allMoved) {
    assert.equal(await count(table, secondary), 0, `${table} 보조 고객에 남지 않는다`);
    assert.equal(await count(table, primary), 2, `${table} 대표 고객으로 이동한다`);
    assert.equal(await count(table, bystander), 1, `${table} 무관 고객은 그대로`);
    assert.equal(await count(table, foreignCustomer), 1, `${table} 다른 조직은 그대로`);
    assert.equal(first.moved[table], 2, `${table} 이동 건수 기록`);
  }
  assert.equal((await db.query("select count(*)::int as n from public.appointments where customer_id=$1 and version=2 and updated_by=$2", [primary, admin])).rows[0].n, 2);
  assert.equal(first.moved.appointment_waitlist, 2, '065: 예약 대기 목록도 대표 고객으로 옮긴다');

  // 대표 고객 필드 병합, 보조 고객 보관(삭제 아님).
  const merged = (await db.query('select * from public.customers where id=$1', [primary])).rows[0];
  assert.equal(merged.phone, '010-1111-2222');
  assert.equal(merged.email, 'dup@example.com');
  assert.deepEqual(merged.tags, ['VIP', '단골', '신규']);
  assert.equal(String(merged.last_visit_date.toISOString?.().slice(0, 10) ?? merged.last_visit_date), '2026-03-05');
  assert.match(merged.notes, /민감성/);
  const archived = (await db.query('select status, notes from public.customers where id=$1', [secondary])).rows[0];
  assert.equal(archived.status, 'archived');
  assert.match(archived.notes, /병합되어 보관됨/);
  assert.equal((await db.query('select status from public.customers where id=$1', [bystander])).rows[0].status, 'active');

  // 같은 요청 재시도는 같은 결과, 다른 내용의 같은 operation_id 는 충돌, 이력은 1건.
  const retry = (await merge(org, primary, secondary)).rows[0].result;
  assert.equal(retry.secondary_id, secondary);
  assert.equal((await db.query('select count(*)::int as n from public.customer_merge_history')).rows[0].n, 1);
  await assert.rejects(() => merge(org, primary, secondary, op, { name: '다른이름' }), /Operation conflict/);
  // 이미 병합된 고객은 다시 병합할 수 없다.
  await assert.rejects(() => merge(org, primary, secondary, randomUUID()), /already merged/);
  await assert.rejects(() => merge(org, bystander, secondary, randomUUID()), /already merged/);

  // 불변 결제 인계 기록이 있는 고객은 병합을 거절하고 아무것도 옮기지 않는다.
  const blocked = randomUUID(), target = randomUUID();
  await db.exec('reset role');
  await insertCustomer(blocked, org, '인계고객');
  await insertCustomer(target, org, '대상고객');
  await db.query('insert into public.treatment_sale_drafts(organization_id, customer_id) values($1,$2)', [org, blocked]);
  await db.query('insert into public.appointment_waitlist(organization_id, customer_id) values($1,$2)', [org, blocked]);
  await as(admin);
  await assert.rejects(() => merge(org, target, blocked, randomUUID()), /immutable sale handoff/);
  assert.equal(await count('appointment_waitlist', blocked), 1);
  assert.equal(await count('appointment_waitlist', target), 0);

  // 직접 호출 권한: 익명은 실행할 수 없다.
  await db.exec('reset role; set role anon');
  await assert.rejects(() => merge(org, primary, secondary), /permission denied/);

  console.log('065 PASS: merge moves every customer_id table incl. waitlist, scopes to org/customer, archives secondary, retry/conflict/permission/handoff guards.');
} finally {
  await db.close();
}
