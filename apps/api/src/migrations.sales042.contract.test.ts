// 042_sales_search_finance_month_close.sql 계약 테스트: RLS, 권한, search_path 고정, 마감 트리거.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(import.meta.dirname, '../../../migrations/042_sales_search_finance_month_close.sql'), 'utf-8').replace(/\r\n?/g, '\n').toLowerCase();
const has = (needle: string) => expect(sql.includes(needle), needle).toBe(true);
const functionBody = (name: string) => {
  const start = sql.indexOf(`create or replace function ${name}`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf('\n$$;', start);
  return sql.slice(start, end + 4);
};

describe('042_sales_search_finance_month_close.sql', () => {
  it('트랜잭션 안에서 멱등하게 실행된다', () => {
    expect(sql).toMatch(/^[\s\S]*\nbegin;\n/);
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
    has('create table if not exists public.finance_month_closings');
    has('create unique index if not exists finance_month_closings_active');
    has('drop trigger if exists finance_transactions_month_open on public.finance_transactions');
    has('drop policy if exists finance_month_closings_member_select on public.finance_month_closings');
    expect(sql).not.toMatch(/\bdrop (table|function)\b/);
    expect(sql).not.toMatch(/alter table public\.(finance_transactions|visit_payment|sale_cart)/);
  });

  it('월 마감 테이블은 RLS가 켜져 있고 구성원 조회만 열려 있다', () => {
    has('alter table public.finance_month_closings enable row level security');
    has('for select to authenticated');
    has("private.has_organization_role(organization_id, array['owner', 'admin', 'member']::text[])");
    has('revoke all on public.finance_month_closings from public, anon, authenticated');
    has('grant select on public.finance_month_closings to authenticated');
    expect(sql).not.toMatch(/grant [^;]*\b(insert|update|delete)\b[^;]* on public\.finance_month_closings/);
    expect(sql).not.toMatch(/create policy [^;]* for (insert|update|delete|all)\b/);
  });

  it('한 달에 유효한 마감은 1건이고 달은 첫날이어야 한다', () => {
    has("check (month = date_trunc('month', month::timestamp)::date)");
    has('on public.finance_month_closings (organization_id, month) where reopened_at is null');
    has('check (length(btrim(note)) between 1 and 1000)');
    has('(reopened_at is null) = (reopened_by is null)');
    has('(reopened_at is null) = (reopen_reason is null)');
  });

  it('마감 행은 삭제할 수 없고 재오픈 필드만 한 번 채울 수 있다', () => {
    const guard = functionBody('private.guard_finance_month_closing_change');
    expect(guard).toContain("set search_path = ''");
    expect(guard).toContain("tg_op = 'delete'");
    expect(guard).toContain('old.reopened_at is not null');
    expect(guard).toContain('new.note is distinct from old.note');
    has('before update or delete on public.finance_month_closings');
  });

  it('거래 트리거는 마감된 달의 입력·수정을 막고 옮겨 가는 거래일도 확인한다', () => {
    const trigger = functionBody('private.prevent_closed_finance_month_change');
    expect(trigger).toContain('security definer');
    expect(trigger).toContain("set search_path = ''");
    expect(trigger).toContain('array[old.transaction_date, new.transaction_date]');
    expect(trigger).toContain('c.reopened_at is null');
    expect(trigger).toContain("raise exception 'finance month is closed' using errcode = 'p0001'");
    expect(trigger).toContain('private.finance_month_lock');
    has('create trigger finance_transactions_month_open');
    has('before insert or update on public.finance_transactions');
    has('revoke all on function private.prevent_closed_finance_month_change() from public, anon, authenticated');
  });

  it('마감·재오픈은 owner/admin만, 사유를 필수로 기록한다', () => {
    for (const name of ['public.close_finance_month', 'public.reopen_finance_month']) {
      const body = functionBody(name);
      expect(body, name).toContain('security definer');
      expect(body, name).toContain("set search_path = ''");
      expect(body, name).toContain("private.has_organization_role(p_organization_id, array['owner', 'admin']::text[])");
      expect(body, name).not.toContain("'member'");
      expect(body, name).toContain("errcode = '42501'");
      expect(body, name).toContain('private.finance_month_lock');
    }
    const close = functionBody('public.close_finance_month');
    expect(close).toContain('length(btrim(p_note)) not between 1 and 1000');
    expect(close).toContain("(now() at time zone 'asia/seoul')");
    expect(close).toContain("raise exception 'finance month already closed' using errcode = 'p0001'");
    const reopen = functionBody('public.reopen_finance_month');
    expect(reopen).toContain('length(btrim(p_reason)) not between 1 and 1000');
    expect(reopen).toContain("raise exception 'finance month is not closed' using errcode = 'p0002'");
    has('revoke all on function public.close_finance_month(uuid, date, text) from public, anon, authenticated');
    has('grant execute on function public.close_finance_month(uuid, date, text) to authenticated');
    has('revoke all on function public.reopen_finance_month(uuid, date, text) from public, anon, authenticated');
    has('grant execute on function public.reopen_finance_month(uuid, date, text) to authenticated');
  });

  it('수납 검색은 구성원 읽기 전용이며 조직 범위·필터·합계를 갖는다', () => {
    const body = functionBody('public.list_sale_payments');
    expect(body).toContain('stable');
    expect(body).toContain('security definer');
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("private.has_organization_role(p_organization_id, array['owner', 'admin', 'member']::text[])");
    expect(body).toContain("errcode = '42501'");
    expect(body).toContain("errcode = '22023'");
    for (const table of ['visit_payment_receipts', 'wallet_usage_ledger', 'visit_payment_refunds', 'visit_product_returns']) expect(body).toContain(`public.${table}`);
    expect(body.match(/organization_id = p_organization_id/g)!.length).toBeGreaterThanOrEqual(4);
    expect(body).toContain("'asia/seoul'");
    expect(body).toContain("p_limit > 200");
    expect(body).toContain("'payment_total'");
    expect(body).toContain("'net_total'");
    expect(body).toContain("'next_cursor'");
    expect(body).not.toMatch(/\b(insert|update|delete)\b\s+(into|public)/);
    has('revoke all on function public.list_sale_payments(uuid, date, date, uuid, text, text, text, text, text, integer, timestamptz, uuid) from public, anon, authenticated');
    has('grant execute on function public.list_sale_payments(uuid, date, date, uuid, text, text, text, text, text, integer, timestamptz, uuid) to authenticated');
  });

  it('전체 미수금 요약은 구성원 읽기 전용이며 수납 중 장바구니만 센다', () => {
    const body = functionBody('public.get_receivables_summary');
    expect(body).toContain('stable');
    expect(body).toContain('security definer');
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("private.has_organization_role(p_organization_id, array['owner', 'admin', 'member']::text[])");
    expect(body).toContain("c.organization_id = p_organization_id and c.status = 'collecting'");
    expect(body).toContain('p_limit > 50');
    expect(body).toContain('due_amount > 0');
    has('revoke all on function public.get_receivables_summary(uuid, integer) from public, anon, authenticated');
    has('grant execute on function public.get_receivables_summary(uuid, integer) to authenticated');
  });

  it('모든 함수는 search_path를 고정하고 anon에게 실행 권한을 주지 않는다', () => {
    const definitions = sql.match(/create or replace function [\s\S]*?\n\$\$;/g) ?? [];
    expect(definitions.length).toBe(8);
    for (const definition of definitions) expect(definition).toContain("set search_path = ''");
    expect(sql).not.toMatch(/grant execute on function [^;]* to (public|anon)\b/);
    expect(sql).not.toMatch(/search_path\s*(=|to)\s*'?public/);
  });
});
