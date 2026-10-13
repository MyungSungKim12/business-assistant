import { z } from 'zod';
import type { ServerConfig } from '../../config.js';
import { ApiFailure } from '../../errors.js';
import { createRest } from '../../supabase/rest.js';
import { withPgErrorMap } from './pgErrors.js';

const UNAVAILABLE = 'Catalog service unavailable';

/** 원 단위 정수 금액. PostgREST가 숫자나 문자열로 줄 수 있어 둘 다 받고 정수 문자열로 통일한다(NaN·소수·음수 거부). */
const WHOLE_MONEY = /^\d{1,15}(\.0+)?$/;
export const wholeMoney = z.union([z.string(), z.number()])
  .refine((value) => WHOLE_MONEY.test(String(value).trim()), 'Invalid money')
  .transform((value) => String(value).trim().split('.')[0]);
const SIGNED_DECIMAL = /^-?\d{1,15}(\.\d+)?$/;
export const signedDecimal = z.union([z.string(), z.number()])
  .refine((value) => SIGNED_DECIMAL.test(String(value).trim()), 'Invalid amount')
  .transform((value) => String(value).trim());

export const productSchema = z.object({
  id: z.uuid(), organization_id: z.uuid(), sku: z.string(), name: z.string(),
  kind: z.enum(['product', 'membership']), unit_name: z.string(),
  sale_price: wholeMoney, benefit_money: wholeMoney, benefit_count: z.number().int().min(0),
  valid_days: z.number().int().min(1).max(3650).nullable(), is_active: z.boolean(),
  version: z.number().int().min(1), stock_quantity: z.number().int().min(0),
});
export type CatalogProduct = z.infer<typeof productSchema>;

export const stockMovementSchema = z.object({
  id: z.uuid(), organization_id: z.uuid(), product_id: z.uuid(),
  movement_kind: z.enum(['receipt', 'sale', 'refund', 'customer_return', 'supplier_return', 'disposal', 'stocktake']),
  quantity: z.number().int().refine((value) => value !== 0, 'Stock movement quantity cannot be zero'),
  reason: z.string(), created_by: z.uuid(), created_at: z.string(),
});
export type StockMovement = z.infer<typeof stockMovementSchema>;

const walletUsageSchema = z.object({
  id: z.uuid(), visit_id: z.uuid(), sale_line_id: z.uuid(), mode: z.enum(['money', 'count']),
  money_delta: signedDecimal.refine((value) => Number(value) <= 0, 'money_delta must not be positive'),
  count_delta: z.number().int().min(-1).max(0),
  applied_amount: signedDecimal.refine((value) => Number(value) > 0, 'applied_amount must be positive'),
  created_at: z.string(),
});
export const walletSchema = z.object({
  id: z.uuid(), organization_id: z.uuid(), customer_id: z.uuid(), product_id: z.uuid(), sale_line_id: z.uuid(),
  name_snapshot: z.string(), money_balance: wholeMoney, count_balance: z.number().int().min(0),
  valid_from: z.iso.date(), expires_on: z.iso.date().nullable(), source_snapshot: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  lifecycle_status: z.enum(['active', 'paused']).default('active'),
  paused_on: z.iso.date().nullable().default(null),
  lifecycle_version: z.number().int().min(1).default(1),
  usage_history: z.array(walletUsageSchema).default([]),
});
export type CustomerWallet = z.infer<typeof walletSchema>;

/** 장바구니·수납 결과는 매출 모듈이 소유한다. 여기서는 식별자 일치만 확인하고 나머지 필드는 그대로 전달한다. */
const cartBundleSchema = z.looseObject({
  visit: z.looseObject({ id: z.uuid(), organization_id: z.uuid(), customer_id: z.uuid() }),
  cart: z.looseObject({ id: z.uuid(), organization_id: z.uuid(), visit_id: z.uuid(), customer_id: z.uuid() }),
  lines: z.array(z.looseObject({ organization_id: z.uuid(), cart_id: z.uuid() })),
});
const visitPaymentsSchema = z.looseObject({ visit_id: z.uuid() });
export type CartBundle = z.infer<typeof cartBundleSchema>;
export type VisitPayments = z.infer<typeof visitPaymentsSchema>;

export type ProductValues = {
  sku: string; name: string; kind: 'product' | 'membership'; unit_name: string; sale_price: string; benefit_money: string;
  benefit_count: number; valid_days: number | null; is_active: boolean;
};

