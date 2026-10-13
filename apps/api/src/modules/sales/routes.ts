import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiFailure } from '../../errors.js';
import { bearerToken } from '../../routes/organizations.js';
import type { SalesGateway } from './gateway.js';
import {
  addDraftRequest, adjustRequest, closeMonthRequest, closeRequest, discountRequest, financeCreateRequest, financeFilter, financeSummaryFilter, financeUpdateRequest,
  monthKey, operationRequest, productReturnRequest, receivablesFilter, recordPaymentRequest, refundRequest, removeLineRequest, reopenMonthRequest, reviewRequest, salePaymentsFilter, settlementDate,
  updateLineRequest, versionedRequest, visitsFilter,
} from './schemas.js';

export type OrgAccess = Pick<{ requireAccess(token: string, id: string, feature: string, write?: boolean): Promise<string> }, 'requireAccess'>;

const base = '/api/v1/organizations/:organizationId';
const orgParams = z.object({ organizationId: z.uuid() });
const visitParams = orgParams.extend({ visitId: z.uuid() });
const lineParams = visitParams.extend({ lineId: z.uuid() });
const invalid = (message: string) => new ApiFailure(422, message);

/** 방문 장바구니·수납은 CRM과 재무 기능이 모두 필요하다(Python 라우터 의존성과 동일). */
const CART_FEATURES = ['crm.basic', 'finance.basic'];
const FINANCE_FEATURES = ['finance.basic'];

