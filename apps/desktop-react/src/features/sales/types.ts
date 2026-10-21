import { z } from 'zod';

/** 금액은 서버가 문자열로 준다. 계산은 format.ts의 BigInt 도우미로만 한다. */
const money = z.string().regex(/^-?\d+(\.\d+)?$/);
const iso = z.string();

export const visitSchema = z.object({
  id: z.uuid(), organization_id: z.uuid(), customer_id: z.uuid(), appointment_id: z.uuid().nullable(),
  status: z.enum(['open', 'checkout_ready', 'closed', 'canceled']), opened_at: iso, closed_at: iso.nullable(), version: z.number().int(),
});
export type Visit = z.infer<typeof visitSchema>;
export const visitsSchema = z.array(visitSchema);

export const cartSchema = z.object({
  id: z.uuid(), organization_id: z.uuid(), visit_id: z.uuid(), customer_id: z.uuid(),
  status: z.enum(['draft', 'ready', 'void', 'collecting', 'paid']), version: z.number().int(),
  subtotal: money, discount_total: money, discount_kind: z.enum(['none', 'amount', 'percent']), discount_value: money,
  discount_reason: z.string(), total_amount: money,
});
export type Cart = z.infer<typeof cartSchema>;

export const lineSchema = z.object({
  id: z.uuid(), cart_id: z.uuid(), source_type: z.enum(['treatment_draft', 'product', 'membership']), source_id: z.uuid(),
  description_snapshot: z.string(), quantity: z.number().int(), returned_quantity: z.number().int(),
  unit_price: money, line_total: money, staff_id: z.uuid().nullable(), staff_name_snapshot: z.string(),
  status: z.enum(['active', 'removed']), removal_reason: z.string(),
  discount_share: money.optional(), returned_discount_amount: money.optional(), returned_refund_amount: money.optional(),
  commission_allocations: z.array(z.object({ staff_id: z.uuid(), staff_user_id: z.uuid().nullable(), staff_name: z.string(), share_basis_points: z.number().int().min(1).max(10000) })).default([]),
});
export type CartLine = z.infer<typeof lineSchema>;

export const bundleSchema = z.object({
  visit: visitSchema, cart: cartSchema, lines: z.array(lineSchema),
  discount_history: z.array(z.record(z.string(), z.unknown())).default([]),
});
export type CartBundle = z.infer<typeof bundleSchema>;

export const draftSchema = z.object({
  id: z.uuid(), customer_id: z.uuid(), treatment_id: z.uuid(), description: z.string(), amount: money, created_at: iso,
});
export type SaleDraft = z.infer<typeof draftSchema>;
export const draftsSchema = z.array(draftSchema);

export const catalogItemSchema = z.object({
  id: z.uuid(), name: z.string(), kind: z.string(), sale_price: z.union([z.string(), z.number()]), is_active: z.boolean().optional(),
  stock_quantity: z.number().optional(), unit_name: z.string().optional(),
});
export type CatalogItem = z.infer<typeof catalogItemSchema>;

export const receiptSchema = z.object({
  id: z.uuid(), method: z.enum(['cash', 'card', 'transfer', 'wallet']), amount: money, reference: z.string(), received_at: iso, operation_id: z.uuid(),
});
export const refundSchema = z.object({
  id: z.uuid(), source_id: z.uuid(), source_kind: z.enum(['receipt', 'wallet_usage']), amount: money, reason: z.string(), created_at: iso, operation_id: z.uuid(),
});
export const paymentsSchema = z.object({
  visit_id: z.uuid(), cart_id: z.uuid(), cart_version: z.number().int(), total_amount: money, paid_amount: money, outstanding_amount: money,
  refunded_amount: money, currency: z.literal('KRW'), status: z.enum(['draft', 'ready', 'collecting', 'paid', 'void']),
  receipts: z.array(receiptSchema), refunds: z.array(refundSchema),
});
export type VisitPayments = z.infer<typeof paymentsSchema>;

