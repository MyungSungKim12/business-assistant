import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(import.meta.dirname, '../../../migrations/095_crm14_block_customer_erasure.sql'), 'utf-8').replace(/\r\n?/g, '\n').toLowerCase();

describe('095_crm14_block_customer_erasure.sql', () => {
  it('removes manager delete policy and table delete privileges for exposed user roles', () => {
    expect(sql).toContain('drop policy if exists "customers_delete_manager" on public.customers');
    expect(sql).toContain('revoke delete on table public.customers from public, anon, authenticated');
  });

  it('does not reintroduce a delete policy, delete grant, or destructive function', () => {
    expect(sql).not.toMatch(/create\s+policy[\s\S]*?for\s+delete/);
    expect(sql).not.toMatch(/grant\s+[^;]*\bdelete\b[^;]*\bon\s+public\.customers/);
    expect(sql).not.toMatch(/delete\s+from\s+public\.customers/);
  });

  it('runs transactionally and is safe to apply again', () => {
    expect(sql.trim().startsWith('--')).toBe(true);
    expect(sql).toContain('\nbegin;');
    expect(sql).toContain('drop policy if exists');
    expect(sql.trim().endsWith('commit;')).toBe(true);
  });
});