export function createCatalogGateway(config: ServerConfig, fetcher: typeof fetch = fetch) {
  const rest = createRest(config, withPgErrorMap(fetcher), UNAVAILABLE);
  const fail = () => new ApiFailure(503, UNAVAILABLE);
  const call = <T>(token: string, name: string, organizationId: string, args: Record<string, unknown>, schema: z.ZodType<T>) =>
    rest.rpc(token, name, { p_organization_id: organizationId, ...args }, schema);
  const unique = (rows: { id: string }[]) => { if (new Set(rows.map((row) => row.id)).size !== rows.length) throw fail(); };
  const product = (row: CatalogProduct, organizationId: string, productId?: string) => {
    if (row.organization_id !== organizationId || (productId !== undefined && row.id !== productId)) throw fail();
    return row;
  };

  return {
    async listProducts(token: string, organizationId: string) {
      const rows = await call(token, 'list_catalog_products', organizationId, {}, z.array(productSchema));
      rows.forEach((row) => product(row, organizationId));
      unique(rows);
      return rows;
    },
    async saveProduct(token: string, organizationId: string, productId: string | null, expectedVersion: number | null, operationId: string, values: ProductValues) {
      const row = await call(token, 'save_catalog_product', organizationId, { p_product_id: productId, p_expected_version: expectedVersion, p_operation_id: operationId, p_values: values }, productSchema);
      return product(row, organizationId, productId ?? undefined);
    },
    async receiveStock(token: string, organizationId: string, productId: string, quantity: number, reason: string, operationId: string) {
      const row = await call(token, 'receive_catalog_stock', organizationId, { p_product_id: productId, p_quantity: quantity, p_reason: reason, p_operation_id: operationId }, productSchema);
      return product(row, organizationId, productId);
    },
    async changeStock(token: string, organizationId: string, productId: string, kind: string, quantity: number, reason: string, expectedVersion: number, operationId: string) {
      const row = await call(token, 'change_catalog_stock', organizationId, { p_product_id: productId, p_kind: kind, p_quantity: quantity, p_reason: reason, p_expected_version: expectedVersion, p_operation_id: operationId }, productSchema);
      return product(row, organizationId, productId);
    },
    async listStockLedger(token: string, organizationId: string, productId: string) {
      const rows = await call(token, 'list_catalog_stock_ledger', organizationId, { p_product_id: productId }, z.array(stockMovementSchema));
      unique(rows);
      if (rows.some((row) => row.organization_id !== organizationId || row.product_id !== productId)) throw fail();
      return rows;
    },
    async addProductToCart(token: string, organizationId: string, visitId: string, productId: string, expectedVersion: number, operationId: string) {
      const bundle = await call(token, 'add_catalog_product_to_cart', organizationId, { p_visit_id: visitId, p_product_id: productId, p_expected_version: expectedVersion, p_operation_id: operationId }, cartBundleSchema);
      if (bundle.visit.organization_id !== organizationId || bundle.visit.id !== visitId || bundle.cart.organization_id !== organizationId
        || bundle.cart.visit_id !== visitId || bundle.cart.customer_id !== bundle.visit.customer_id
        || bundle.lines.some((line) => line.organization_id !== organizationId || line.cart_id !== bundle.cart.id)) throw fail();
      return bundle;
    },
    async listWallets(token: string, organizationId: string, customerId: string) {
      const rows = await call(token, 'list_customer_wallets', organizationId, { p_customer_id: customerId }, z.array(walletSchema));
      unique(rows);
      if (rows.some((row) => row.organization_id !== organizationId || row.customer_id !== customerId || (row.expires_on !== null && row.expires_on < row.valid_from))) throw fail();
      return rows;
    },
    async manageWallet(token: string, organizationId: string, customerId: string, walletId: string, action: string, extendDays: number | null, reason: string, expectedVersion: number, operationId: string) {
      const row = await call(token, 'manage_customer_wallet', organizationId, { p_customer_id: customerId, p_wallet_id: walletId, p_action: action, p_extend_days: extendDays, p_reason: reason, p_expected_version: expectedVersion, p_operation_id: operationId }, walletSchema);
      if (row.organization_id !== organizationId || row.customer_id !== customerId || row.id !== walletId) throw fail();
      return row;
    },
    async useWallet(token: string, organizationId: string, visitId: string, walletId: string, saleLineId: string, mode: string, amount: string | null, expectedCartVersion: number, operationId: string, confirmed: boolean) {
      const result = await call(token, 'use_customer_wallet', organizationId, { p_visit_id: visitId, p_wallet_id: walletId, p_sale_line_id: saleLineId, p_mode: mode, p_amount: amount, p_expected_cart_version: expectedCartVersion, p_operation_id: operationId, p_confirmed: confirmed }, visitPaymentsSchema);
      if (result.visit_id !== visitId) throw fail();
      return result;
    },
  };
}
export type CatalogGateway = ReturnType<typeof createCatalogGateway>;