export const settlementSchema = z.object({
  organization_id: z.uuid(), business_date: z.string(),
  cash_received: money, cash_refunded: money, expected_cash: money, card_received: money, card_refunded: money, transfer_received: money, transfer_refunded: money,
  receipt_count: z.number().int(), refund_count: z.number().int(),
  receivables: z.array(z.object({ cart_id: z.uuid(), visit_id: z.uuid(), customer_id: z.uuid(), customer_name: z.string(), total_amount: money, received_amount: money, refunded_amount: money, due_amount: money })),
  is_closed: z.boolean(),
  close: z.object({
    id: z.uuid(), version: z.number().int(), expected_cash: money, counted_cash: money, variance: money, reason: z.string(), closed_at: iso,
    adjustments: z.array(z.object({ version: z.number().int(), previous_counted_cash: money, counted_cash: money, reason: z.string(), adjusted_at: iso })),
  }).nullable(),
});
export type Settlement = z.infer<typeof settlementSchema>;

export const transactionSchema = z.object({
  id: z.uuid(), organization_id: z.uuid(), transaction_type: z.enum(['income', 'expense']), amount: money, transaction_date: z.string(),
  category: z.string(), counterparty: z.string(), memo: z.string(), is_archived: z.boolean(),
});
export type Transaction = z.infer<typeof transactionSchema>;
export const transactionsSchema = z.array(transactionSchema);
export const financeSummarySchema = z.object({
  from_date: z.string().nullable(), to_date: z.string().nullable(), income_total: money, expense_total: money, net_total: money, transaction_count: z.number().int(),
});
export type FinanceSummary = z.infer<typeof financeSummarySchema>;

export const walletSchema = z.object({
  id: z.string(), customer_id: z.string().optional(), name_snapshot: z.string().optional(), money_balance: z.union([z.string(), z.number()]).optional(),
  count_balance: z.union([z.string(), z.number()]).optional(), expires_at: z.string().nullable().optional(), status: z.string().optional(),
});
export type Wallet = z.infer<typeof walletSchema>;

/* ---------- 매출 내역 검색(SALE-10) ---------- */
export const salePaymentSchema = z.object({
  id: z.uuid(), kind: z.enum(['payment', 'refund', 'return']), method: z.enum(['cash', 'card', 'transfer', 'wallet']), amount: money,
  occurred_at: iso, reference: z.string(), reason: z.string(), cart_id: z.uuid(), visit_id: z.uuid(), customer_id: z.uuid(), customer_name: z.string(),
});
export type SalePayment = z.infer<typeof salePaymentSchema>;
export const salePaymentsSchema = z.object({
  rows: z.array(salePaymentSchema),
  next_cursor: z.string().nullable(),
  totals: z.object({
    payment_total: money, refund_total: money, net_total: money,
    payment_count: z.number().int(), refund_count: z.number().int(), row_count: z.number().int(),
  }),
});
export type SalePaymentsPage = z.infer<typeof salePaymentsSchema>;

/* ---------- 전체 미수금(HOME-02) ---------- */
export const receivablesSchema = z.object({
  receivable_count: z.number().int(), total_due: money,
  items: z.array(z.object({
    cart_id: z.uuid(), visit_id: z.uuid(), customer_id: z.uuid(), customer_name: z.string(), opened_at: iso,
    total_amount: money, received_amount: money, refunded_amount: money, due_amount: money,
  })),
});
export type Receivables = z.infer<typeof receivablesSchema>;

/* ---------- 재무 월 마감(FIN-10) ---------- */
export const monthClosingSchema = z.object({
  id: z.uuid(), organization_id: z.uuid(), month: z.string(), note: z.string(), closed_by: z.uuid(), closed_at: iso,
  reopened_by: z.uuid().nullable(), reopened_at: iso.nullable(), reopen_reason: z.string().nullable(),
});
export type MonthClosing = z.infer<typeof monthClosingSchema>;
export const monthClosingsSchema = z.array(monthClosingSchema);
