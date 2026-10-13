import { z } from 'zod';
import type { ServerConfig } from '../../config.js';
import { ApiFailure } from '../../errors.js';
import { assertOrganization, createRest } from '../../supabase/rest.js';
import { createSalesHttp } from './http.js';
import { formatFixed, toCents } from './money.js';
import {
  customerVisit, financeRow, saleCartBundle, saleDailySettlement, treatmentSaleDraft, visitPayments,
  type CustomerVisit, type FinanceTransaction, type SaleCartBundle, type SaleDailySettlement, type TreatmentSaleDraft, type VisitPayments,
} from './schemas.js';

const FINANCE_UNAVAILABLE = 'Finance service unavailable';
const financeColumns = 'id,organization_id,created_by,transaction_type,amount,transaction_date,category,counterparty,memo,is_archived,created_at,updated_at';
const draftColumns = 'id,organization_id,customer_id,treatment_id,status,description,amount,source_snapshot,created_by,created_at';
const PAGE = 200;

export type FinanceInput = {
  transaction_type: 'income' | 'expense'; amount: string; transaction_date: string; category: string;
  counterparty: string; memo: string; is_archived: boolean;
};
export type FinanceSummary = { income_total: string; expense_total: string; net_total: string; transaction_count: number };

export function createSalesGateway(config: ServerConfig, fetcher: typeof fetch = fetch) {
  const http = createSalesHttp(config, fetcher);
  const finance = createRest(config, fetcher, FINANCE_UNAVAILABLE);
  const unavailable = () => new ApiFailure(503, http.unavailable);

  function parse<T>(schema: z.ZodType<T>, payload: unknown): T {
    const result = schema.safeParse(payload);
    if (!result.success) throw unavailable();
    return result.data;
  }

  /** limit/offset 페이지를 빈 페이지가 나올 때까지 모은다. 중복 id는 서버 오류로 본다. */
  async function pages<T extends { id: string }>(token: string, table: string, query: Record<string, string>, schema: z.ZodType<T>, size = PAGE): Promise<T[]> {
    const result: T[] = [];
    const seen = new Set<string>();
    for (let guard = 0; guard < 1000; guard += 1) {
      const payload = await http.get(token, table, { ...query, limit: String(size), offset: String(result.length) });
      if (!Array.isArray(payload)) throw unavailable();
      if (payload.length === 0) return result;
      const rows = parse(z.array(schema), payload);
      for (const row of rows) {
        if (seen.has(row.id)) throw unavailable();
        seen.add(row.id);
      }
      result.push(...rows);
    }
    throw unavailable();
  }

  async function bundle(token: string, name: string, args: Record<string, unknown>, organizationId: string): Promise<SaleCartBundle> {
    const result = parse(saleCartBundle, await http.rpc(token, name, args));
    if (result.visit.organization_id !== organizationId || result.cart.organization_id !== organizationId
      || result.lines.some((line) => line.organization_id !== organizationId || line.cart_id !== result.cart.id)) throw unavailable();
    return result;
  }

  async function payments(token: string, name: string, organizationId: string, visitId: string, values: Record<string, unknown> = {}): Promise<VisitPayments> {
    const result = parse(visitPayments, await http.rpc(token, name, { p_organization_id: organizationId, p_visit_id: visitId, ...values }));
    if (result.visit_id !== visitId) throw unavailable();
    return result;
  }

  async function settlement(token: string, name: string, organizationId: string, businessDate: string, values: Record<string, unknown> = {}): Promise<SaleDailySettlement> {
    const result = parse(saleDailySettlement, await http.rpc(token, name, { p_organization_id: organizationId, p_business_date: businessDate, ...values }));
    if (result.organization_id !== organizationId || result.business_date !== businessDate || result.is_closed !== (result.close !== null)) throw unavailable();
    return result;
  }

  function financeFilters(organizationId: string, fromDate?: string, toDate?: string, type?: string): Record<string, string> {
    const query: Record<string, string> = { select: financeColumns, organization_id: `eq.${organizationId}` };
    if (fromDate && toDate) query.and = `(transaction_date.gte.${fromDate},transaction_date.lte.${toDate})`;
    else if (fromDate) query.transaction_date = `gte.${fromDate}`;
    else if (toDate) query.transaction_date = `lte.${toDate}`;
    if (type) query.transaction_type = `eq.${type}`;
    return query;
  }

  return {
    /* ---------- 방문 장바구니 ---------- */
    async listVisits(token: string, organizationId: string, customerId?: string, status?: string): Promise<CustomerVisit[]> {
      const query: Record<string, string> = { select: '*', organization_id: `eq.${organizationId}`, order: 'opened_at.desc,id.desc' };
      if (customerId) query.customer_id = `eq.${customerId}`;
      if (status) query.status = `eq.${status}`;
      const rows = await pages(token, 'customer_visits', query, customerVisit);
      if (rows.some((row) => row.organization_id !== organizationId)) throw unavailable();
      return rows;
    },
    async listCartDrafts(token: string, organizationId: string): Promise<TreatmentSaleDraft[]> {
      const rows = await pages(token, 'treatment_sale_drafts', { select: draftColumns, organization_id: `eq.${organizationId}`, status: 'eq.draft', order: 'created_at.desc,id.desc' }, treatmentSaleDraft, 500);
      if (rows.some((row) => row.organization_id !== organizationId)) throw unavailable();
      return rows;
    },
    createVisit: (token: string, organizationId: string, customerId: string, operationId: string) =>
      bundle(token, 'create_customer_visit', { p_organization_id: organizationId, p_customer_id: customerId, p_operation_id: operationId }, organizationId),
    async getCart(token: string, organizationId: string, visitId: string) {
      const result = await bundle(token, 'get_visit_sale_cart', { p_organization_id: organizationId, p_visit_id: visitId }, organizationId);
      if (result.visit.id !== visitId || result.cart.visit_id !== visitId || result.cart.customer_id !== result.visit.customer_id) throw unavailable();
      return result;
    },
    addTreatmentDraft: (token: string, organizationId: string, visitId: string, draftId: string, expectedVersion: number, operationId: string) =>
      bundle(token, 'add_treatment_draft_to_cart', { p_organization_id: organizationId, p_visit_id: visitId, p_draft_id: draftId, p_expected_version: expectedVersion, p_operation_id: operationId }, organizationId),
    mutateLine: (token: string, organizationId: string, visitId: string, lineId: string, expectedVersion: number, operationId: string, action: 'update' | 'remove' | 'restore', values: Record<string, unknown>) =>
      bundle(token, 'mutate_sale_cart_line', { p_organization_id: organizationId, p_visit_id: visitId, p_line_id: lineId, p_expected_version: expectedVersion, p_operation_id: operationId, p_action: action, p_values: values }, organizationId),
    review: (token: string, organizationId: string, visitId: string, expectedVersion: number, operationId: string, ready: boolean) =>
      bundle(token, 'review_sale_cart', { p_organization_id: organizationId, p_visit_id: visitId, p_expected_version: expectedVersion, p_operation_id: operationId, p_ready: ready }, organizationId),
    applyDiscount: (token: string, organizationId: string, visitId: string, kind: string, value: string, reason: string, expectedVersion: number, operationId: string, confirmed: boolean) =>
      bundle(token, 'apply_sale_cart_discount', { p_organization_id: organizationId, p_visit_id: visitId, p_kind: kind, p_value: value, p_reason: reason, p_expected_version: expectedVersion, p_operation_id: operationId, p_confirmed: confirmed }, organizationId),
    cancelVisit: (token: string, organizationId: string, visitId: string, expectedVersion: number, operationId: string) =>
      bundle(token, 'cancel_customer_visit', { p_organization_id: organizationId, p_visit_id: visitId, p_expected_version: expectedVersion, p_operation_id: operationId }, organizationId),

    /* ---------- 수납 ---------- */
    getPayments: (token: string, organizationId: string, visitId: string) => payments(token, 'get_visit_payments', organizationId, visitId),
    recordPayment: (token: string, organizationId: string, visitId: string, expectedVersion: number, operationId: string, parts: Array<{ method: string; amount: string; reference: string }>, confirmed: boolean) =>
      payments(token, 'record_visit_payment', organizationId, visitId, { p_expected_version: expectedVersion, p_operation_id: operationId, p_payments: parts, p_confirmed: confirmed }),
    refundPayment: (token: string, organizationId: string, visitId: string, sourceId: string, amount: string, reason: string, expectedCartVersion: number, operationId: string, confirmed: boolean) =>
      payments(token, 'refund_visit_payment', organizationId, visitId, { p_source_id: sourceId, p_amount: amount, p_reason: reason, p_expected_cart_version: expectedCartVersion, p_operation_id: operationId, p_confirmed: confirmed }),
    returnProduct: (token: string, organizationId: string, visitId: string, v: { sale_line_id: string; receipt_id: string; quantity: number; restock: boolean; amount: string; reason: string; expected_version: number; operation_id: string; confirmed: boolean }) =>
      payments(token, 'return_visit_product', organizationId, visitId, {
        p_sale_line_id: v.sale_line_id, p_receipt_id: v.receipt_id, p_quantity: v.quantity, p_restock: v.restock, p_amount: v.amount,
        p_reason: v.reason, p_expected_cart_version: v.expected_version, p_operation_id: v.operation_id, p_confirmed: v.confirmed,
      }),

    /* ---------- 일 정산 ---------- */
    getSettlement: (token: string, organizationId: string, businessDate: string) => settlement(token, 'get_sale_daily_settlement', organizationId, businessDate),
    closeDay: (token: string, organizationId: string, businessDate: string, countedCash: string, reason: string, operationId: string, confirmed: boolean) =>
      settlement(token, 'close_sale_daily', organizationId, businessDate, { p_counted_cash: countedCash, p_reason: reason, p_operation_id: operationId, p_confirmed: confirmed }),
    adjustClose: (token: string, organizationId: string, businessDate: string, expectedVersion: number, countedCash: string, reason: string, operationId: string, confirmed: boolean) =>
      settlement(token, 'adjust_sale_daily_close', organizationId, businessDate, { p_expected_version: expectedVersion, p_counted_cash: countedCash, p_reason: reason, p_operation_id: operationId, p_confirmed: confirmed }),

    /* ---------- 수입·지출 ---------- */
    async listTransactions(token: string, organizationId: string, fromDate?: string, toDate?: string, type?: string): Promise<FinanceTransaction[]> {
      const query = { ...financeFilters(organizationId, fromDate, toDate, type), order: 'transaction_date.desc,created_at.desc,id.desc' };
      const rows: FinanceTransaction[] = [];
      for (let guard = 0; guard < 1000; guard += 1) {
        const page = await finance.select(token, 'finance_transactions', { ...query, limit: '500', offset: String(rows.length) }, financeRow);
        if (page.length === 0) break;
        rows.push(...page);
      }
      return assertOrganization(rows, organizationId, FINANCE_UNAVAILABLE);
    },
    async createTransaction(token: string, organizationId: string, input: FinanceInput): Promise<FinanceTransaction> {
      const createdBy = await finance.userId(token);
      const row = await finance.insert(token, 'finance_transactions', { ...input, organization_id: organizationId, created_by: createdBy }, financeRow, { select: financeColumns });
      assertOrganization([row], organizationId, FINANCE_UNAVAILABLE);
      return row;
    },
    async updateTransaction(token: string, organizationId: string, transactionId: string, patch: Partial<FinanceInput>): Promise<FinanceTransaction | null> {
      const row = await finance.update(token, 'finance_transactions', { select: financeColumns, id: `eq.${transactionId}`, organization_id: `eq.${organizationId}` }, patch, financeRow);
      if (row) assertOrganization([row], organizationId, FINANCE_UNAVAILABLE);
      return row;
    },
    /** 보관되지 않은 거래의 수입/지출 합계. 정수 단위("전")로 더해 부동소수 오차를 피한다. */
    async summarize(token: string, organizationId: string, fromDate?: string, toDate?: string): Promise<FinanceSummary> {
      const row = z.object({ id: z.uuid(), transaction_type: z.enum(['income', 'expense']), amount: z.union([z.string(), z.number()]) });
      const query = { ...financeFilters(organizationId, fromDate, toDate), select: 'id,transaction_type,amount', is_archived: 'eq.false', order: 'id.asc' };
      let income = 0n;
      let expense = 0n;
      let count = 0;
      const seen = new Set<string>();
      for (let guard = 0; guard < 1000; guard += 1) {
        const page = await finance.select(token, 'finance_transactions', { ...query, limit: '1000', offset: String(count) }, row);
        if (page.length === 0) break;
        for (const item of page) {
          if (seen.has(item.id)) throw new ApiFailure(503, FINANCE_UNAVAILABLE);
          seen.add(item.id);
          let cents: bigint;
          try { cents = toCents(item.amount); } catch { throw new ApiFailure(503, FINANCE_UNAVAILABLE); }
          if (item.transaction_type === 'income') income += cents; else expense += cents;
        }
        count += page.length;
      }
      return { income_total: formatFixed(income), expense_total: formatFixed(expense), net_total: formatFixed(income - expense), transaction_count: count };
    },
  };
}

export type SalesGateway = ReturnType<typeof createSalesGateway>;
