// 040_audit_log.sql 계약 테스트: RLS, append-only, 보안 정의 함수의 search_path 고정, 권한 회수.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(import.meta.dirname, '../../../migrations/040_audit_log.sql'), 'utf-8').replace(/\r\n?/g, '\n').toLowerCase();
const has = (needle: string) => expect(sql.includes(needle), needle).toBe(true);

describe('040_audit_log.sql', () => {
  it('감사 테이블은 RLS가 켜져 있고 조회는 조직 owner/admin 으로 제한된다', () => {
    has('create table if not exists public.audit_events');
    has('alter table public.audit_events enable row level security');
    has("for select to authenticated");
    has("private.has_organization_role(organization_id, array['owner', 'admin']::text[])");
    expect(sql).not.toMatch(/for (insert|update|delete|all)\b/);
  });

  it('일반 사용자 역할에는 select 만 주고 insert 는 서비스 경로에만 준다', () => {
    has('revoke all on public.audit_events from public, anon, authenticated, service_role');
    has('grant select on public.audit_events to authenticated');
    has('grant select, insert on public.audit_events to service_role');
    expect(sql).not.toMatch(/grant [^;]*\b(update|delete|truncate)\b[^;]* on public\.audit_events/);
  });

  it('update/delete/truncate 는 트리거로 막는다', () => {
    has('create trigger audit_events_append_only');
    has('before update or delete on public.audit_events');
    has('create trigger audit_events_no_truncate');
    has('before truncate on public.audit_events');
    has("raise exception 'audit_events is append-only'");
  });

  it('record_audit_event 는 security definer + search_path 고정이며 actor 를 auth.uid() 로 강제한다', () => {
    const body = sql.slice(sql.indexOf('create or replace function public.record_audit_event'));
    expect(body).toContain('security definer');
    expect(body).toContain("set search_path = ''");
    expect(body).toContain('(select auth.uid())');
    expect(body).toContain("private.has_organization_role(p_organization_id, array['owner', 'admin', 'member']::text[])");
    // actor_id 와 source 는 인자가 아니라 함수가 정한다.
    expect(body).not.toMatch(/p_actor/);
    expect(body).toContain("'api_user')");
    has('revoke all on function public.record_audit_event(uuid, text, text, text, jsonb, text, inet) from public, anon');
    has('grant execute on function public.record_audit_event(uuid, text, text, text, jsonb, text, inet) to authenticated');
  });

  it('모든 함수는 search_path 를 고정한다', () => {
    const definitions = sql.match(/create or replace function [\s\S]*?\$\$;/g) ?? [];
    expect(definitions.length).toBe(2);
    for (const definition of definitions) expect(definition).toContain("set search_path = ''");
  });

  it('action 형식·메타데이터 크기·조직/사용자 삭제 비차단 설계를 검사한다', () => {
    has("check (action ~ '^[a-z][a-z0-9_]{1,40}(\\.[a-z][a-z0-9_]{1,40}){1,2}$')");
    has("jsonb_typeof(metadata) = 'object'");
    has('length(metadata::text) <= 4000');
    has("source in ('api_user', 'service')");
    expect(sql).not.toMatch(/references public\.organizations/);
    expect(sql).not.toMatch(/references auth\.users/);
  });

  it('조회용 인덱스가 있고 트랜잭션으로 감싸져 있다', () => {
    has('audit_events_org_created');
    has('audit_events_org_action_created');
    expect(sql.trim().startsWith('--')).toBe(true);
    has('\nbegin;');
    expect(sql.trim().endsWith('commit;')).toBe(true);
  });
});
