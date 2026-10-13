import { z } from 'zod';
import { fixedMoney, toCents, wonMoney, type MoneyInput } from './money.js';

/* ---------- 응답 스키마(Supabase → API). 금액은 항상 문자열로 정규화한다. ---------- */

type Rule = 'any' | 'ge0' | 'gt0';
function money(format: (value: MoneyInput) => string, rule: Rule = 'any', whole = false) {
  return z.union([z.string(), z.number()]).transform((value, ctx) => {
    try {
      const cents = toCents(value);
      if ((rule === 'ge0' && cents < 0n) || (rule === 'gt0' && cents <= 0n) || (whole && cents % 100n !== 0n)) throw new Error('range');
      return format(value);
    } catch {
      ctx.issues.push({ code: 'custom', message: 'Invalid amount', input: value });
      return z.NEVER;
    }
  });
}
const cartMoney = money(fixedMoney, 'ge0');
const won = (rule: Rule = 'ge0') => money(wonMoney, rule);

export const customerVisit = z.object({
  id: z.uuid(), organization_id: z.uuid(), customer_id: z.uuid(), appointment_id: z.uuid().nullable(),
  status: z.enum(['open', 'checkout_ready', 'closed', 'canceled']), opened_at: z.string(), closed_at: z.string().nullable(), version: z.number().int(),
});
export type CustomerVisit = z.infer<typeof customerVisit>;

const saleCart = z.object({
  id: z.uuid(), organization_id: z.uuid(), visit_id: z.uuid(), customer_id: z.uuid(),
  status: z.enum(['draft', 'ready', 'void', 'collecting', 'paid']), version: z.number().int(),
  subtotal: cartMoney, discount_total: cartMoney,
  discount_kind: z.enum(['none', 'amount', 'percent']).default('none'),
  discount_value: money(wonMoney, 'ge0').default('0'),
  discount_reason: z.string().default(''),
  discount_applied_by: z.uuid().nullable().default(null),
  discount_applied_at: z.string().nullable().default(null),
  total_amount: cartMoney,
});

const saleCartLine = z.object({
  id: z.uuid(), organization_id: z.uuid(), cart_id: z.uuid(),
  source_type: z.enum(['treatment_draft', 'product', 'membership']), source_id: z.uuid(),
  description_snapshot: z.string(), quantity: z.number().int(), returned_quantity: z.number().int().min(0).default(0),
  unit_price: money(fixedMoney), line_total: money(fixedMoney),
  // 반품 한도 계산에 쓰는 선택 값(RPC가 주는 경우에만 전달)
  discount_share: money(wonMoney, 'ge0').optional(),
  returned_discount_amount: money(wonMoney, 'ge0').optional(),
  returned_refund_amount: money(wonMoney, 'ge0').optional(),
  staff_id: z.uuid().nullable(), staff_name_snapshot: z.string(), source_snapshot: z.record(z.string(), z.unknown()),
  status: z.enum(['active', 'removed']), removal_reason: z.string(), created_at: z.string(), removed_at: z.string().nullable(),
});

export const saleCartBundle = z.object({
  visit: customerVisit, cart: saleCart, lines: z.array(saleCartLine),
  discount_history: z.array(z.record(z.string(), z.unknown())).default([]),
});
export type SaleCartBundle = z.infer<typeof saleCartBundle>;

export const treatmentSaleDraft = z.object({
  id: z.uuid(), organization_id: z.uuid(), customer_id: z.uuid(), treatment_id: z.uuid(), status: z.literal('draft'),
  description: z.string(), amount: money(fixedMoney), source_snapshot: z.record(z.string(), z.unknown()),
  created_by: z.uuid(), created_at: z.string(),
});
export type TreatmentSaleDraft = z.infer<typeof treatmentSaleDraft>;

