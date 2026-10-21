import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(import.meta.dirname, '../../../migrations/096_plan_file_storage_quotas.sql'), 'utf-8').replace(/\r\n?/g, '\n').toLowerCase();

describe('096_plan_file_storage_quotas.sql', () => {
  it('allows unset plan limits and bounds configured limits to 1 TiB', () => {
    expect(sql).toContain('add column if not exists file_storage_quota_bytes bigint');
    expect(sql).toContain('file_storage_quota_bytes between 0 and 1099511627776');
    expect(sql).not.toMatch(/update public\.plans[\s\S]*file_storage_quota_bytes\s*=/);
  });

  it('computes the active subscription cap and includes plan, organization, and effective values in usage', () => {
    expect(sql).toContain('status in (\'trialing\',\'active\')');
    expect(sql).toContain('least(organization_quota.quota_bytes,plan_quota.quota_bytes)');
    expect(sql).toContain("'organization_quota_bytes'");
    expect(sql).toContain("'plan_quota_bytes'");
    expect(sql).toContain("'quota_bytes'");
  });

  it('uses the effective limit when reserving uploads and preserves organization quota audit', () => {
    expect(sql).toContain("(usage->>'quota_bytes')::bigint");
    expect(sql).toContain("'files.storage_quota_update'");
    expect(sql).toContain('pg_advisory_xact_lock');
  });

  it('keeps functions private to authenticated entry points and wraps changes transactionally', () => {
    expect(sql).toContain('set search_path=');
    expect(sql).toContain('revoke all on function public.reserve_file_storage_upload(uuid,uuid,text,bigint) from public,anon,authenticated');
    expect(sql).toContain('grant execute on function public.reserve_file_storage_upload(uuid,uuid,text,bigint) to authenticated');
    expect(sql.trim().startsWith('--')).toBe(true);
    expect(sql).toContain('\nbegin;');
    expect(sql.trim().endsWith('commit;')).toBe(true);
  });
});
