// 044_customer_crm_tools.sql 계약 테스트: RLS, 권한, search_path 고정, 병합 FK 이동 목록 검사.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDir = resolve(import.meta.dirname, '../../../migrations');
const read = (name: string) => readFileSync(resolve(migrationsDir, name), 'utf-8').replace(/\r\n?/g, '\n');
const sql = read('044_customer_crm_tools.sql').toLowerCase();
const has = (needle: string) => expect(sql.includes(needle), needle).toBe(true);
const functionBody = (name: string) => {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('\n$$;', start));
};

describe('044_customer_crm_tools.sql', () => {
  it('is wrapped in one transaction and does not edit earlier migrations', () => {
    expect(sql.trimStart().startsWith('-- crm')).toBe(true);
    expect(sql).toMatch(/\nbegin;\n/);
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
  });

  it('allows the archived status the app already uses', () => {
    has('drop constraint if exists customers_status_check');
    has("status in ('active', 'inactive', 'vip', 'blocked', 'archived')");
  });

  it('keeps merge history behind RLS with manager-only reads and no direct writes', () => {
    has('alter table public.customer_merge_history enable row level security');
    has("private.has_organization_role(organization_id, array['owner', 'admin']::text[])");
    has('revoke all on public.customer_merge_history from public, anon, authenticated');
    has('grant select on public.customer_merge_history to authenticated');
    expect(sql).not.toMatch(/grant [^;]*\b(insert|update|delete)\b[^;]* on public\.customer_merge_history/);
    has('unique (organization_id, operation_id)');
  });

  it('pins search_path on every security definer function', () => {
    const definitions = sql.match(/create or replace function [\s\S]*?\n\$\$;/g) ?? [];
    expect(definitions.length).toBe(6);
    for (const definition of definitions) {
      expect(definition).toContain('security definer');
      expect(definition).toContain("set search_path = ''");
    }
  });

  it('revokes anonymous execution and grants authenticated only', () => {
    const signatures = [
      'list_customer_tags(uuid)', 'merge_customer_tags(uuid, text[], text)', 'rename_customer_tag(uuid, text, text)',
      'delete_customer_tag(uuid, text)', 'find_duplicate_customer_groups(uuid)', 'merge_customers(uuid, uuid, uuid, uuid, jsonb)',
    ];
    for (const signature of signatures) {
      has(`revoke all on function public.${signature} from public, anon`);
      has(`grant execute on function public.${signature} to authenticated`);
    }
  });

  it('limits tag and merge writes to owner/admin and reads to members', () => {
    for (const name of ['merge_customer_tags', 'delete_customer_tag', 'merge_customers']) {
      const body = functionBody(name);
      expect(body, name).toContain("array['owner', 'admin']::text[]");
      expect(body, name).not.toContain("'member'");
    }
    for (const name of ['list_customer_tags', 'find_duplicate_customer_groups']) {
      expect(functionBody(name), name).toContain("array['owner', 'admin', 'member']::text[]");
    }
  });

  it('merges idempotently, archives instead of deleting, and refuses immutable handoff records', () => {
    const body = functionBody('merge_customers');
    expect(body).toContain('p_operation_id');
    expect(body).toContain('pg_advisory_xact_lock');
    expect(body).toContain("raise exception 'operation conflict'");
    expect(body).toContain("set status = 'archived'");
    expect(body).not.toMatch(/delete from public\.customers/);
    expect(body).toContain('public.treatment_sale_drafts');
    expect(body).toContain('insert into public.customer_merge_history');
  });

  it('moves every customer-referencing table found across all migrations', () => {
    const body = functionBody('merge_customers');
    const moved = [
      'customer_activities', 'customer_photos', 'appointments', 'customer_wallets', 'customer_visits', 'sale_carts',
      'treatment_records', 'treatment_photos', 'treatment_record_events', 'issued_treatment_documents',
    ];
    for (const table of moved) expect(body, table).toContain(`update public.${table}`);
    // (id, customer_id) 복합 FK 묶음은 즉시 검사되므로 한 문장(CTE)에서 같이 옮긴다.
    expect(body).toContain('with moved_visits as');
    expect(body).toContain('moved_carts as');
    expect(body).toContain('with moved_records as');
  });

  it('covers every table in the migrations that references public.customers or carries customer_id', () => {
    const referencing = new Set<string>();
    const files = readdirSync(migrationsDir).filter((name) => /^\d+_.*\.sql$/.test(name) && !name.startsWith('044_'));
    for (const file of files) {
      const text = read(file);
      for (const match of text.matchAll(/create table(?: if not exists)? public\.(\w+)\s*\(([\s\S]*?)\n\s*\);/gi)) {
        if (/\bcustomer_id\b/i.test(match[2]!)) referencing.add(match[1]!);
      }
    }
    const handledElsewhere = new Set(['treatment_sale_drafts']);
    const body = functionBody('merge_customers');
    expect(referencing.size).toBeGreaterThanOrEqual(10);
    for (const table of referencing) {
      if (handledElsewhere.has(table)) {
        expect(body, table).toContain(`public.${table}`);
        continue;
      }
      expect(body, `merge_customers must move ${table}`).toContain(`update public.${table}`);
    }
  });
});
