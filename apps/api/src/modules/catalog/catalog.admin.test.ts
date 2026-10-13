import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { registerCatalogModule } from './index.js';
import { auth, buildApp, fakeFetch, fakeOrganizations, OP, ORG, OTHER_ORG, testConfig, type FakeCall, type FakeReply, type Role } from './testkit.js';

const PRODUCT = '1a9c39fd-8e8c-4df8-a623-1f23a3a936bd';
const CUSTOMER = '3a9c39fd-8e8c-4df8-a623-1f23a3a936bd';
const WALLET = '4a9c39fd-8e8c-4df8-a623-1f23a3a936bd';
const VISIT = '2a9c39fd-8e8c-4df8-a623-1f23a3a936bd';
const PRODUCT_ROW = {
  id: PRODUCT, organization_id: ORG, sku: 'SKU-1', name: '보습 크림', kind: 'product', unit_name: '개', sale_price: '30000', benefit_money: '0',
  benefit_count: 0, valid_days: null, is_active: true, version: 2, stock_quantity: 3, low_stock_threshold: 10,
};
const ORG_WALLET = {
  id: WALLET, organization_id: ORG, customer_id: CUSTOMER, customer_name: '김고객', product_id: PRODUCT, name_snapshot: '10회 패키지',
  money_balance: '0', count_balance: 4, issued_money: '0', issued_count: 10, valid_from: '2026-10-01', expires_on: '2026-12-31',
  lifecycle_status: 'active', paused_on: null, lifecycle_version: 1, created_at: '2026-10-01T00:00:00Z',
};
const EVENT = {
  id: OP, event_type: 'use', occurred_at: '2026-10-05T01:00:00Z', money_delta: '0', count_delta: -1, reason: null, visit_id: VISIT,
  previous_expires_on: null, expires_on: null,
};

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });
function setup(reply: (call: FakeCall) => FakeReply, role: Role = 'owner', features = ['crm.basic', 'finance.basic']) {
  const { fetcher, calls } = fakeFetch(reply);
  app = buildApp((instance) => registerCatalogModule(instance, fakeOrganizations(role, features), testConfig, fetcher));
  const send = (method: 'GET' | 'PUT', path: string, payload?: unknown) => app.inject({ method, url: `/api/v1/organizations/${ORG}/${path}`, headers: auth, payload: payload as never });
  return { send, calls };
}
const rpc = (map: Record<string, unknown>) => (call: FakeCall): FakeReply => ({ body: map[call.url.pathname.split('/').pop() ?? ''] ?? null });

describe('INV-10 안전재고', () => {
  const path = `catalog-products/${PRODUCT}/low-stock`;
  const body = { operation_id: OP, expected_version: 2, low_stock_threshold: 10 };

  it('안전재고·버전·멱등 키를 새 RPC로 넘기고 상품 응답을 돌려준다', async () => {
    const { send, calls } = setup(rpc({ set_catalog_low_stock_threshold: PRODUCT_ROW }));
    const response = await send('PUT', path, body);
    expect(response.statusCode).toBe(200);
    expect(response.json().low_stock_threshold).toBe(10);
    expect(calls[0].url.pathname).toBe('/rest/v1/rpc/set_catalog_low_stock_threshold');
    expect(calls[0].body).toEqual({ p_organization_id: ORG, p_product_id: PRODUCT, p_threshold: 10, p_expected_version: 2, p_operation_id: OP });
  });

  it('null 은 공통 기본값 사용으로 전달하고 0 도 허용한다', async () => {
    const { send, calls } = setup(rpc({ set_catalog_low_stock_threshold: { ...PRODUCT_ROW, low_stock_threshold: null } }));
    expect((await send('PUT', path, { ...body, low_stock_threshold: null })).statusCode).toBe(200);
    expect((await send('PUT', path, { ...body, low_stock_threshold: 0 })).statusCode).toBe(200);
    expect((calls[0].body as { p_threshold: unknown }).p_threshold).toBeNull();
    expect((calls[1].body as { p_threshold: unknown }).p_threshold).toBe(0);
  });

  it.each([{ low_stock_threshold: -1 }, { low_stock_threshold: 1.5 }, { low_stock_threshold: '5' }, { low_stock_threshold: 1_000_000_001 }, { expected_version: 0 }, { operation_id: 'x' }, { extra: 1 }])(
    '잘못된 요청 %j 는 422이고 RPC에 닿지 않는다', async (change) => {
      const { send, calls } = setup(rpc({ set_catalog_low_stock_threshold: PRODUCT_ROW }));
      expect((await send('PUT', path, { ...body, ...change })).statusCode).toBe(422);
      expect(calls).toHaveLength(0);
    });

  it('member 쓰기는 403, 충돌은 409, 다른 상품 응답은 503', async () => {
    const denied = setup(rpc({ set_catalog_low_stock_threshold: PRODUCT_ROW }), 'member');
    expect((await denied.send('PUT', path, body)).statusCode).toBe(403);
    expect(denied.calls).toHaveLength(0);
    expect((await setup(() => ({ status: 400, body: { code: 'P0001' } })).send('PUT', path, body)).statusCode).toBe(409);
    expect((await setup(rpc({ set_catalog_low_stock_threshold: { ...PRODUCT_ROW, id: OP } })).send('PUT', path, body)).statusCode).toBe(503);
  });

  it('상품 목록은 low_stock_threshold 가 있어도 없어도(구버전) 통과한다', async () => {
    const legacy = { ...PRODUCT_ROW } as Record<string, unknown>;
    delete legacy.low_stock_threshold;
    const rows = [PRODUCT_ROW, { ...PRODUCT_ROW, id: OP, sku: 'B', low_stock_threshold: null }, { ...legacy, id: CUSTOMER, sku: 'C' }];
    const response = await setup(rpc({ list_catalog_products: rows })).send('GET', 'catalog-products');
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body[0].low_stock_threshold).toBe(10);
    expect(body[1].low_stock_threshold).toBeNull();
    expect(body[2]).not.toHaveProperty('low_stock_threshold');
    expect((await setup(rpc({ list_catalog_products: [{ ...PRODUCT_ROW, low_stock_threshold: -3 }] })).send('GET', 'catalog-products')).statusCode).toBe(503);
  });
});