const receipt = z.object({
  id: z.uuid(), method: z.enum(['cash', 'card', 'transfer', 'wallet']), amount: won('gt0'), reference: z.string(),
  received_at: z.string(), operation_id: z.uuid(),
});
const refund = z.object({
  id: z.uuid(), source_id: z.uuid(), source_kind: z.enum(['receipt', 'wallet_usage']), amount: won('gt0'), reason: z.string(),
  created_at: z.string(), operation_id: z.uuid(),
});
export const visitPayments = z.object({
  visit_id: z.uuid(), cart_id: z.uuid(), cart_version: z.number().int().min(1),
  total_amount: won(), paid_amount: won(), outstanding_amount: won(), refunded_amount: won().default('0'),
  currency: z.literal('KRW'), status: z.enum(['draft', 'ready', 'collecting', 'paid', 'void']),
  receipts: z.array(receipt), refunds: z.array(refund).default([]),
}).superRefine((value, ctx) => {
  const sum = (items: Array<{ amount: string }>) => items.reduce((total, item) => total + toCents(item.amount), 0n);
  const gross = sum(value.receipts);
  const refunded = sum(value.refunds);
  if (toCents(value.paid_amount) + toCents(value.outstanding_amount) !== toCents(value.total_amount)) ctx.addIssue({ code: 'custom', message: 'Receipt balance mismatch' });
  if (refunded !== toCents(value.refunded_amount) || gross - refunded !== toCents(value.paid_amount)) ctx.addIssue({ code: 'custom', message: 'Receipt sum mismatch' });
});
export type VisitPayments = z.infer<typeof visitPayments>;

const wholeWon = money(wonMoney, 'ge0', true);
const adjustment = z.object({
  version: z.number().int(), previous_counted_cash: wholeWon, counted_cash: wholeWon, reason: z.string(), adjusted_by: z.uuid(), adjusted_at: z.string(),
});
const dailyClose = z.object({
  id: z.uuid(), version: z.number().int(), expected_cash: wholeWon, counted_cash: wholeWon, variance: won('any'),
  reason: z.string(), closed_by: z.uuid(), closed_at: z.string(), adjustments: z.array(adjustment),
});
export const saleDailySettlement = z.object({
  organization_id: z.uuid(), business_date: z.iso.date(),
  cash_received: wholeWon, cash_refunded: wholeWon, expected_cash: won('any'),
  card_received: wholeWon, card_refunded: wholeWon, transfer_received: wholeWon, transfer_refunded: wholeWon,
  receipt_count: z.number().int(), refund_count: z.number().int(),
  receivables: z.array(z.object({
    cart_id: z.uuid(), visit_id: z.uuid(), customer_id: z.uuid(), customer_name: z.string(),
    total_amount: wholeWon, received_amount: wholeWon, refunded_amount: wholeWon, due_amount: wholeWon,
  })),
  is_closed: z.boolean(), close: dailyClose.nullable(),
});
export type SaleDailySettlement = z.infer<typeof saleDailySettlement>;

export const financeRow = z.object({
  id: z.uuid(), organization_id: z.uuid(), created_by: z.uuid(), transaction_type: z.enum(['income', 'expense']),
  amount: money(fixedMoney), transaction_date: z.iso.date(), category: z.string(), counterparty: z.string(), memo: z.string(),
  is_archived: z.boolean(), created_at: z.string(), updated_at: z.string(),
});
export type FinanceTransaction = z.infer<typeof financeRow>;

/* ---------- 요청 스키마(클라이언트 → API). Python pydantic 규칙과 같다. ---------- */

const uuid = z.uuid();
export const operationId = uuid;
const expectedVersion = z.number().int().min(1);
const moneyText = z.string().regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/);
const wholeMoney = z.string().regex(/^(0|[1-9][0-9]{0,11})$/);
const positiveWon = z.string().regex(/^[1-9][0-9]{0,11}$/);
const trueOnly = z.literal(true);
const reasonText = z.string().min(1).max(1000).refine((value) => value.trim().length > 0).transform((value) => value.trim());

