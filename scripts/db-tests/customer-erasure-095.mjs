import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const migration = await readFile(new URL('../../migrations/095_crm14_block_customer_erasure.sql', import.meta.url), 'utf8');
const query = (sql) => db.query(sql);

try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create table public.customers (id integer primary key);
    insert into public.customers values (1);
    grant select, delete on public.customers to authenticated;
    alter table public.customers enable row level security;
    create policy customers_select_member on public.customers for select to authenticated using (true);
    create policy "customers_delete_manager" on public.customers for delete to authenticated using (true);
  `);

  await db.exec(migration);
  await db.exec(migration);

  await db.exec('set role authenticated');
  assert.equal((await query('select count(*)::int as count from public.customers')).rows[0].count, 1);
  await assert.rejects(query('delete from public.customers where id = 1'), error => error.code === '42501');
  await db.exec('reset role');

  const policies = await query("select policyname from pg_policies where schemaname = 'public' and tablename = 'customers' and cmd = 'DELETE'");
  assert.deepEqual(policies.rows, []);
  assert.equal((await query('select count(*)::int as count from public.customers')).rows[0].count, 1);
  console.log('PASS CRM-014 blocks authenticated customer deletion and remains repeatable');
} finally {
  await db.close();
}
