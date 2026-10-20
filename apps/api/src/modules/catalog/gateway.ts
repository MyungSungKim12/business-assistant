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
  /** 상품별 안전재고. null 이면 화면의 공통 기본값을 쓰고, 041 적용 전 서버 응답에는 없을 수 있다. */
  low_stock_threshold: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
});
export type CatalogProduct = z.infer<typeof productSchema>;
export const supplierSchema=z.object({id:z.uuid(),organization_id:z.uuid(),name:z.string(),contact_name:z.string(),phone:z.string(),email:z.string(),note:z.string(),is_active:z.boolean(),version:z.number().int(),created_by:z.uuid(),created_at:z.string(),updated_at:z.string()});
export const purchaseLineSchema=z.object({id:z.uuid(),organization_id:z.uuid(),order_id:z.uuid(),product_id:z.uuid(),quantity_ordered:z.number().int(),quantity_received:z.number().int(),unit_cost:wholeMoney,note:z.string(),created_at:z.string()});
export const purchaseOrderSchema=z.object({id:z.uuid(),organization_id:z.uuid(),supplier_id:z.uuid(),status:z.enum(['draft','ordered','received','canceled']),ordered_at:z.string().nullable(),note:z.string(),version:z.number().int(),created_by:z.uuid(),created_at:z.string(),updated_at:z.string()});
export const purchaseOrderBundleSchema=purchaseOrderSchema.extend({lines:z.array(purchaseLineSchema)});

export const stockMovementSchema = z.object({
  id: z.uuid(), organization_id: z.uuid(), product_id: z.uuid(),
  movement_kind: z.enum(['receipt', 'purchase_order_receipt', 'sale', 'refund', 'customer_return', 'supplier_return', 'disposal', 'stocktake','treatment_use','adjustment']),
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

/** 조직 전체 지갑 목록의 한 행(고객 이름과 발급 혜택 포함). */
export const organizationWalletSchema = z.object({
  id: z.uuid(), organization_id: z.uuid(), customer_id: z.uuid(), customer_name: z.string(), product_id: z.uuid(), name_snapshot: z.string(),
  money_balance: wholeMoney, count_balance: z.number().int().min(0), issued_money: wholeMoney, issued_count: z.number().int().min(0),
  valid_from: z.iso.date(), expires_on: z.iso.date().nullable(), lifecycle_status: z.enum(['active', 'paused']),
  paused_on: z.iso.date().nullable(), lifecycle_version: z.number().int().min(1), created_at: z.string(),
});
export type OrganizationWallet = z.infer<typeof organizationWalletSchema>;

/** 지갑 잔액 변동 이력의 한 줄(발급·사용·사용 취소·구매 취소·정지·재개·연장). */
export const walletHistoryEventSchema = z.object({
  id: z.uuid(), event_type: z.enum(['issue', 'use', 'use_refund', 'reversal', 'pause', 'resume', 'extend']), occurred_at: z.string(),
  money_delta: signedDecimal, count_delta: z.number().int(), reason: z.string().nullable(), visit_id: z.uuid().nullable(),
  previous_expires_on: z.iso.date().nullable(), expires_on: z.iso.date().nullable(),
});
export type WalletHistoryEvent = z.infer<typeof walletHistoryEventSchema>;

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
    async listSuppliers(token:string,organizationId:string){const rows=await rest.selectAll(token,'catalog_suppliers',{organization_id:`eq.${organizationId}`,order:'name.asc,id.asc'},supplierSchema);if(rows.some(r=>r.organization_id!==organizationId))throw fail();return rows;},
    async createSupplier(token:string,organizationId:string,input:{name:string;contact_name:string;phone:string;email:string;note:string;is_active:boolean}){const row=await call(token,'create_catalog_supplier',organizationId,{p_values:input},supplierSchema);if(row.organization_id!==organizationId)throw fail();return row;},
    async listPurchaseOrders(token: string, organizationId: string) {
      const [orders, lines] = await Promise.all([
        rest.selectAll(token, 'catalog_purchase_orders', { organization_id: `eq.${organizationId}`, order: 'created_at.desc,id.desc' }, purchaseOrderSchema),
        rest.selectAll(token, 'catalog_purchase_order_lines', { organization_id: `eq.${organizationId}`, order: 'created_at.asc,id.asc' }, purchaseLineSchema),
      ]);
      if (orders.some(row => row.organization_id !== organizationId) || lines.some(row => row.organization_id !== organizationId)) throw fail();
      const byOrder = new Map(orders.map(order => [order.id, { ...order, lines: [] as z.infer<typeof purchaseLineSchema>[] }]));
      for (const line of lines) {
        const order = byOrder.get(line.order_id);
        if (!order) throw fail();
        order.lines.push(line);
      }
      return [...byOrder.values()];
    },
    async createPurchaseOrder(token:string,organizationId:string,input:{supplier_id:string;operation_id:string;note:string;lines:Array<{product_id:string;quantity_ordered:number;unit_cost:string;note:string}>}){const result=await call(token,'create_catalog_purchase_order',organizationId,{p_supplier_id:input.supplier_id,p_operation_id:input.operation_id,p_note:input.note,p_lines:input.lines},purchaseOrderBundleSchema);if(result.organization_id!==organizationId)throw fail();return result;},
    async updatePurchaseOrder(token:string,organizationId:string,orderId:string,input:{status:'ordered'|'canceled';expected_version:number}){const saved=await call(token,'update_catalog_purchase_order',organizationId,{p_order_id:orderId,p_status:input.status,p_expected_version:input.expected_version},purchaseOrderSchema);if(saved.organization_id!==organizationId)throw fail();return saved;},
    async receivePurchaseOrderLine(token:string,organizationId:string,orderId:string,lineId:string,input:{quantity:number;operation_id:string}){return rest.rpc(token,'receive_catalog_purchase_order_line',{p_organization_id:organizationId,p_order_id:orderId,p_line_id:lineId,p_quantity:input.quantity,p_operation_id:input.operation_id},z.object({receipt_id:z.uuid(),order_id:z.uuid(),line_id:z.uuid(),quantity:z.number().int(),replayed:z.boolean()}));},
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
    async setLowStock(token: string, organizationId: string, productId: string, threshold: number | null, expectedVersion: number, operationId: string) {
      const row = await call(token, 'set_catalog_low_stock_threshold', organizationId, { p_product_id: productId, p_threshold: threshold, p_expected_version: expectedVersion, p_operation_id: operationId }, productSchema);
      return product(row, organizationId, productId);
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
    async listOrganizationWallets(token: string, organizationId: string) {
      const rows = await call(token, 'list_organization_wallets', organizationId, {}, z.array(organizationWalletSchema));
      unique(rows);
      if (rows.some((row) => row.organization_id !== organizationId || (row.expires_on !== null && row.expires_on < row.valid_from))) throw fail();
      return rows;
    },
    async listWalletHistory(token: string, organizationId: string, customerId: string, walletId: string) {
      const rows = await call(token, 'list_wallet_history', organizationId, { p_customer_id: customerId, p_wallet_id: walletId }, z.array(walletHistoryEventSchema));
      unique(rows);
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
