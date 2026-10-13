import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiFailure } from '../../errors.js';
import { bearerToken } from '../../routes/organizations.js';
import type { CatalogGateway } from './gateway.js';

export type OrgAccess = Pick<{ requireAccess(token: string, id: string, feature: string, write?: boolean): Promise<string> }, 'requireAccess'>;

/** 원 단위 금액 문자열(Python PositiveMoney / NonnegativeMoney와 같은 패턴). 숫자 타입은 거부한다. */
const positiveMoney = z.string().regex(/^[1-9][0-9]{0,11}$/);
const nonnegativeMoney = z.string().regex(/^(0|[1-9][0-9]{0,11})$/);
/** 길이는 원문 기준으로 검사하고, 공백만 있는 값은 거부하며, 앞뒤 공백은 제거한다. */
const text = (max: number) => z.string().max(max).transform((value) => value.trim()).pipe(z.string().min(1));
const version = z.number().int().min(1);
const operationId = z.uuid();

const productShape = {
  operation_id: operationId,
  sku: text(80), name: text(200), kind: z.enum(['product', 'membership']),
  unit_name: text(30).default('개'),
  sale_price: positiveMoney,
  benefit_money: nonnegativeMoney.default('0'),
  benefit_count: z.number().int().min(0).max(999_999).default(0),
  valid_days: z.number().int().min(1).max(3650).nullable().default(null),
  is_active: z.boolean().default(true),
};
type ProductInput = { kind: 'product' | 'membership'; benefit_money: string; benefit_count: number; valid_days: number | null };
/** 실물 상품은 회원권 혜택·유효기간을 가질 수 없고, 회원권은 혜택(금액 또는 횟수)이 있어야 한다. */
function benefitsMatchKind(value: ProductInput, ctx: z.RefinementCtx) {
  const hasBenefit = Number(value.benefit_money) > 0 || value.benefit_count > 0;
  if (value.kind === 'product' && (hasBenefit || value.valid_days !== null)) ctx.addIssue({ code: 'custom', message: 'Physical products cannot grant membership benefits' });
  if (value.kind === 'membership' && !hasBenefit) ctx.addIssue({ code: 'custom', message: 'Membership benefits are required' });
}
const createProduct = z.object(productShape).strict().superRefine(benefitsMatchKind);
const updateProduct = z.object({ ...productShape, expected_version: version }).strict().superRefine(benefitsMatchKind);

const receiveStock = z.object({ operation_id: operationId, quantity: z.number().int().min(1).max(999_999), reason: text(1000) }).strict();
const stockAdjustment = z.object({
  operation_id: operationId, kind: z.enum(['supplier_return', 'disposal', 'stocktake']),
  quantity: z.number().int().min(0).max(1_000_000_000), reason: text(1000), expected_version: version,
}).strict().superRefine((value, ctx) => {
  if (value.kind !== 'stocktake' && value.quantity === 0) ctx.addIssue({ code: 'custom', message: 'Return and disposal quantities must be positive' });
  if (value.kind !== 'stocktake' && value.quantity > 999_999) ctx.addIssue({ code: 'custom', message: 'Return and disposal quantities cannot exceed 999999' });
});
/** 안전재고만 바꾸는 요청. null 이면 공통 기본값을 쓴다. */
const lowStock = z.object({
  operation_id: operationId, expected_version: version, low_stock_threshold: z.number().int().min(0).max(1_000_000_000).nullable(),
}).strict();
const addCatalog = z.object({ operation_id: operationId, expected_version: version, product_id: z.uuid() }).strict();
const useWallet = z.object({
  operation_id: operationId, wallet_id: z.uuid(), sale_line_id: z.uuid(), mode: z.enum(['money', 'count']),
  amount: positiveMoney.nullable().default(null), expected_cart_version: version, confirmed: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (!value.confirmed) ctx.addIssue({ code: 'custom', message: 'Wallet usage confirmation is required' });
  if ((value.mode === 'money') !== (value.amount !== null)) ctx.addIssue({ code: 'custom', message: 'Money usage requires an amount; count usage does not' });
});
const manageWallet = z.object({
  operation_id: operationId, expected_version: version, action: z.enum(['pause', 'resume', 'extend']),
  extend_days: z.number().int().min(1).max(3650).nullable().default(null), reason: text(1000),
}).strict().superRefine((value, ctx) => {
  if ((value.action === 'extend') !== (value.extend_days !== null)) ctx.addIssue({ code: 'custom', message: 'Extension days are required only for extension' });
});

const ids = (shape: Record<string, z.ZodType>) => z.object({ organizationId: z.uuid(), ...shape });

/**
 * 상품·회원권·재고·고객 회원권 라우트(Python api/catalog.py).
 * 읽기: crm.basic + finance.basic 기능과 조직 구성원(member 포함). 쓰기: owner/admin.
 */
