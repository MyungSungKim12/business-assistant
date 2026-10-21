import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { registerCatalogModule } from './index.js';
import { auth, buildApp, fakeFetch, fakeOrganizations, OP, ORG, OTHER_ORG, testConfig, type FakeCall, type FakeReply, type Role } from './testkit.js';

const PRODUCT = '1a9c39fd-8e8c-4df8-a623-1f23a3a936bd';
const VISIT = '2a9c39fd-8e8c-4df8-a623-1f23a3a936bd';
const CUSTOMER = '3a9c39fd-8e8c-4df8-a623-1f23a3a936bd';
const WALLET = '4a9c39fd-8e8c-4df8-a623-1f23a3a936bd';
const LINE = '5a9c39fd-8e8c-4df8-a623-1f23a3a936bd';
const VALUES = { sku: 'SKU-1', name: '보습 크림', kind: 'product', unit_name: '개', purchase_unit_name: '개', units_per_purchase_unit: 1, sale_price: '30000', benefit_money: '0', benefit_count: 0, valid_days: null, is_active: true };
const ROW = { id: PRODUCT, organization_id: ORG, ...VALUES, version: 1, stock_quantity: 0, category:'기타', barcode:null, image_file_id:null };
const WALLET_ROW = { id: WALLET, organization_id: ORG, customer_id: CUSTOMER, product_id: PRODUCT, sale_line_id: LINE, name_snapshot: '회원권', money_balance: '100', count_balance: 1, valid_from: '2026-10-01', expires_on: '2026-12-31', source_snapshot: {}, created_at: '2026-10-01T00:00:00Z', lifecycle_status: 'paused', paused_on: '2026-10-08', lifecycle_version: 2 };
const BUNDLE = { visit: { id: VISIT, organization_id: ORG, customer_id: CUSTOMER, status: 'open' }, cart: { id: '6a9c39fd-8e8c-4df8-a623-1f23a3a936bd', organization_id: ORG, visit_id: VISIT, customer_id: CUSTOMER, version: 3 }, lines: [] };
const PAYMENTS = { visit_id: VISIT, outstanding_amount: '0', payments: [] };

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

function setup(reply: (call: FakeCall) => FakeReply, role: Role = 'owner', features = ['crm.basic', 'finance.basic']) {
  const { fetcher, calls } = fakeFetch(reply);
  const organizations = fakeOrganizations(role, features);
  app = buildApp((instance) => registerCatalogModule(instance, organizations, testConfig, fetcher));
  const send = (method: 'GET' | 'POST' | 'PUT', path: string, payload?: unknown) => app.inject({ method, url: `/api/v1/organizations/${ORG}/${path}`, headers: auth, payload: payload as never });
  return { send, calls, organizations };
}
const rpcName = (call: FakeCall) => call.url.pathname.split('/').pop();
const byRpc = (map: Record<string, unknown>) => (call: FakeCall): FakeReply => ({ body: map[rpcName(call) ?? ''] ?? null });
const createBody = (change: Record<string, unknown> = {}) => ({ ...VALUES, operation_id: OP, ...change });

