import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuditEvent, AuditRecorder } from './recorder.js';

type Params = Record<string, string | undefined>;
type Body = Record<string, unknown>;

/** 성공(2xx)한 요청 뒤에 남길 감사 이벤트 규칙. 기존 라우트 코드는 건드리지 않고 경로 패턴으로 연결한다. */
type Rule = {
  action: (body: Body) => string | null;
  targetType: string;
  target: (params: Params) => string | undefined;
  metadata: (params: Params, body: Body, query: Params) => Record<string, unknown>;
};

const base = '/api/v1/organizations/:organizationId';
const fixed = (action: string) => () => action;
const noTarget = () => undefined;
const pick = (source: Body, keys: string[]): Record<string, unknown> => Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]));

const RULES: Record<string, Rule> = {
  [`POST ${base}/visits/:visitId/payments/refunds`]: {
    action: fixed('sale.refund'), targetType: 'visit', target: (p) => p.visitId,
    metadata: (_p, b) => pick(b, ['source_id', 'amount', 'operation_id']),
  },
  [`POST ${base}/visits/:visitId/payments/product-returns`]: {
    action: fixed('sale.product_return'), targetType: 'visit', target: (p) => p.visitId,
    metadata: (_p, b) => pick(b, ['sale_line_id', 'receipt_id', 'quantity', 'restock', 'amount', 'operation_id']),
  },
  [`POST ${base}/sale-daily-settlement/close`]: {
    action: fixed('sale.day_close'), targetType: 'business_date', target: noTarget,
    metadata: (_p, b, q) => ({ business_date: q.business_date, ...pick(b, ['counted_cash', 'operation_id']) }),
  },
  [`POST ${base}/sale-daily-settlement/adjustments`]: {
    action: fixed('sale.close_adjust'), targetType: 'business_date', target: noTarget,
    metadata: (_p, b, q) => ({ business_date: q.business_date, ...pick(b, ['counted_cash', 'expected_version', 'operation_id']) }),
  },
  [`POST ${base}/customers/:customerId/treatments/:treatmentId/documents/:documentId/events`]: {
    action: (b) => (['sign', 'deliver', 'revoke'].includes(String(b.action)) ? `consent.${String(b.action)}` : null),
    targetType: 'document', target: (p) => p.documentId,
    metadata: (p, b) => ({
      customer_id: p.customerId, treatment_id: p.treatmentId, ...pick(b, ['operation_id', 'expected_revision']),
      ...(b.action === 'deliver' && typeof b.values === 'object' && b.values ? pick(b.values as Body, ['method']) : {}),
    }),
  },
  [`POST ${base}/customers/:customerId/treatments/:treatmentId/documents`]: {
    action: fixed('document.issue'), targetType: 'treatment', target: (p) => p.treatmentId,
    metadata: (p, b) => ({ customer_id: p.customerId, ...pick(b, ['template_id', 'operation_id']) }),
  },
  [`POST ${base}/document-templates/:templateId/mutations`]: {
    action: (b) => (b.action === 'publish' ? 'template.publish' : null), targetType: 'document_template', target: (p) => p.templateId,
    metadata: (_p, b) => pick(b, ['operation_id', 'expected_revision']),
  },
  [`POST ${base}/members`]: {
    action: fixed('member.add'), targetType: 'member', target: noTarget,
    metadata: (_p, b) => pick(b, ['role']),
  },
  [`PATCH ${base}/members/:userId`]: {
    action: fixed('member.role_change'), targetType: 'member', target: (p) => p.userId,
    metadata: (_p, b) => pick(b, ['role']),
  },
  [`DELETE ${base}/members/:userId`]: {
    action: fixed('member.remove'), targetType: 'member', target: (p) => p.userId, metadata: () => ({}),
  },
  [`DELETE ${base}/files/:fileId`]: {
    action: fixed('file.archive'), targetType: 'file', target: (p) => p.fileId, metadata: () => ({}),
  },
};

const bearer = (request: FastifyRequest) => /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '')?.[1];
const asRecord = (value: unknown): Body => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Body) : {});

/**
 * 성공한 민감 작업(환불·반품·일 마감·정정·동의서·문서 발행·서식 발행·파일 보관) 뒤에 감사 이벤트를 남긴다.
 * onSend 에서 기록이 끝난 뒤 응답하며, 기록 실패는 응답을 바꾸지 않는다(recorder.record 가 삼킨다).
 */
export function registerAuditHooks(app: FastifyInstance, recorder: AuditRecorder): void {
  app.addHook('onSend', async (request, reply, payload) => {
    if (reply.statusCode < 200 || reply.statusCode >= 300) return payload;
    const rule = RULES[`${request.method} ${request.routeOptions.url}`];
    const token = bearer(request);
    if (!rule || !token) return payload;
    const params = asRecord(request.params) as Params;
    const body = asRecord(request.body);
    const action = rule.action(body);
    const organizationId = params.organizationId;
    if (!action || !organizationId) return payload;
    const event: AuditEvent = {
      organizationId, action, targetType: rule.targetType, targetId: rule.target(params) ?? null,
      metadata: rule.metadata(params, body, asRecord(request.query) as Params), requestId: request.id, ip: request.ip,
    };
    await recorder.record(token, event);
    return payload;
  });
}