describe('WAL-10 지갑 목록·이력', () => {
  it('조직 지갑 목록은 member 도 읽고 조직 범위 RPC를 쓴다', async () => {
    const { send, calls } = setup(rpc({ list_organization_wallets: [ORG_WALLET] }), 'member');
    const response = await send('GET', 'wallets');
    expect(response.statusCode).toBe(200);
    expect(response.json()[0]).toMatchObject({ customer_name: '김고객', count_balance: 4, issued_count: 10 });
    expect(calls[0].url.pathname).toBe('/rest/v1/rpc/list_organization_wallets');
    expect(calls[0].body).toEqual({ p_organization_id: ORG });
  });

  it.each([
    ['다른 조직 행', [{ ...ORG_WALLET, organization_id: OTHER_ORG }]],
    ['중복 행', [ORG_WALLET, ORG_WALLET]],
    ['만료일이 시작일보다 빠름', [{ ...ORG_WALLET, expires_on: '2026-09-01' }]],
    ['음수 횟수', [{ ...ORG_WALLET, count_balance: -1 }]],
  ])('%s 은 503이다', async (_name, rows) => {
    expect((await setup(rpc({ list_organization_wallets: rows })).send('GET', 'wallets')).statusCode).toBe(503);
  });

  it('이력은 고객·지갑 범위로 조회하고 member 도 읽는다', async () => {
    const extend = { ...EVENT, id: CUSTOMER, event_type: 'extend', count_delta: 0, reason: '연장', visit_id: null, previous_expires_on: '2026-12-31', expires_on: '2027-01-07' };
    const { send, calls } = setup(rpc({ list_wallet_history: [EVENT, extend] }), 'member');
    const response = await send('GET', `customers/${CUSTOMER}/wallets/${WALLET}/history`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(2);
    expect(calls[0].body).toEqual({ p_organization_id: ORG, p_customer_id: CUSTOMER, p_wallet_id: WALLET });
  });

  it('알 수 없는 이벤트·중복·잘못된 경로는 거부한다', async () => {
    const path = `customers/${CUSTOMER}/wallets/${WALLET}/history`;
    expect((await setup(rpc({ list_wallet_history: [{ ...EVENT, event_type: 'steal' }] })).send('GET', path)).statusCode).toBe(503);
    expect((await setup(rpc({ list_wallet_history: [EVENT, EVENT] })).send('GET', path)).statusCode).toBe(503);
    expect((await setup(rpc({ list_wallet_history: [] })).send('GET', `customers/${CUSTOMER}/wallets/bad/history`)).statusCode).toBe(422);
    expect((await setup(() => ({ status: 400, body: { code: 'P0002' } })).send('GET', path)).statusCode).toBe(404);
  });

  it('기능이 없으면 403이다', async () => {
    const { send, calls } = setup(rpc({ list_organization_wallets: [] }), 'owner', ['crm.basic']);
    expect((await send('GET', 'wallets')).statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });
});
