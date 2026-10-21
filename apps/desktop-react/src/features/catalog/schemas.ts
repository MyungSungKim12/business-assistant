import { z } from 'zod';

/** 금액은 서버가 정수 문자열로 준다. 숫자도 받아 문자열로 통일한다. */
const money = z.union([z.string(), z.number()]).transform(String);

export const productSchema = z.object({
  id: z.string(), organization_id: z.string(), sku: z.string(), name: z.string(), kind: z.enum(['product', 'membership']), unit_name: z.string(),
  purchase_unit_name: z.string().default('개'), units_per_purchase_unit: z.number().int().positive().default(1),
  sale_price: money, benefit_money: money, benefit_count: z.number(), valid_days: z.number().nullable(), is_active: z.boolean(),
  version: z.number(), stock_quantity: z.number(),
  category:z.string().default('기타'), barcode:z.string().nullable().default(null),
  image_file_id:z.string().nullable().default(null),
  /** 상품별 안전재고(null=공통 기본값). 서버가 041 적용 전이면 필드가 없다. */
  low_stock_threshold: z.number().nullable().optional(),
});
export const productsSchema = z.array(productSchema);
export const supplierSchema=z.object({id:z.string(),organization_id:z.string(),name:z.string(),contact_name:z.string(),phone:z.string(),email:z.string(),note:z.string(),is_active:z.boolean(),version:z.number(),created_by:z.string(),created_at:z.string(),updated_at:z.string()});
export const suppliersSchema=z.array(supplierSchema);
export const purchaseLineSchema=z.object({id:z.string(),organization_id:z.string(),order_id:z.string(),product_id:z.string(),quantity_ordered:z.number(),quantity_received:z.number(),unit_cost:money,purchase_unit_name_snapshot:z.string().default('개'),units_per_purchase_unit:z.number().int().positive().default(1),note:z.string(),created_at:z.string()});
export const purchaseOrderSchema=z.object({id:z.string(),organization_id:z.string(),supplier_id:z.string(),status:z.enum(['draft','ordered','received','canceled']),ordered_at:z.string().nullable(),note:z.string(),version:z.number(),created_by:z.string(),created_at:z.string(),updated_at:z.string(),lines:z.array(purchaseLineSchema).default([])});
export const purchaseOrdersSchema=z.array(purchaseOrderSchema);
export const inventoryLotsSchema=z.array(z.object({id:z.string(),organization_id:z.string(),product_id:z.string(),lot_code:z.string(),received_quantity:z.number(),remaining_quantity:z.number(),expires_on:z.string().nullable(),unit_cost:money.nullable(),received_at:z.string(),alert_status:z.enum(['expired','expiring_soon','ok'])}));
export type InventoryLot=z.infer<typeof inventoryLotsSchema>[number];
export const inventoryLotAlertsSchema=inventoryLotsSchema.element.extend({product_name:z.string().min(1)}).array();
export type InventoryLotAlert=z.infer<typeof inventoryLotAlertsSchema>[number];
export type CatalogProduct = z.infer<typeof productSchema>;

export const movementSchema = z.object({
  id: z.string(), organization_id: z.string(), product_id: z.string(),
  movement_kind: z.enum(['receipt', 'purchase_order_receipt', 'sale', 'refund', 'customer_return', 'supplier_return', 'disposal', 'stocktake', 'treatment_use','adjustment']),
  quantity: z.number(), reason: z.string(), created_by: z.string(), created_at: z.string(),
});
export const movementsSchema = z.array(movementSchema);
export type StockMovement = z.infer<typeof movementSchema>;

export const walletUsageSchema = z.object({
  id: z.string(), visit_id: z.string(), sale_line_id: z.string(), mode: z.enum(['money', 'count']),
  money_delta: money, count_delta: z.number(), applied_amount: money, created_at: z.string(),
});
export const walletSchema = z.object({
  id: z.string(), organization_id: z.string(), customer_id: z.string(), product_id: z.string(), sale_line_id: z.string(), name_snapshot: z.string(),
  money_balance: money, count_balance: z.number(), valid_from: z.string(), expires_on: z.string().nullable(),
  lifecycle_status: z.enum(['active', 'paused', 'refunded']).default('active'), lifecycle_version: z.number().default(1), owner_version: z.number().default(1), usage_history: z.array(walletUsageSchema).default([]),
});
export const walletsSchema = z.array(walletSchema);
export type CustomerWallet = z.infer<typeof walletSchema>;