export function registerCatalogRoutes(app: FastifyInstance, organizations: OrgAccess | undefined, gateway: CatalogGateway | undefined): void {
  const base = '/api/v1/organizations/:organizationId';
  function context(request: FastifyRequest, shape: Record<string, z.ZodType> = {}) {
    const token = bearerToken(request);
    const params = ids(shape).safeParse(request.params);
    if (!params.success) throw new ApiFailure(422, 'Invalid request path');
    if (!organizations || !gateway) throw new ApiFailure(503, 'Catalog service unavailable');
    return { token, gateway, params: params.data as Record<string, string> & { organizationId: string } };
  }
  function body<T>(schema: z.ZodType<T>, request: FastifyRequest): T {
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) throw new ApiFailure(422, 'Invalid catalog request');
    return parsed.data;
  }
  async function authorize(token: string, organizationId: string, write: boolean) {
    await organizations!.requireAccess(token, organizationId, 'crm.basic');
    await organizations!.requireAccess(token, organizationId, 'finance.basic', write);
  }
  const productValues = (input: z.infer<typeof createProduct>) => ({
    sku: input.sku, name: input.name, kind: input.kind, unit_name: input.unit_name, sale_price: input.sale_price,
    benefit_money: input.benefit_money, benefit_count: input.benefit_count, valid_days: input.valid_days, is_active: input.is_active,
  });

  app.get(`${base}/catalog-products`, async (request) => {
    const c = context(request);
    await authorize(c.token, c.params.organizationId, false);
    return c.gateway.listProducts(c.token, c.params.organizationId);
  });
  app.post(`${base}/catalog-products`, async (request, reply) => {
    const c = context(request);
    const input = body(createProduct, request);
    await authorize(c.token, c.params.organizationId, true);
    return reply.code(201).send(await c.gateway.saveProduct(c.token, c.params.organizationId, null, null, input.operation_id, productValues(input)));
  });
  app.get(`${base}/catalog-products/:productId/stock-ledger`, async (request) => {
    const c = context(request, { productId: z.uuid() });
    await authorize(c.token, c.params.organizationId, false);
    return c.gateway.listStockLedger(c.token, c.params.organizationId, c.params.productId);
  });
  app.put(`${base}/catalog-products/:productId`, async (request) => {
    const c = context(request, { productId: z.uuid() });
    const input = body(updateProduct, request);
    await authorize(c.token, c.params.organizationId, true);
    return c.gateway.saveProduct(c.token, c.params.organizationId, c.params.productId, input.expected_version, input.operation_id, productValues(input));
  });
  app.put(`${base}/catalog-products/:productId/low-stock`, async (request) => {
    const c = context(request, { productId: z.uuid() });
    const input = body(lowStock, request);
    await authorize(c.token, c.params.organizationId, true);
    return c.gateway.setLowStock(c.token, c.params.organizationId, c.params.productId, input.low_stock_threshold, input.expected_version, input.operation_id);
  });
  app.post(`${base}/catalog-products/:productId/stock-receipts`, async (request) => {
    const c = context(request, { productId: z.uuid() });
    const input = body(receiveStock, request);
    await authorize(c.token, c.params.organizationId, true);
    return c.gateway.receiveStock(c.token, c.params.organizationId, c.params.productId, input.quantity, input.reason, input.operation_id);
  });
  app.post(`${base}/catalog-products/:productId/stock-adjustments`, async (request) => {
    const c = context(request, { productId: z.uuid() });
    const input = body(stockAdjustment, request);
    await authorize(c.token, c.params.organizationId, true);
    return c.gateway.changeStock(c.token, c.params.organizationId, c.params.productId, input.kind, input.quantity, input.reason, input.expected_version, input.operation_id);
  });
  app.post(`${base}/visits/:visitId/sale-cart/lines/catalog-product`, async (request) => {
    const c = context(request, { visitId: z.uuid() });
    const input = body(addCatalog, request);
    await authorize(c.token, c.params.organizationId, true);
    return c.gateway.addProductToCart(c.token, c.params.organizationId, c.params.visitId, input.product_id, input.expected_version, input.operation_id);
  });
  app.get(`${base}/customers/:customerId/wallets`, async (request) => {
    const c = context(request, { customerId: z.uuid() });
    await authorize(c.token, c.params.organizationId, false);
    return c.gateway.listWallets(c.token, c.params.organizationId, c.params.customerId);
  });
  /** 조직 전체 지갑 목록(고객 이름·발급 혜택 포함). 회원권 화면용. */
  app.get(`${base}/wallets`, async (request) => {
    const c = context(request);
    await authorize(c.token, c.params.organizationId, false);
    return c.gateway.listOrganizationWallets(c.token, c.params.organizationId);
  });
  app.get(`${base}/customers/:customerId/wallets/:walletId/history`, async (request) => {
    const c = context(request, { customerId: z.uuid(), walletId: z.uuid() });
    await authorize(c.token, c.params.organizationId, false);
    return c.gateway.listWalletHistory(c.token, c.params.organizationId, c.params.customerId, c.params.walletId);
  });
  app.post(`${base}/customers/:customerId/wallets/:walletId/lifecycle`, async (request) => {
    const c = context(request, { customerId: z.uuid(), walletId: z.uuid() });
    const input = body(manageWallet, request);
    await authorize(c.token, c.params.organizationId, true);
    return c.gateway.manageWallet(c.token, c.params.organizationId, c.params.customerId, c.params.walletId, input.action, input.extend_days, input.reason, input.expected_version, input.operation_id);
  });
  app.post(`${base}/visits/:visitId/wallet-usages`, async (request) => {
    const c = context(request, { visitId: z.uuid() });
    const input = body(useWallet, request);
    await authorize(c.token, c.params.organizationId, true);
    return c.gateway.useWallet(c.token, c.params.organizationId, c.params.visitId, input.wallet_id, input.sale_line_id, input.mode, input.amount, input.expected_cart_version, input.operation_id, input.confirmed);
  });
}
