// 041_catalog_service_wallet_admin.sql 계약 테스트: 컬럼, 권한, search_path 고정, 멱등·낙관적 잠금, 기존 시그니처 보존.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(import.meta.dirname, '../../../migrations/041_catalog_service_wallet_admin.sql'), 'utf-8').replace(/\r\n?/g, '\n').toLowerCase();
const has = (needle: string) => expect(sql.includes(needle), needle).toBe(true);
const functionBody = (name: string) => {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  return sql.slice(start, sql.indexOf('end $$;', start));
};

describe('041_catalog_service_wallet_admin.sql', () => {
  it('트랜잭션 안에서 멱등하게 컬럼을 추가한다', () => {
    expect(sql.startsWith('--')).toBe(true);
    has('begin;');
    has('commit;');
    has('add column if not exists low_stock_threshold integer');
    has('low_stock_threshold is null or low_stock_threshold between 0 and 1000000000');
    has('add column if not exists price_krw integer not null default 0 check (price_krw between 0 and 1000000000)');
    has("add column if not exists category text not null default '' check (length(category) <= 60)");
    has('add column if not exists service_version bigint not null default 1');
    expect(sql).not.toMatch(/create (unique )?(table|index) (?!if not exists)/);
    expect(sql).not.toMatch(/drop (table|column|function)/);
  });

  it('기존 RPC 시그니처를 바꾸지 않는다', () => {
    expect(sql).not.toContain('function public.save_catalog_product');
    expect(sql).not.toContain('function public.create_appointment_service');
    expect(sql).not.toContain('function public.manage_customer_wallet');
    expect(sql).not.toContain('function public.list_customer_wallets');
  });

  it('모든 새 함수는 security definer 이고 search_path 를 고정한다', () => {
    const definitions = sql.split('create or replace function public.').slice(1).map((part) => part.slice(0, part.indexOf('end $$;')));
    expect(definitions.length).toBe(4);
    for (const definition of definitions) {
      expect(definition).toContain('security definer');
      expect(definition).toContain("set search_path=''");
    }
  });

  it('쓰기 RPC 는 owner/admin 확인, 낙관적 잠금, 멱등 키를 갖는다', () => {
    const lowStock = functionBody('set_catalog_low_stock_threshold');
    expect(lowStock).toContain('private.assert_sale_cart_manager(p_organization_id)');
    expect(lowStock).toContain('p_expected_version');
    expect(lowStock).toContain('for update');
    expect(lowStock).toContain("'set_low_stock'");
    expect(lowStock).toContain("kind<>'product'");
    expect(lowStock).toContain('version=version+1');
    const service = functionBody('update_appointment_service');
    expect(service).toContain('private.assert_appointment_role(p_organization_id,true)');
    expect(service).toContain('organization_id=p_organization_id and id=p_service_id for update');
    expect(service).toContain('s.service_version<>p_expected_version');
    expect(service).toContain('service_version=service_version+1');
    expect(service).toContain('public.appointment_operations');
    expect(service).toContain('operation conflict');
    // 미래 예약이 있어도 비활성화를 막지 않는다.
    expect(service).not.toContain('public.appointments');
  });

  it('읽기 RPC 는 조직 구성원(member 포함)만 허용하고 조직·고객·지갑 일치를 확인한다', () => {
    for (const name of ['list_organization_wallets', 'list_wallet_history']) {
      const body = functionBody(name);
      expect(body).toContain("private.has_organization_role(p_organization_id,array['owner','admin','member']::text[])");
      expect(body).toContain('auth.uid() is null');
    }
    const history = functionBody('list_wallet_history');
    expect(history).toContain('customer_id=p_customer_id and id=p_wallet_id');
    for (const table of ['wallet_issuance_ledger', 'wallet_usage_ledger', 'visit_payment_refunds', 'catalog_sale_reversal_ledger', 'wallet_lifecycle_events']) expect(history).toContain(`public.${table}`);
    expect(history).toContain('limit 500');
  });

  it('anon 실행은 회수하고 authenticated 에만 부여한다', () => {
    const signatures = [
      'set_catalog_low_stock_threshold(uuid,uuid,integer,bigint,uuid)',
      'update_appointment_service(uuid,uuid,text,integer,integer,integer,text,boolean,bigint,uuid)',
      'list_organization_wallets(uuid)',
      'list_wallet_history(uuid,uuid,uuid)',
    ];
    for (const signature of signatures) {
      has(`revoke all on function public.${signature} from public,anon,authenticated;`);
      has(`grant execute on function public.${signature} to authenticated;`);
    }
    expect(sql).not.toMatch(/grant [^;]*to (anon|public)\b/);
  });
});