export function registerSalesRoutes(app: FastifyInstance, organizations: OrgAccess | undefined, gateway: SalesGateway): void {
  function start(request: FastifyRequest) {
    const token = bearerToken(request);
    if (!organizations) throw new ApiFailure(503, 'Sales service unavailable');
    return token;
  }
  function parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
    const result = schema.safeParse(value);
    if (!result.success) throw invalid(message);
    return result.data;
  }
  async function authorize(token: string, organizationId: string, features: string[], write = false): Promise<void> {
    for (const feature of features) await organizations!.requireAccess(token, organizationId, feature, write);
  }

  /* ---------- 방문 장바구니 ---------- */
  app.get(`${base}/visits`, async (request) => {
    const token = start(request);
    const { organizationId } = parse(orgParams, request.params, 'Invalid organization ID');
    const filter = parse(visitsFilter, request.query, 'Invalid visit filter');
    await authorize(token, organizationId, CART_FEATURES);
    return gateway.listVisits(token, organizationId, filter.customer_id, filter.status);
  });
  app.get(`${base}/sale-cart-drafts`, async (request) => {
    const token = start(request);
    const { organizationId } = parse(orgParams, request.params, 'Invalid organization ID');
    await authorize(token, organizationId, CART_FEATURES);
    return gateway.listCartDrafts(token, organizationId);
  });
  app.post(`${base}/customers/:customerId/visits`, async (request, reply) => {
    const token = start(request);
    const params = parse(orgParams.extend({ customerId: z.uuid() }), request.params, 'Invalid customer ID');
    const body = parse(operationRequest, request.body, 'Invalid sale cart request');
    await authorize(token, params.organizationId, CART_FEATURES, true);
    return reply.code(201).send(await gateway.createVisit(token, params.organizationId, params.customerId, body.operation_id));
  });
  app.get(`${base}/visits/:visitId/sale-cart`, async (request) => {
    const token = start(request);
    const params = parse(visitParams, request.params, 'Invalid visit ID');
    await authorize(token, params.organizationId, CART_FEATURES);
    return gateway.getCart(token, params.organizationId, params.visitId);
  });
  app.post(`${base}/visits/:visitId/sale-cart/lines/treatment-draft`, async (request) => {
    const token = start(request);
    const params = parse(visitParams, request.params, 'Invalid visit ID');
    const body = parse(addDraftRequest, request.body, 'Invalid sale cart request');
    await authorize(token, params.organizationId, CART_FEATURES, true);
    return gateway.addTreatmentDraft(token, params.organizationId, params.visitId, body.draft_id, body.expected_version, body.operation_id);
  });
  app.patch(`${base}/visits/:visitId/sale-cart/lines/:lineId`, async (request) => {
    const token = start(request);
    const params = parse(lineParams, request.params, 'Invalid line ID');
    const { expected_version, operation_id, ...values } = parse(updateLineRequest, request.body, 'Invalid sale cart request');
    await authorize(token, params.organizationId, CART_FEATURES, true);
    return gateway.mutateLine(token, params.organizationId, params.visitId, params.lineId, expected_version, operation_id, 'update', values);
  });
  app.post(`${base}/visits/:visitId/sale-cart/lines/:lineId/remove`, async (request) => {
    const token = start(request);
    const params = parse(lineParams, request.params, 'Invalid line ID');
    const body = parse(removeLineRequest, request.body, 'Invalid sale cart request');
    await authorize(token, params.organizationId, CART_FEATURES, true);
    return gateway.mutateLine(token, params.organizationId, params.visitId, params.lineId, body.expected_version, body.operation_id, 'remove', { reason: body.reason });
  });
  app.post(`${base}/visits/:visitId/sale-cart/lines/:lineId/restore`, async (request) => {
    const token = start(request);
    const params = parse(lineParams, request.params, 'Invalid line ID');
    const body = parse(versionedRequest, request.body, 'Invalid sale cart request');
    await authorize(token, params.organizationId, CART_FEATURES, true);
    return gateway.mutateLine(token, params.organizationId, params.visitId, params.lineId, body.expected_version, body.operation_id, 'restore', {});
  });
  app.post(`${base}/visits/:visitId/sale-cart/review`, async (request) => {
    const token = start(request);
    const params = parse(visitParams, request.params, 'Invalid visit ID');
    const body = parse(reviewRequest, request.body, 'Invalid sale cart request');
    await authorize(token, params.organizationId, CART_FEATURES, true);
    return gateway.review(token, params.organizationId, params.visitId, body.expected_version, body.operation_id, body.ready);
  });
  app.post(`${base}/visits/:visitId/sale-cart/discount`, async (request) => {
    const token = start(request);
    const params = parse(visitParams, request.params, 'Invalid visit ID');
    const body = parse(discountRequest, request.body, 'Invalid sale cart request');
    await authorize(token, params.organizationId, CART_FEATURES, true);
    return gateway.applyDiscount(token, params.organizationId, params.visitId, body.kind, body.value, body.reason, body.expected_version, body.operation_id, body.confirmed);
  });
  app.post(`${base}/visits/:visitId/cancel`, async (request) => {
    const token = start(request);
    const params = parse(visitParams, request.params, 'Invalid visit ID');
    const body = parse(versionedRequest, request.body, 'Invalid sale cart request');
    await authorize(token, params.organizationId, CART_FEATURES, true);
    return gateway.cancelVisit(token, params.organizationId, params.visitId, body.expected_version, body.operation_id);
  });

  /* ---------- 방문 수납·환불·반품 ---------- */
  app.get(`${base}/visits/:visitId/payments`, async (request) => {
    const token = start(request);
    const params = parse(visitParams, request.params, 'Invalid visit ID');
    await authorize(token, params.organizationId, CART_FEATURES);
    return gateway.getPayments(token, params.organizationId, params.visitId);
  });
  app.post(`${base}/visits/:visitId/payments`, async (request) => {
    const token = start(request);
    const params = parse(visitParams, request.params, 'Invalid visit ID');
    const body = parse(recordPaymentRequest, request.body, 'Invalid payment request');
    await authorize(token, params.organizationId, CART_FEATURES, true);
    return gateway.recordPayment(token, params.organizationId, params.visitId, body.expected_version, body.operation_id, body.payments, body.confirmed);
  });
  app.post(`${base}/visits/:visitId/payments/refunds`, async (request) => {
    const token = start(request);
    const params = parse(visitParams, request.params, 'Invalid visit ID');
    const body = parse(refundRequest, request.body, 'Invalid refund request');
    await authorize(token, params.organizationId, CART_FEATURES, true);
    return gateway.refundPayment(token, params.organizationId, params.visitId, body.source_id, body.amount, body.reason, body.expected_version, body.operation_id, body.confirmed);
  });
  app.post(`${base}/visits/:visitId/payments/product-returns`, async (request) => {
    const token = start(request);
    const params = parse(visitParams, request.params, 'Invalid visit ID');
    const body = parse(productReturnRequest, request.body, 'Invalid product return request');
    await authorize(token, params.organizationId, CART_FEATURES, true);
    return gateway.returnProduct(token, params.organizationId, params.visitId, body);
  });

  /* ---------- 일 정산(미수·시재 마감) ---------- */
  app.get(`${base}/sale-daily-settlement`, async (request) => {
    const token = start(request);
    const { organizationId } = parse(orgParams, request.params, 'Invalid organization ID');
    const { business_date } = parse(settlementDate, request.query, 'Invalid business date');
    await authorize(token, organizationId, FINANCE_FEATURES);
    return gateway.getSettlement(token, organizationId, business_date);
  });
  app.post(`${base}/sale-daily-settlement/close`, async (request) => {
    const token = start(request);
    const { organizationId } = parse(orgParams, request.params, 'Invalid organization ID');
    const { business_date } = parse(settlementDate, request.query, 'Invalid business date');
    const body = parse(closeRequest, request.body, 'Invalid close request');
    await authorize(token, organizationId, FINANCE_FEATURES, true);
    return gateway.closeDay(token, organizationId, business_date, body.counted_cash, body.reason, body.operation_id, body.confirmed);
  });
  app.post(`${base}/sale-daily-settlement/adjustments`, async (request) => {
    const token = start(request);
    const { organizationId } = parse(orgParams, request.params, 'Invalid organization ID');
    const { business_date } = parse(settlementDate, request.query, 'Invalid business date');
    const body = parse(adjustRequest, request.body, 'Invalid close request');
    await authorize(token, organizationId, FINANCE_FEATURES, true);
    return gateway.adjustClose(token, organizationId, business_date, body.expected_version, body.counted_cash, body.reason, body.operation_id, body.confirmed);
  });

  /* ---------- 수입·지출 ---------- */
  app.get(`${base}/finance-transactions`, async (request) => {
    const token = start(request);
    const { organizationId } = parse(orgParams, request.params, 'Invalid organization ID');
    const filter = parse(financeFilter, request.query, 'Invalid finance request');
    await authorize(token, organizationId, FINANCE_FEATURES);
    return gateway.listTransactions(token, organizationId, filter.from_date, filter.to_date, filter.transaction_type);
  });
  app.post(`${base}/finance-transactions`, async (request, reply) => {
    const token = start(request);
    const { organizationId } = parse(orgParams, request.params, 'Invalid organization ID');
    const body = parse(financeCreateRequest, request.body, 'Invalid finance request');
    await authorize(token, organizationId, FINANCE_FEATURES, true);
    return reply.code(201).send(await gateway.createTransaction(token, organizationId, body));
  });
  app.patch(`${base}/finance-transactions/:transactionId`, async (request) => {
    const token = start(request);
    const params = parse(orgParams.extend({ transactionId: z.uuid() }), request.params, 'Invalid transaction ID');
    const body = parse(financeUpdateRequest, request.body, 'Invalid finance request');
    await authorize(token, params.organizationId, FINANCE_FEATURES, true);
    const saved = await gateway.updateTransaction(token, params.organizationId, params.transactionId, body);
    if (!saved) throw new ApiFailure(404, 'Finance transaction not found');
    return saved;
  });
  app.get(`${base}/finance-summary`, async (request) => {
    const token = start(request);
    const { organizationId } = parse(orgParams, request.params, 'Invalid organization ID');
    const filter = parse(financeSummaryFilter, request.query, 'Invalid finance request');
    await authorize(token, organizationId, FINANCE_FEATURES);
    const summary = await gateway.summarize(token, organizationId, filter.from_date, filter.to_date);
    return { from_date: filter.from_date ?? null, to_date: filter.to_date ?? null, ...summary };
  });

  /* ---------- 수납·환불 내역 검색(읽기 전용) ---------- */
  app.get(`${base}/sale-payments`, async (request) => {
    const token = start(request);
    const { organizationId } = parse(orgParams, request.params, 'Invalid organization ID');
    const filter = parse(salePaymentsFilter, request.query, 'Invalid sale payment filter');
    await authorize(token, organizationId, FINANCE_FEATURES);
    return gateway.listSalePayments(token, organizationId, filter);
  });

  /* ---------- 전체 미수금(읽기 전용) ---------- */
  app.get(`${base}/receivables`, async (request) => {
    const token = start(request);
    const { organizationId } = parse(orgParams, request.params, 'Invalid organization ID');
    const filter = parse(receivablesFilter, request.query, 'Invalid receivables filter');
    await authorize(token, organizationId, FINANCE_FEATURES);
    return gateway.getReceivables(token, organizationId, filter.limit);
  });

  /* ---------- 재무 월 마감(일 마감과 별개) ---------- */
  app.get(`${base}/finance-month-closings`, async (request) => {
    const token = start(request);
    const { organizationId } = parse(orgParams, request.params, 'Invalid organization ID');
    await authorize(token, organizationId, FINANCE_FEATURES);
    return gateway.listMonthClosings(token, organizationId);
  });
  app.post(`${base}/finance-month-closings`, async (request, reply) => {
    const token = start(request);
    const { organizationId } = parse(orgParams, request.params, 'Invalid organization ID');
    const body = parse(closeMonthRequest, request.body, 'Invalid month close request');
    await authorize(token, organizationId, FINANCE_FEATURES, true);
    return reply.code(201).send(await gateway.closeMonth(token, organizationId, body.month, body.note));
  });
  app.post(`${base}/finance-month-closings/:month/reopen`, async (request) => {
    const token = start(request);
    const params = parse(orgParams.extend({ month: monthKey }), request.params, 'Invalid month');
    const body = parse(reopenMonthRequest, request.body, 'Invalid month reopen request');
    await authorize(token, params.organizationId, FINANCE_FEATURES, true);
    return gateway.reopenMonth(token, params.organizationId, params.month, body.reason);
  });
}