describe('카탈로그 생성·수정', () => {
  it('상품 카테고리·바코드를 버전/멱등 키와 함께 조직 RPC에 저장한다', async () => {
    const updated={...ROW,category:'스킨케어',barcode:'8801234567890',version:2};
    const {send,calls}=setup(byRpc({set_catalog_product_metadata:updated}));
    const body={category:'스킨케어',barcode:'8801234567890',expected_version:1,operation_id:OP};
    expect((await send('PUT',`catalog-products/${PRODUCT}/metadata`,body)).statusCode).toBe(200);
    expect(calls[0].body).toEqual({p_organization_id:ORG,p_product_id:PRODUCT,p_category:'스킨케어',p_barcode:'8801234567890',p_expected_version:1,p_operation_id:OP});
    expect((await setup(byRpc({set_catalog_product_metadata:updated}),'member').send('PUT',`catalog-products/${PRODUCT}/metadata`,body)).statusCode).toBe(403);
    expect((await send('PUT',`catalog-products/${PRODUCT}/metadata`,{...body,barcode:'x'.repeat(81)})).statusCode).toBe(422);
  });
  it('상품 이미지는 관리자만 조직 RPC에 버전과 멱등 키를 전달해 연결한다',async()=>{
    const image='7a9c39fd-8e8c-4df8-a623-1f23a3a936bd',updated={...ROW,image_file_id:image,version:2};
    const {send,calls}=setup(byRpc({set_catalog_product_image:updated}));
    const body={image_file_id:image,expected_version:1,operation_id:OP};
    expect((await send('PUT',`catalog-products/${PRODUCT}/image`,body)).statusCode).toBe(200);
    expect(calls[0].body).toEqual({p_organization_id:ORG,p_product_id:PRODUCT,p_image_file_id:image,p_expected_version:1,p_operation_id:OP});
    expect((await setup(byRpc({set_catalog_product_image:updated}),'member').send('PUT',`catalog-products/${PRODUCT}/image`,body)).statusCode).toBe(403);
    expect((await send('PUT',`catalog-products/${PRODUCT}/image`,{...body,image_file_id:'bad'})).statusCode).toBe(422);
  });
  it('공급처 등록과 발주 초안 생성을 관리자만 조직 RPC로 수행한다', async () => {
    const supplier={id:WALLET,organization_id:ORG,name:'공급처A',contact_name:'',phone:'',email:'',note:'',is_active:true,version:1,created_by:CUSTOMER,created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-01T00:00:00Z'};
    const order={id:VISIT,organization_id:ORG,supplier_id:WALLET,status:'draft',ordered_at:null,note:'',version:1,created_by:CUSTOMER,created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-01T00:00:00Z',lines:[{id:LINE,organization_id:ORG,order_id:VISIT,product_id:PRODUCT,quantity_ordered:3,quantity_received:0,unit_cost:'1200',note:'',created_at:'2026-10-01T00:00:00Z'}]};
    const {send,calls}=setup(byRpc({create_catalog_supplier:supplier,create_catalog_purchase_order:order}));
    const s=await send('POST','catalog-suppliers',{name:'공급처A'});expect(s.statusCode).toBe(201);
    const body={supplier_id:WALLET,operation_id:OP,note:'',lines:[{product_id:PRODUCT,quantity_ordered:3,unit_cost:'1200',note:''}]};
    const po=await send('POST','catalog-purchase-orders',body);expect(po.statusCode).toBe(201);expect(calls.at(-1)?.url.pathname).toBe('/rest/v1/rpc/create_catalog_purchase_order');expect(calls.at(-1)?.body).toMatchObject({p_organization_id:ORG,p_supplier_id:WALLET,p_operation_id:OP});
    expect((await setup(byRpc({create_catalog_purchase_order:order}),'member').send('POST','catalog-purchase-orders',body)).statusCode).toBe(403);
    expect((await setup(byRpc({create_catalog_purchase_order:order})).send('POST','catalog-purchase-orders',{...body,lines:[]})).statusCode).toBe(422);
  });
  it('생성 시 조직·멱등 키·값을 RPC로 넘기고 201을 돌려준다', async () => {
    const { send, calls } = setup(byRpc({ save_catalog_product: ROW }));
    const response = await send('POST', 'catalog-products', createBody());
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(ROW);
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe('/rest/v1/rpc/save_catalog_product');
    expect(calls[0].headers.Authorization).toBe('Bearer user-token');
    expect(calls[0].body).toEqual({ p_organization_id: ORG, p_product_id: null, p_expected_version: null, p_operation_id: OP, p_values: VALUES });
  });

  it('수정 시 expected_version을 넘긴다', async () => {
    const { send, calls } = setup(byRpc({ save_catalog_product: ROW }));
    const response = await send('PUT', `catalog-products/${PRODUCT}`, createBody({ expected_version: 1 }));
    expect(response.statusCode).toBe(200);
    expect(calls[0].body).toEqual({ p_organization_id: ORG, p_product_id: PRODUCT, p_expected_version: 1, p_operation_id: OP, p_values: VALUES });
  });

  it('member는 읽기만 되고 쓰기와 기능 누락은 403이며 RPC에 닿지 않는다', async () => {
    expect((await setup(byRpc({ list_catalog_products: [ROW] }), 'member').send('GET', 'catalog-products')).statusCode).toBe(200);
    for (const [role, features] of [['member', undefined], ['owner', []], ['owner', ['finance.basic']], ['owner', ['crm.basic']]] as const) {
      const { send, calls } = setup(byRpc({ save_catalog_product: ROW }), role, features as string[] | undefined);
      expect((await send('POST', 'catalog-products', createBody())).statusCode).toBe(403);
      expect(calls).toHaveLength(0);
    }
  });

  it('쓰기는 owner/admin 권한(write=true)을 finance.basic으로 요구한다', async () => {
    const { send, organizations } = setup(byRpc({ save_catalog_product: ROW }), 'admin');
    await send('POST', 'catalog-products', createBody());
    expect(organizations.calls).toEqual([{ feature: 'crm.basic', write: false }, { feature: 'finance.basic', write: true }]);
  });

  it.each([
    ['sale_price', '1.5'], ['sale_price', 100], ['sale_price', 'NaN'], ['sale_price', '-1'], ['sale_price', '0'],
    ['name', '  '], ['sku', ' '], ['is_active', 'true'], ['benefit_count', true], ['valid_days', 0], ['benefit_money', '1'], ['unexpected', true],
  ])('잘못된 %s=%j 는 422이고 RPC에 닿지 않는다', async (field, value) => {
    const { send, calls } = setup(byRpc({ save_catalog_product: ROW }));
    expect((await send('POST', 'catalog-products', createBody({ [field]: value }))).statusCode).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it('회원권은 혜택이 필요하고 금액·횟수 조합을 허용한다', async () => {
    const { send } = setup(byRpc({ save_catalog_product: ROW }));
    expect((await send('POST', 'catalog-products', createBody({ kind: 'membership' }))).statusCode).toBe(422);
    expect((await send('POST', 'catalog-products', createBody({ kind: 'membership', benefit_money: '50000', benefit_count: 3, valid_days: 90 }))).statusCode).toBe(201);
  });

  it('값의 앞뒤 공백을 제거한 뒤 전달한다', async () => {
    const { send, calls } = setup(byRpc({ save_catalog_product: ROW }));
    await send('POST', 'catalog-products', createBody({ sku: ' SKU-1 ', name: ' 보습 크림 ' }));
    expect((calls[0].body as { p_values: unknown }).p_values).toEqual(VALUES);
  });

  it('충돌(P0001)은 409, 없음(P0002)은 404, 권한(42501)은 403, 검증(22023)은 422로 매핑한다', async () => {
    for (const [code, status] of [['P0001', 409], ['23505', 409], ['P0002', 404], ['42501', 403], ['22023', 422], ['23514', 422], ['22P02', 422]] as const) {
      const { send } = setup(() => ({ status: 400, body: { code, message: 'secret internal detail' } }));
      const response = await send('POST', 'catalog-products', createBody());
      expect(response.statusCode).toBe(status);
      expect(response.body).not.toContain('secret');
    }
    expect((await setup(() => ({ status: 500, body: { message: 'boom' } })).send('POST', 'catalog-products', createBody())).statusCode).toBe(503);
  });
});

describe('카탈로그 조회 응답 검증', () => {
  it('목록은 조직 범위 RPC를 쓰고 금액을 정수 문자열로 정규화한다', async () => {
    const { send, calls } = setup(byRpc({ list_catalog_products: [{ ...ROW, sale_price: 30000 }] }));
    const response = await send('GET', 'catalog-products');
    expect(response.json()[0].sale_price).toBe('30000');
    expect(calls[0].url.pathname).toBe('/rest/v1/rpc/list_catalog_products');
    expect(calls[0].body).toEqual({ p_organization_id: ORG });
  });

  it.each([
    ['다른 조직 행', (row: Record<string, unknown>) => [{ ...row, organization_id: OTHER_ORG }]],
    ['중복 행', (row: Record<string, unknown>) => [row, row]],
    ['음수 재고', (row: Record<string, unknown>) => [{ ...row, stock_quantity: -1 }]],
    ['NaN 가격', (row: Record<string, unknown>) => [{ ...row, sale_price: 'NaN' }]],
    ['배열이 아닌 응답', () => ({})],
  ])('%s 응답은 원문 없이 503이다', async (_name, make) => {
    const { send } = setup(byRpc({ list_catalog_products: make(ROW) }));
    const response = await send('GET', 'catalog-products');
    expect(response.statusCode).toBe(503);
    expect(response.json().detail).toBe('Catalog service unavailable');
  });

  it('저장 응답의 상품 ID가 다르면 닫힌 실패(503)로 처리한다', async () => {
    const { send } = setup(byRpc({ save_catalog_product: { ...ROW, id: OP } }));
    expect((await send('PUT', `catalog-products/${PRODUCT}`, createBody({ expected_version: 1 }))).statusCode).toBe(503);
  });
});

describe('재고', () => {
  it('입고는 수량·사유를 검증하고 member 쓰기를 거부한다', async () => {
    const path = `catalog-products/${PRODUCT}/stock-receipts`;
    const body = { operation_id: OP, quantity: 3, reason: '신규 입고', expires_on: '2026-12-31', lot_code:'LOT-1', unit_cost:'1200' };
    const { send, calls } = setup(byRpc({ receive_catalog_stock: ROW }));
    expect((await send('POST', path, body)).statusCode).toBe(200);
    expect(calls[0].body).toEqual({ p_organization_id: ORG, p_product_id: PRODUCT, p_quantity: 3, p_reason: '신규 입고', p_operation_id: OP, p_expires_on:'2026-12-31', p_lot_code:'LOT-1', p_unit_cost:'1200' });
    expect((await setup(byRpc({ receive_catalog_stock: ROW }), 'member').send('POST', path, body)).statusCode).toBe(403);
    for (const change of [{ quantity: 0 }, { quantity: true }, { reason: ' ' }, { quantity: 1_000_000 },{expires_on:'2026-13-40'},{lot_code:'x'.repeat(121)},{unit_cost:'-1'},{unit_cost:'1000000000000'}]) {
      expect((await send('POST', path, { ...body, ...change })).statusCode).toBe(422);
    }
    expect(calls).toHaveLength(1);
  });

  it('로트와 유통기한 알림은 member가 상품 범위로 조회한다', async () => {
    const lot={id:OP,organization_id:ORG,product_id:PRODUCT,lot_code:'A',received_quantity:4,remaining_quantity:3,expires_on:'2026-11-01',unit_cost:'1200',received_at:'2026-10-20T00:00:00Z',alert_status:'expiring_soon'};
    const {send,calls}=setup(byRpc({list_catalog_inventory_lots:[lot]}),'member');
    expect((await send('GET',`catalog-products/${PRODUCT}/lots`)).json()).toEqual([lot]);
    const preciseLot={...lot,unit_cost:'333.333333'};
    expect((await setup(byRpc({list_catalog_inventory_lots:[preciseLot]}),'member').send('GET',`catalog-products/${PRODUCT}/lots`)).json()).toEqual([preciseLot]);
    expect(calls[0].url.pathname).toBe('/rest/v1/rpc/list_catalog_inventory_lots');
    for(const bad of [{...lot,organization_id:OTHER_ORG},{...lot,product_id:OTHER_ORG}]) expect((await setup(byRpc({list_catalog_inventory_lots:[bad]}),'member').send('GET',`catalog-products/${PRODUCT}/lots`)).statusCode).toBe(503);
  });

  it('조직 전체의 만료 임박 로트를 한 번에 조회하고 다른 조직 응답을 거부한다',async()=>{
    const alert={id:OP,organization_id:ORG,product_id:PRODUCT,product_name:'보습 크림',lot_code:'LOT-A',received_quantity:4,remaining_quantity:3,expires_on:'2026-11-01',unit_cost:'1200.000000',received_at:'2026-10-20T00:00:00Z',alert_status:'expiring_soon'};
    const {send,calls}=setup(byRpc({list_catalog_inventory_lot_alerts:[alert]}),'member');
    expect((await send('GET','catalog-inventory-lot-alerts?within_days=30')).json()).toEqual([alert]);
    expect(calls[0].url.pathname).toBe('/rest/v1/rpc/list_catalog_inventory_lot_alerts');
    expect(calls[0].body).toEqual({p_organization_id:ORG,p_expiring_within_days:30,p_limit:200,p_offset:0});
    expect((await send('GET','catalog-inventory-lot-alerts?within_days=30&offset=200&limit=100')).statusCode).toBe(200);
    expect(calls[1].body).toEqual({p_organization_id:ORG,p_expiring_within_days:30,p_limit:100,p_offset:200});
    expect((await setup(byRpc({list_catalog_inventory_lot_alerts:[{...alert,organization_id:OTHER_ORG}]}),'member').send('GET','catalog-inventory-lot-alerts?within_days=30')).statusCode).toBe(503);
    expect((await send('GET','catalog-inventory-lot-alerts?within_days=366')).statusCode).toBe(422);
    expect((await send('GET','catalog-inventory-lot-alerts?offset=5001')).statusCode).toBe(422);
    expect((await send('GET','catalog-inventory-lot-alerts?limit=201')).statusCode).toBe(422);
  });

  it('재고 조정은 expected_version이 필수이고 관리자만 쓴다', async () => {
    const path = `catalog-products/${PRODUCT}/stock-adjustments`;
    const body = { operation_id: OP, kind: 'supplier_return', quantity: 2, reason: '거래처 반품', expected_version: 4 };
    const { send, calls } = setup(byRpc({ change_catalog_stock: ROW }));
    expect((await send('POST', path, body)).statusCode).toBe(200);
    expect(calls[0].body).toEqual({ p_organization_id: ORG, p_product_id: PRODUCT, p_kind: 'supplier_return', p_quantity: 2, p_reason: '거래처 반품', p_expected_version: 4, p_operation_id: OP });
    expect((await setup(byRpc({ change_catalog_stock: ROW }), 'member').send('POST', path, body)).statusCode).toBe(403);
    for (const change of [{ kind: 'unknown' }, { quantity: 0 }, { quantity: true }, { expected_version: 0 }, { expected_version: true }, { reason: ' ' }]) {
      expect((await send('POST', path, { ...body, ...change })).statusCode).toBe(422);
    }
    expect(calls).toHaveLength(1);
  });

  it('실사(stocktake)만 0 수량을 허용하고 반품·폐기는 1..999999다', async () => {
    const path = `catalog-products/${PRODUCT}/stock-adjustments`;
    const base = { operation_id: OP, quantity: 0, reason: '실사', expected_version: 4 };
    const { send, calls } = setup(byRpc({ change_catalog_stock: ROW }));
    expect((await send('POST', path, { ...base, kind: 'stocktake' })).statusCode).toBe(200);
    expect((calls[0].body as { p_kind: string; p_quantity: number }).p_quantity).toBe(0);
    expect((await send('POST', path, { ...base, kind: 'disposal' })).statusCode).toBe(422);
    expect((await send('POST', path, { ...base, kind: 'disposal', quantity: 1_000_000 })).statusCode).toBe(422);
    expect(calls).toHaveLength(1);
  });

  it('재고 이력은 member가 읽고 상품 범위로 조회한다', async () => {
    const { send, calls } = setup(byRpc({ list_catalog_stock_ledger: [] }), 'member');
    const response = await send('GET', `catalog-products/${PRODUCT}/stock-ledger`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
    expect(calls[0].body).toEqual({ p_organization_id: ORG, p_product_id: PRODUCT });
  });

  it('재고 이력의 다른 조직 행은 거부하고 정상 행은 반품 수량을 검증한다', async () => {
    const movement = { id: OP, organization_id: ORG, product_id: PRODUCT, movement_kind: 'supplier_return', quantity: -2, reason: '거래처 반품', created_by: CUSTOMER, created_at: '2026-10-08T00:00:00Z' };
    const ok = await setup(byRpc({ list_catalog_stock_ledger: [movement] })).send('GET', `catalog-products/${PRODUCT}/stock-ledger`);
    expect(ok.json()[0]).toMatchObject({ quantity: -2, movement_kind: 'supplier_return' });
    for (const bad of [{ ...movement, organization_id: OTHER_ORG }, { ...movement, quantity: 0 }, { ...movement, product_id: OTHER_ORG }]) {
      expect((await setup(byRpc({ list_catalog_stock_ledger: [bad] })).send('GET', `catalog-products/${PRODUCT}/stock-ledger`)).statusCode).toBe(503);
    }
  });
});

describe('장바구니 상품 담기', () => {
  const path = `visits/${VISIT}/sale-cart/lines/catalog-product`;
  const body = { product_id: PRODUCT, expected_version: 2, operation_id: OP };
  it('버전과 관리자 권한을 요구하고 RPC 인자를 그대로 넘긴다', async () => {
    const { send, calls } = setup(byRpc({ add_catalog_product_to_cart: BUNDLE }));
    const response = await send('POST', path, body);
    expect(response.statusCode).toBe(200);
    expect(response.json().cart.version).toBe(3);
    expect(calls[0].body).toEqual({ p_organization_id: ORG, p_visit_id: VISIT, p_product_id: PRODUCT, p_expected_version: 2, p_operation_id: OP });
    const denied = setup(byRpc({ add_catalog_product_to_cart: BUNDLE }), 'member');
    expect((await denied.send('POST', path, body)).statusCode).toBe(403);
    expect(denied.calls).toHaveLength(0);
    for (const version of [null, true, 0, '1']) expect((await send('POST', path, { ...body, expected_version: version })).statusCode).toBe(422);
    expect(calls).toHaveLength(1);
  });
  it('다른 방문·조직의 장바구니 응답은 503으로 막는다', async () => {
    const wrongVisit = { ...BUNDLE, visit: { ...BUNDLE.visit, id: OP } };
    const wrongLine = { ...BUNDLE, lines: [{ organization_id: OTHER_ORG, cart_id: BUNDLE.cart.id }] };
    for (const bad of [wrongVisit, wrongLine]) expect((await setup(byRpc({ add_catalog_product_to_cart: bad })).send('POST', path, body)).statusCode).toBe(503);
  });
});

describe('고객 회원권', () => {
  it('목록은 member가 읽고 고객 범위로 조회한다', async () => {
    const { send, calls } = setup(byRpc({ list_customer_wallets: [] }), 'member');
    expect((await send('GET', `customers/${CUSTOMER}/wallets`)).statusCode).toBe(200);
    expect(calls[0].body).toEqual({ p_organization_id: ORG, p_customer_id: CUSTOMER });
  });
  it('목록 응답에서 기본값을 채우고 만료일이 시작일보다 빠르면 거부한다', async () => {
    const minimal = { ...WALLET_ROW } as Record<string, unknown>;
    delete minimal.lifecycle_status; delete minimal.paused_on; delete minimal.lifecycle_version;
    const ok = await setup(byRpc({ list_customer_wallets: [minimal] })).send('GET', `customers/${CUSTOMER}/wallets`);
    expect(ok.json()[0]).toMatchObject({ lifecycle_status: 'active', paused_on: null, lifecycle_version: 1, usage_history: [] });
    const bad = { ...WALLET_ROW, expires_on: '2026-09-01' };
    expect((await setup(byRpc({ list_customer_wallets: [bad] })).send('GET', `customers/${CUSTOMER}/wallets`)).statusCode).toBe(503);
  });
  it('수명주기 변경은 관리자·사유·버전을 요구한다', async () => {
    const path = `customers/${CUSTOMER}/wallets/${WALLET}/lifecycle`;
    const body = { action: 'pause', reason: '고객 요청', expected_version: 1, operation_id: OP };
    const { send, calls } = setup(byRpc({ manage_customer_wallet: WALLET_ROW }));
    const response = await send('POST', path, body);
    expect(response.statusCode).toBe(200);
    expect(response.json().lifecycle_status).toBe('paused');
    expect(calls[0].body).toEqual({ p_organization_id: ORG, p_customer_id: CUSTOMER, p_wallet_id: WALLET, p_action: 'pause', p_extend_days: null, p_reason: '고객 요청', p_expected_version: 1, p_operation_id: OP });
    expect((await setup(byRpc({ manage_customer_wallet: WALLET_ROW }), 'member').send('POST', path, body)).statusCode).toBe(403);
    for (const change of [{ reason: ' ' }, { expected_version: 0 }, { expected_version: true }, { extend_days: 7 }, { action: 'extend', extend_days: null }]) {
      expect((await send('POST', path, { ...body, ...change })).statusCode).toBe(422);
    }
    expect((await setup(byRpc({ manage_customer_wallet: { ...WALLET_ROW, organization_id: OTHER_ORG } })).send('POST', path, body)).statusCode).toBe(503);
  });
  it('회원권 양도는 관리자만 허용하고 새 소유자와 버전을 확인한다', async () => {
    const target = '7a9c39fd-8e8c-4df8-a623-1f23a3a936bd';
    const path = `customers/${CUSTOMER}/wallets/${WALLET}/transfer`;
    const body = { to_customer_id: target, expected_owner_version: 1, reason: '양도 요청', operation_id: OP };
    const { send, calls } = setup(byRpc({ transfer_customer_wallet: { ...WALLET_ROW, customer_id: target, owner_version: 2 } }));
    const response = await send('POST', path, body);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ customer_id: target, owner_version: 2 });
    expect(calls[0].body).toEqual({ p_organization_id: ORG, p_from_customer_id: CUSTOMER, p_to_customer_id: target, p_wallet_id: WALLET, p_expected_owner_version: 1, p_reason: '양도 요청', p_operation_id: OP });
    expect((await setup(byRpc({ transfer_customer_wallet: WALLET_ROW }), 'member').send('POST', path, body)).statusCode).toBe(403);
    expect((await setup(byRpc({ transfer_customer_wallet: { ...WALLET_ROW, customer_id: OTHER_ORG } })).send('POST', path, body)).statusCode).toBe(503);
  });
  it('금액권 환불 한도는 관리자만 확인하고 환불 기록은 확인·사유·잔액 버전을 요구한다',async()=>{
    const previewPath=`customers/${CUSTOMER}/wallets/${WALLET}/refund-preview`;
    const preview={organization_id:ORG,customer_id:CUSTOMER,wallet_id:WALLET,refund_cap:'100',money_balance:'100',count_balance:3,balance_version:2,purchase_amount:'100',currency:'KRW'};
    const previewSetup=setup(byRpc({preview_wallet_purchase_refund_benefits:preview}));
    expect((await previewSetup.send('GET',previewPath)).statusCode).toBe(200);
    expect(previewSetup.calls[0].body).toEqual({p_organization_id:ORG,p_customer_id:CUSTOMER,p_wallet_id:WALLET});
    expect((await setup(byRpc({preview_wallet_purchase_refund_benefits:preview}),'member').send('GET',previewPath)).statusCode).toBe(403);
    const result={organization_id:ORG,customer_id:CUSTOMER,wallet_id:WALLET,amount:'25',money_removed:'10',count_removed:1,previous_balance:'100',new_balance:'90',previous_count_balance:3,new_count_balance:2,balance_version:3,transaction_date:'2026-10-20',finance_transaction_id:LINE,reason:'환불 요청',lifecycle_status:'active',created_by:CUSTOMER};
    const path=`customers/${CUSTOMER}/wallets/${WALLET}/refunds`;
    const body={operation_id:OP,cash_refund_amount:'25',remove_money_amount:'10',remove_count_amount:1,expected_balance_version:2,reason:'환불 요청',confirmed:true};
    const {send,calls}=setup(byRpc({refund_wallet_purchase_benefits:result}));
    expect((await send('POST',path,body)).statusCode).toBe(200);
    expect(calls[0].body).toEqual({p_organization_id:ORG,p_customer_id:CUSTOMER,p_wallet_id:WALLET,p_cash_refund_amount:'25',p_remove_money_amount:'10',p_remove_count_amount:1,p_reason:'환불 요청',p_expected_balance_version:2,p_operation_id:OP,p_confirmed:true});
    expect((await setup(byRpc({refund_wallet_purchase_benefits:result}),'member').send('POST',path,body)).statusCode).toBe(403);
    for(const change of [{cash_refund_amount:'0'},{cash_refund_amount:25},{remove_money_amount:'-1'},{remove_count_amount:-1},{remove_money_amount:'0',remove_count_amount:0},{reason:' '},{expected_balance_version:0},{confirmed:false}]) expect((await send('POST',path,{...body,...change})).statusCode).toBe(422);
    expect((await setup(byRpc({refund_wallet_purchase:{...result,wallet_id:OTHER_ORG}})).send('POST',path,body)).statusCode).toBe(503);
  });
  it('충돌은 409로 돌려준다', async () => {
    const { send } = setup(() => ({ status: 400, body: { code: 'P0001' } }));
    expect((await send('POST', `customers/${CUSTOMER}/wallets/${WALLET}/lifecycle`, { action: 'pause', reason: '요청', expected_version: 1, operation_id: OP })).statusCode).toBe(409);
  });
  it('사용 내역을 검증해 그대로 돌려준다', async () => {
    const usage = { id: OP, visit_id: VISIT, sale_line_id: LINE, mode: 'money', money_delta: -5000, count_delta: 0, applied_amount: 5000, created_at: '2026-10-08T00:00:00Z' };
    const ok = await setup(byRpc({ list_customer_wallets: [{ ...WALLET_ROW, usage_history: [usage] }] })).send('GET', `customers/${CUSTOMER}/wallets`);
    expect(ok.json()[0].usage_history[0]).toMatchObject({ money_delta: '-5000', applied_amount: '5000' });
    const bad = await setup(byRpc({ list_customer_wallets: [{ ...WALLET_ROW, usage_history: [{ ...usage, money_delta: 5 }] }] })).send('GET', `customers/${CUSTOMER}/wallets`);
    expect(bad.statusCode).toBe(503);
  });
});

describe('회원권 사용', () => {
  const path = `visits/${VISIT}/wallet-usages`;
  const body = { wallet_id: WALLET, sale_line_id: LINE, mode: 'money', amount: '30000', expected_cart_version: 3, operation_id: OP, confirmed: true };
  it('엄격한 입력을 원자적 RPC로 전달하고 관리자만 허용한다', async () => {
    const { send, calls } = setup(byRpc({ use_customer_wallet: PAYMENTS }));
    expect((await send('POST', path, body)).statusCode).toBe(200);
    expect(calls[0].body).toEqual({ p_organization_id: ORG, p_visit_id: VISIT, p_wallet_id: WALLET, p_sale_line_id: LINE, p_mode: 'money', p_amount: '30000', p_expected_cart_version: 3, p_operation_id: OP, p_confirmed: true });
    const count = await send('POST', path, { ...body, mode: 'count', amount: null });
    expect(count.statusCode).toBe(200);
    expect((calls[1].body as { p_amount: unknown }).p_amount).toBeNull();
    const denied = setup(byRpc({ use_customer_wallet: PAYMENTS }), 'member');
    expect((await denied.send('POST', path, body)).statusCode).toBe(403);
    expect(denied.calls).toHaveLength(0);
  });
  it.each([
    { amount: '0' }, { amount: 1 }, { confirmed: false }, { expected_cart_version: true }, { mode: 'count', amount: '1' }, { mode: 'money', amount: null },
  ])('잘못된 사용 요청 %j 는 422', async (change) => {
    const { send, calls } = setup(byRpc({ use_customer_wallet: PAYMENTS }));
    expect((await send('POST', path, { ...body, ...change })).statusCode).toBe(422);
    expect(calls).toHaveLength(0);
  });
  it('다른 방문의 결과는 503으로 막는다', async () => {
    expect((await setup(byRpc({ use_customer_wallet: { ...PAYMENTS, visit_id: OP } })).send('POST', path, body)).statusCode).toBe(503);
  });
});

describe('인증·경로', () => {
  it('토큰이 없으면 401, 조직 ID가 잘못되면 422', async () => {
    const { send } = setup(byRpc({}));
    expect((await app.inject({ method: 'GET', url: `/api/v1/organizations/${ORG}/catalog-products` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/organizations/not-a-uuid/catalog-products', headers: auth })).statusCode).toBe(422);
    expect((await send('GET', 'catalog-products/not-a-uuid/stock-ledger')).statusCode).toBe(422);
  });
});
