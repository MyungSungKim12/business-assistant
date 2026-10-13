import { z } from 'zod';
import type { ApiClient } from '../../api/client';
import {
  bundleSchema, catalogItemSchema, draftsSchema, financeSummarySchema, monthClosingSchema, monthClosingsSchema, paymentsSchema, receivablesSchema, salePaymentsSchema,
  settlementSchema, transactionSchema, transactionsSchema, visitsSchema,
  walletSchema, type CatalogItem, type Wallet,
} from './types';

const org = (organizationId: string) => `/organizations/${organizationId}`;
const query = (values: Record<string, string | undefined>) => {
  const search = new URLSearchParams(Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1]))).toString();
  return search ? `?${search}` : '';
};

export type TransactionInput = {
  transaction_type: 'income' | 'expense'; amount: string; transaction_date: string; category: string; counterparty: string; memo: string; is_archived: boolean;
};
export type SalePaymentFilter = {
  from?: string; to?: string; customerId?: string; method?: string; kind?: string; minAmount?: string; maxAmount?: string; sort?: 'newest' | 'oldest'; cursor?: string; limit?: number;
};
export type PaymentPart = { method: 'cash' | 'card' | 'transfer'; amount: string; reference: string };

export const salesApi = {
  visits: (api: ApiClient, o: string) => api.call('GET', `${org(o)}/visits`, visitsSchema),
  drafts: (api: ApiClient, o: string) => api.call('GET', `${org(o)}/sale-cart-drafts`, draftsSchema),
  /** 판매 가능한 상품·회원권(기존 operations 읽기 경로). */
  async catalog(api: ApiClient, o: string): Promise<CatalogItem[]> {
    const rows = await api.listOperationRecords(o, 'inventory');
    return rows.flatMap((row) => { const parsed = catalogItemSchema.safeParse(row); return parsed.success ? [parsed.data] : []; });
  },
  createVisit: (api: ApiClient, o: string, customerId: string, operationId: string) =>
    api.call('POST', `${org(o)}/customers/${customerId}/visits`, bundleSchema, { operation_id: operationId }),
  cart: (api: ApiClient, o: string, visitId: string) => api.call('GET', `${org(o)}/visits/${visitId}/sale-cart`, bundleSchema),
  addDraft: (api: ApiClient, o: string, visitId: string, draftId: string, version: number, operationId: string) =>
    api.call('POST', `${org(o)}/visits/${visitId}/sale-cart/lines/treatment-draft`, bundleSchema, { draft_id: draftId, expected_version: version, operation_id: operationId }),
  /** 상품·회원권 담기는 카탈로그 모듈이 제공하는 경로를 쓴다. */
  addCatalogProduct: (api: ApiClient, o: string, visitId: string, productId: string, version: number, operationId: string) =>
    api.call('POST', `${org(o)}/visits/${visitId}/sale-cart/lines/catalog-product`, bundleSchema, { product_id: productId, expected_version: version, operation_id: operationId }),
  updateLine: (api: ApiClient, o: string, visitId: string, lineId: string, version: number, operationId: string, values: { quantity: number; unit_price: string; staff_id: string | null; staff_name: string }) =>
    api.call('PATCH', `${org(o)}/visits/${visitId}/sale-cart/lines/${lineId}`, bundleSchema, { ...values, expected_version: version, operation_id: operationId }),
  removeLine: (api: ApiClient, o: string, visitId: string, lineId: string, version: number, operationId: string, reason: string) =>
    api.call('POST', `${org(o)}/visits/${visitId}/sale-cart/lines/${lineId}/remove`, bundleSchema, { reason, expected_version: version, operation_id: operationId }),
  restoreLine: (api: ApiClient, o: string, visitId: string, lineId: string, version: number, operationId: string) =>
    api.call('POST', `${org(o)}/visits/${visitId}/sale-cart/lines/${lineId}/restore`, bundleSchema, { expected_version: version, operation_id: operationId }),
  review: (api: ApiClient, o: string, visitId: string, version: number, operationId: string, ready: boolean) =>
    api.call('POST', `${org(o)}/visits/${visitId}/sale-cart/review`, bundleSchema, { ready, expected_version: version, operation_id: operationId }),
  discount: (api: ApiClient, o: string, visitId: string, body: { kind: 'none' | 'amount' | 'percent'; value: string; reason: string; expected_version: number; operation_id: string }) =>
    api.call('POST', `${org(o)}/visits/${visitId}/sale-cart/discount`, bundleSchema, { ...body, confirmed: true }),
  cancelVisit: (api: ApiClient, o: string, visitId: string, version: number, operationId: string) =>
    api.call('POST', `${org(o)}/visits/${visitId}/cancel`, bundleSchema, { expected_version: version, operation_id: operationId }),

  payments: (api: ApiClient, o: string, visitId: string) => api.call('GET', `${org(o)}/visits/${visitId}/payments`, paymentsSchema),
  recordPayment: (api: ApiClient, o: string, visitId: string, body: { operation_id: string; expected_version: number; payments: PaymentPart[]; confirmed: true }) =>
    api.call('POST', `${org(o)}/visits/${visitId}/payments`, paymentsSchema, body),
  refund: (api: ApiClient, o: string, visitId: string, body: { operation_id: string; expected_version: number; source_id: string; amount: string; reason: string; confirmed: true }) =>
    api.call('POST', `${org(o)}/visits/${visitId}/payments/refunds`, paymentsSchema, body),
  productReturn: (api: ApiClient, o: string, visitId: string, body: { operation_id: string; expected_version: number; sale_line_id: string; receipt_id: string; quantity: number; restock: boolean; amount: string; reason: string; confirmed: true }) =>
    api.call('POST', `${org(o)}/visits/${visitId}/payments/product-returns`, paymentsSchema, body),

  settlement: (api: ApiClient, o: string, businessDate: string) => api.call('GET', `${org(o)}/sale-daily-settlement${query({ business_date: businessDate })}`, settlementSchema),
  closeDay: (api: ApiClient, o: string, businessDate: string, body: { operation_id: string; counted_cash: string; reason: string; confirmed: true }) =>
    api.call('POST', `${org(o)}/sale-daily-settlement/close${query({ business_date: businessDate })}`, settlementSchema, body),
  adjustClose: (api: ApiClient, o: string, businessDate: string, body: { operation_id: string; expected_version: number; counted_cash: string; reason: string; confirmed: true }) =>
    api.call('POST', `${org(o)}/sale-daily-settlement/adjustments${query({ business_date: businessDate })}`, settlementSchema, body),

  transactions: (api: ApiClient, o: string, filter: { type?: string; from?: string; to?: string }) =>
    api.call('GET', `${org(o)}/finance-transactions${query({ transaction_type: filter.type, from_date: filter.from, to_date: filter.to })}`, transactionsSchema),
  summary: (api: ApiClient, o: string, filter: { from?: string; to?: string }) =>
    api.call('GET', `${org(o)}/finance-summary${query({ from_date: filter.from, to_date: filter.to })}`, financeSummarySchema),
  createTransaction: (api: ApiClient, o: string, input: TransactionInput) => api.call('POST', `${org(o)}/finance-transactions`, transactionSchema, input),
  updateTransaction: (api: ApiClient, o: string, id: string, patch: Partial<TransactionInput>) => api.call('PATCH', `${org(o)}/finance-transactions/${id}`, transactionSchema, patch),

  /** 수납·환불·반품 내역 검색. 합계는 조건에 맞는 전체 행 기준이고 rows는 한 페이지다. */
  salePayments: (api: ApiClient, o: string, filter: SalePaymentFilter) =>
    api.call('GET', `${org(o)}/sale-payments${query({
      from_date: filter.from, to_date: filter.to, customer_id: filter.customerId, method: filter.method, kind: filter.kind,
      min_amount: filter.minAmount, max_amount: filter.maxAmount, sort: filter.sort, cursor: filter.cursor, limit: filter.limit === undefined ? undefined : String(filter.limit),
    })}`, salePaymentsSchema),
  receivables: (api: ApiClient, o: string, limit = 5) => api.call('GET', `${org(o)}/receivables${query({ limit: String(limit) })}`, receivablesSchema),

  monthClosings: (api: ApiClient, o: string) => api.call('GET', `${org(o)}/finance-month-closings`, monthClosingsSchema),
  closeMonth: (api: ApiClient, o: string, month: string, note: string) => api.call('POST', `${org(o)}/finance-month-closings`, monthClosingSchema, { month, note }),
  reopenMonth: (api: ApiClient, o: string, month: string, reason: string) => api.call('POST', `${org(o)}/finance-month-closings/${month}/reopen`, monthClosingSchema, { reason }),

  /** 고객 지갑 조회(기존 operations 읽기 경로). */
  async wallets(api: ApiClient, o: string): Promise<Wallet[]> {
    const rows = await api.listOperationRecords(o, 'memberships');
    return z.array(walletSchema).catch([]).parse(rows);
  },
};