/** 조직 전체 지갑 목록의 한 행(고객 이름·발급 혜택 포함). 회원권 화면용. */
export const orgWalletSchema = z.object({
  id: z.string(), organization_id: z.string(), customer_id: z.string(), customer_name: z.string(), product_id: z.string(), name_snapshot: z.string(),
  money_balance: money, count_balance: z.number(), issued_money: money, issued_count: z.number(),
  valid_from: z.string(), expires_on: z.string().nullable(), lifecycle_status: z.enum(['active', 'paused', 'refunded']).default('active'),
  paused_on: z.string().nullable().default(null), lifecycle_version: z.number().default(1), created_at: z.string(),
});
export const orgWalletsSchema = z.array(orgWalletSchema);
export type OrganizationWallet = z.infer<typeof orgWalletSchema>;

export const walletEventTypeSchema = z.enum(['issue', 'use', 'use_refund', 'reversal', 'pause', 'resume', 'extend', 'transfer', 'refund']);
export const walletHistoryEventSchema = z.object({
  id: z.string(), event_type: walletEventTypeSchema, occurred_at: z.string(), money_delta: money, count_delta: z.number(),
  reason: z.string().nullable(), visit_id: z.string().nullable(), previous_expires_on: z.string().nullable(), expires_on: z.string().nullable(), from_customer_id: z.string().optional(), to_customer_id: z.string().optional(),
});
export const walletHistorySchema = z.array(walletHistoryEventSchema);
export type WalletHistoryEvent = z.infer<typeof walletHistoryEventSchema>;
export const walletEventLabel: Record<WalletHistoryEvent['event_type'], string> = {
  issue: '발급', use: '사용', use_refund: '사용 취소', reversal: '구매 취소', pause: '정지', resume: '재개', extend: '기간 연장', transfer: '양도', refund: '환불',
};
export const walletRefundPreviewSchema=z.object({organization_id:z.string(),customer_id:z.string(),wallet_id:z.string(),refund_cap:money,money_balance:money,count_balance:z.number(),balance_version:z.number(),purchase_amount:money,currency:z.literal('KRW')});
export const walletRefundResultSchema=z.object({organization_id:z.string(),customer_id:z.string(),wallet_id:z.string(),amount:money,money_removed:money,count_removed:z.number(),previous_balance:money,new_balance:money,previous_count_balance:z.number(),new_count_balance:z.number(),balance_version:z.number(),transaction_date:z.string(),finance_transaction_id:z.string(),reason:z.string(),lifecycle_status:z.enum(['active','paused','refunded']),created_by:z.string()});
export type WalletRefundPreview=z.infer<typeof walletRefundPreviewSchema>;
export type WalletRefundResult=z.infer<typeof walletRefundResultSchema>;

/** 장바구니·수납 결과는 매출 화면이 소유한다. 여기서는 사용하는 필드만 읽고 나머지는 통과시킨다. */
export const cartBundleSchema = z.looseObject({ visit: z.looseObject({ id: z.string() }), cart: z.looseObject({ id: z.string(), version: z.number() }), lines: z.array(z.looseObject({ id: z.string() })) });
export const walletUseResultSchema = z.looseObject({ visit_id: z.string(), cart_version: z.number().optional(), outstanding_amount: z.union([z.string(), z.number()]).optional() });
export type CartBundle = z.infer<typeof cartBundleSchema>;
export type WalletUseResult = z.infer<typeof walletUseResultSchema>;

export const movementLabel: Record<StockMovement['movement_kind'], string> = {
  receipt: '입고', purchase_order_receipt: '발주 입고', sale: '판매 출고', refund: '환불 복원', customer_return: '고객 상품 반품', supplier_return: '거래처 반품', disposal: '폐기', stocktake: '실사 조정', treatment_use: '시술 소모', adjustment: '재고 조정',
};

export const won = (value: unknown): string => {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toLocaleString('ko-KR')}원` : '금액 확인 필요';
};