export const operationRequest = z.object({ operation_id: operationId }).strict();
export const versionedRequest = operationRequest.extend({ expected_version: expectedVersion }).strict();
export const addDraftRequest = versionedRequest.extend({ draft_id: uuid }).strict();
export const updateLineRequest = z.object({
  operation_id: operationId, expected_version: expectedVersion,
  quantity: z.number().int().min(1).max(999).optional(),
  unit_price: moneyText.optional(),
  staff_id: uuid.nullable().optional(),
  staff_name: z.string().max(200).optional(),
}).strict().refine((value) => ['quantity', 'unit_price', 'staff_id', 'staff_name'].some((key) => key in value));
export const removeLineRequest = versionedRequest.extend({ reason: reasonText }).strict();
export const reviewRequest = versionedRequest.extend({ ready: z.boolean() }).strict();
export const discountRequest = versionedRequest.extend({
  kind: z.enum(['none', 'amount', 'percent']), value: wholeMoney, reason: reasonText, confirmed: trueOnly,
}).strict().refine((value) => value.kind === 'none' ? value.value === '0' : value.kind === 'amount' ? value.value !== '0' : Number(value.value) >= 1 && Number(value.value) <= 99);

const paymentPart = z.object({
  method: z.enum(['cash', 'card', 'transfer']), amount: positiveWon, reference: z.string().max(200).default(''),
}).strict().transform((part) => ({ ...part, reference: part.reference.trim() })).refine((part) => part.method === 'cash' || part.reference.length > 0);
export const recordPaymentRequest = versionedRequest.extend({
  payments: z.array(paymentPart).min(1).max(3), confirmed: trueOnly,
}).strict().refine((value) => new Set(value.payments.map((part) => part.method)).size === value.payments.length);
export const refundRequest = versionedRequest.extend({ source_id: uuid, amount: positiveWon, reason: reasonText, confirmed: trueOnly }).strict();
export const productReturnRequest = versionedRequest.extend({
  sale_line_id: uuid, receipt_id: uuid, quantity: z.number().int().min(1).max(999), restock: z.boolean(),
  amount: positiveWon, reason: reasonText, confirmed: trueOnly,
}).strict();

export const closeRequest = z.object({ operation_id: operationId, counted_cash: wholeMoney, reason: reasonText, confirmed: trueOnly }).strict();
export const adjustRequest = closeRequest.extend({ expected_version: expectedVersion }).strict();

const decimalInput = z.union([z.string(), z.number()]).transform((value) => typeof value === 'number' ? String(value) : value.trim())
  .refine((text) => /^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(text) && toCents(text) > 0n && toCents(text) < 1_000_000_000_000n * 100n);
