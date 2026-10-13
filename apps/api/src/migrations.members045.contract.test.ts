// 045_organization_members.sql 계약 테스트: 보안 정의, search_path 고정, 권한 회수, owner/admin 확인, 마지막 owner 보호.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(import.meta.dirname, '../../../migrations/045_organization_members.sql'), 'utf-8').replace(/\r\n?/g, '\n').toLowerCase();
const FUNCTIONS = ['list_organization_members', 'add_organization_member_by_email', 'set_organization_member_role', 'remove_organization_member'];
const definitionOf = (name: string) => {
  const start = sql.indexOf(`create or replace function public.${name}`);
  return sql.slice(start, sql.indexOf('$$;', sql.indexOf('as $$', start)) + 3);
};

describe('045_organization_members.sql', () => {
  it('트랜잭션 안에서 멱등(create or replace)으로 실행된다', () => {
    expect(sql).toMatch(/\nbegin;\n/);
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
    expect(sql).not.toMatch(/create function/);
    expect(sql).not.toMatch(/drop table|alter table/);
  });

  it('모든 함수는 security definer 이고 search_path 를 비워 둔다', () => {
    const definitions = sql.match(/create or replace function [\s\S]*?\$\$;/g) ?? [];
    expect(definitions.length).toBe(FUNCTIONS.length);
    for (const definition of definitions) {
      expect(definition).toContain('security definer');
      expect(definition).toContain("set search_path = ''");
      expect(definition).toContain('(select auth.uid())');
    }
  });

  it('anon·public 실행 권한은 회수하고 authenticated 에만 부여한다', () => {
    for (const name of FUNCTIONS) {
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon;`));
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to authenticated;`));
    }
    const code = sql.split('\n').filter((line) => !line.startsWith('--')).join('\n');
    expect(code).not.toMatch(/\bto (anon|public)\b/);
  });

  it('목록·추가·제거는 owner/admin, 역할 변경은 owner 만 호출할 수 있다', () => {
    expect(definitionOf('list_organization_members')).toContain("private.has_organization_role(p_org, array['owner', 'admin']::text[])");
    expect(definitionOf('add_organization_member_by_email')).toContain("caller_role not in ('owner', 'admin')");
    expect(definitionOf('remove_organization_member')).toContain("caller_role not in ('owner', 'admin')");
    expect(definitionOf('set_organization_member_role')).toContain("private.has_organization_role(p_org, array['owner']::text[])");
  });

  it('admin 은 member 만 추가·제거할 수 있다(권한 상승 방지)', () => {
    expect(definitionOf('add_organization_member_by_email')).toContain("caller_role = 'admin' and p_role <> 'member'");
    expect(definitionOf('remove_organization_member')).toContain("caller_role = 'admin' and target_role <> 'member'");
  });

  it('마지막 owner 강등·제거와 본인 변경을 막고 owner 행을 잠근다', () => {
    for (const name of ['set_organization_member_role', 'remove_organization_member']) {
      const body = definitionOf(name);
      expect(body).toContain("raise exception 'last_owner'");
      expect(body).toContain("raise exception 'self_change'");
      expect(body).toContain("m.role = 'owner' for update");
      expect(body).toContain('owner_count <= 1');
    }
  });

  it('이메일 추가는 auth.users 를 소문자 비교하고 이미 구성원이면 거부한다', () => {
    const body = definitionOf('add_organization_member_by_email');
    expect(body).toContain('lower(u.email) = normalized');
    expect(body).toContain("raise exception 'user_not_found'");
    expect(body).toContain("raise exception 'already_member'");
    expect(body).toContain('insert into public.memberships');
  });

  it('auth.users 접근은 목록·추가 함수에만 있고 서비스 키·정책 변경은 없다', () => {
    expect(definitionOf('list_organization_members')).toContain('auth.users');
    expect(definitionOf('set_organization_member_role')).not.toContain('auth.users');
    expect(definitionOf('remove_organization_member')).not.toContain('auth.users');
    expect(sql).not.toMatch(/service_role|create policy|drop policy/);
  });
});