const categoryText = z.string().transform((value) => value.trim()).refine((value) => value.length >= 1 && value.length <= 200);
const freeText = z.string().max(5000);
export const financeCreateRequest = z.object({
  transaction_type: z.enum(['income', 'expense']), amount: decimalInput, transaction_date: z.iso.date(),
  category: categoryText, counterparty: freeText.default(''), memo: freeText.default(''), is_archived: z.boolean().default(false),
}).strict();
export const financeUpdateRequest = z.object({
  transaction_type: z.enum(['income', 'expense']).optional(), amount: decimalInput.optional(), transaction_date: z.iso.date().optional(),
  category: categoryText.optional(), counterparty: freeText.optional(), memo: freeText.optional(), is_archived: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0);
export const financeFilter = z.object({
  from_date: z.iso.date().optional(), to_date: z.iso.date().optional(), transaction_type: z.enum(['income', 'expense']).optional(),
}).refine((value) => !value.from_date || !value.to_date || value.from_date <= value.to_date);
export const financeSummaryFilter = z.object({ from_date: z.iso.date().optional(), to_date: z.iso.date().optional() })
  .refine((value) => !value.from_date || !value.to_date || value.from_date <= value.to_date);
export const visitsFilter = z.object({ customer_id: uuid.optional(), status: z.enum(['open', 'checkout_ready', 'closed', 'canceled']).optional() });
export const settlementDate = z.object({ business_date: z.iso.date() });

/* ---------- SALE-10: 수납·환불·반품 내역 검색 ---------- */

export const salePaymentRow = z.object({
  id: z.uuid(), kind: z.enum(['payment', 'refund', 'return']), method: z.enum(['cash', 'card', 'transfer', 'wallet']),
  amount: won('gt0'), occurred_at: z.string(), reference: z.string(), reason: z.string(),
  cart_id: z.uuid(), visit_id: z.uuid(), customer_id: z.uuid(), customer_name: z.string(),
});
export type SalePaymentRow = z.infer<typeof salePaymentRow>;

const salePaymentCursor = z.object({ occurred_at: z.string(), id: z.uuid() });
export const salePaymentsResult = z.object({
  rows: z.array(salePaymentRow),
  next_cursor: salePaymentCursor.nullable(),
  totals: z.object({
    payment_total: won(), refund_total: won(), net_total: won('any'),
    payment_count: z.number().int().min(0), refund_count: z.number().int().min(0), row_count: z.number().int().min(0),
  }),
});
export type SalePaymentsResult = z.infer<typeof salePaymentsResult>;

/** 커서는 직전 페이지의 마지막 행(시각·id)을 base64url JSON으로 감싼 불투명 문자열이다. */
export function encodeSaleCursor(cursor: { occurred_at: string; id: string }): string {
  return Buffer.from(JSON.stringify({ at: cursor.occurred_at, id: cursor.id }), 'utf-8').toString('base64url');
}
export function decodeSaleCursor(value: string): { occurred_at: string; id: string } | null {
  try {
    const parsed = z.object({ at: z.string().refine((text) => !Number.isNaN(Date.parse(text))), id: z.uuid() }).safeParse(JSON.parse(Buffer.from(value, 'base64url').toString('utf-8')));
    return parsed.success ? { occurred_at: parsed.data.at, id: parsed.data.id } : null;
  } catch { return null; }
}

const optionalWhole = wholeMoney.optional();
export const salePaymentsFilter = z.object({
  from_date: z.iso.date().optional(), to_date: z.iso.date().optional(), customer_id: uuid.optional(),
  method: z.enum(['cash', 'card', 'transfer', 'wallet']).optional(), kind: z.enum(['payment', 'refund', 'return']).optional(),
  min_amount: optionalWhole, max_amount: optionalWhole, sort: z.enum(['newest', 'oldest']).default('newest'),
  limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().min(1).max(500).optional(),
}).refine((value) => !value.from_date || !value.to_date || value.from_date <= value.to_date)
  .refine((value) => value.min_amount === undefined || value.max_amount === undefined || BigInt(value.min_amount) <= BigInt(value.max_amount))
  .refine((value) => value.cursor === undefined || decodeSaleCursor(value.cursor) !== null);

/* ---------- HOME-02: 전체 미수금 ---------- */

export const receivablesSummary = z.object({
  receivable_count: z.number().int().min(0), total_due: wholeWon,
  items: z.array(z.object({
    cart_id: z.uuid(), visit_id: z.uuid(), customer_id: z.uuid(), customer_name: z.string(), opened_at: z.string(),
    total_amount: wholeWon, received_amount: wholeWon, refunded_amount: wholeWon, due_amount: wholeWon,
  })),
});
export type ReceivablesSummary = z.infer<typeof receivablesSummary>;
export const receivablesFilter = z.object({ limit: z.coerce.number().int().min(1).max(50).default(5) });

/* ---------- FIN-10: 재무 월 마감 ---------- */

/** "2030-01" 또는 "2030-01-01"을 달의 첫날로 맞춘다. 첫날이 아닌 날짜는 거부한다. */
export const monthKey = z.string().transform((value, ctx) => {
  const match = /^(\d{4})-(\d{2})(?:-01)?$/.exec(value.trim());
  const month = match ? Number(match[2]) : 0;
  if (!match || month < 1 || month > 12) { ctx.addIssue({ code: 'custom', message: 'Invalid month' }); return z.NEVER; }
  return `${match[1]}-${match[2]}-01`;
});
export const financeMonthClosing = z.object({
  id: z.uuid(), organization_id: z.uuid(), month: z.iso.date(), note: z.string(), closed_by: z.uuid(), closed_at: z.string(),
  reopened_by: z.uuid().nullable(), reopened_at: z.string().nullable(), reopen_reason: z.string().nullable(),
});
export type FinanceMonthClosing = z.infer<typeof financeMonthClosing>;
export const closeMonthRequest = z.object({ month: monthKey, note: reasonText }).strict();
export const reopenMonthRequest = z.object({ reason: reasonText }).strict();
