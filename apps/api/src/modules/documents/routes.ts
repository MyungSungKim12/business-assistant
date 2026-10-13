import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiFailure } from '../../errors.js';
import { bearerToken } from '../../routes/organizations.js';
import { type DocumentGateway } from './gateway.js';

export type OrgAccess = Pick<{ requireAccess(token: string, id: string, feature: string, write?: boolean): Promise<string> }, 'requireAccess'>;

const DOCUMENT_FEATURE = 'document.template';
const CRM_FEATURE = 'crm.basic';
const FILE_FEATURE = 'files.basic';
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const TEXT_LIMIT = 100_000;
const base = '/api/v1/organizations/:organizationId';

// ---------- 요청 스키마 ----------
const orgParams = z.object({ organizationId: z.uuid() });
const templateParams = orgParams.extend({ templateId: z.uuid() });
const documentParams = orgParams.extend({ documentId: z.uuid() });
const treatmentParams = orgParams.extend({ customerId: z.uuid(), treatmentId: z.uuid() });
const issuedParams = treatmentParams.extend({ documentId: z.uuid() });
const eventParams = issuedParams.extend({ eventId: z.uuid() });
const fileParams = orgParams.extend({ fileId: z.uuid() });

const trimmedName = z.string().transform((value) => value.trim()).pipe(z.string().min(1).max(200));
const bigText = z.string().max(TEXT_LIMIT);
const documentStatus = z.enum(['draft', 'final', 'archived']);
const templateCreate = z.object({ name: trimmedName, description: bigText.default(''), content: bigText.default(''), is_archived: z.boolean().default(false) }).strict();
const templateUpdate = z.object({ name: trimmedName, description: bigText, content: bigText, is_archived: z.boolean() }).partial().strict()
  .refine((value) => Object.keys(value).length > 0, 'at least one template field is required');
const documentCreate = z.object({
  title: trimmedName, content: bigText.default(''), template_id: z.uuid().nullable().default(null), status: documentStatus.default('draft'),
}).strict();
const documentUpdate = z.object({ title: trimmedName, content: bigText, template_id: z.uuid(), status: documentStatus }).partial().strict()
  .refine((value) => Object.keys(value).length > 0, 'at least one document field is required');

const templateFields = z.object({
  name: z.string().min(1).max(200).refine((value) => value.trim() !== '').transform((value) => value.trim()),
  description: bigText, content: bigText,
}).strict();
const templateMutation = z.object({
  operation_id: z.uuid(), expected_revision: z.number().int().min(0), action: z.enum(['create', 'save', 'publish', 'revise', 'retire']), values: templateFields.nullable().default(null),
}).strict().superRefine((value, context) => {
  if ((value.action === 'create' || value.action === 'save') !== (value.values !== null)) context.addIssue({ code: 'custom', message: 'create/save require fields; transitions prohibit fields' });
  if ((value.action === 'create') !== (value.expected_revision === 0)) context.addIssue({ code: 'custom', message: 'only create uses revision zero' });
});

const previewRequest = z.object({ template_id: z.uuid() }).strict();
const issueRequest = z.object({ template_id: z.uuid(), operation_id: z.uuid(), expected_preview: z.record(z.string(), z.unknown()) }).strict();

const nonBlank = (max: number, min = 1) => z.string().min(min).max(max).refine((value) => value.trim() !== '');
const coordinate = z.number().min(0).max(1);
const signatureValues = z.object({
  confirmed: z.literal(true), signer_name: nonBlank(100),
  strokes: z.array(z.array(z.tuple([coordinate, coordinate])).min(1).max(500)).min(1).max(50),
}).strict().superRefine((value, context) => {
  const points = value.strokes.flat();
  if (points.length > 5000) context.addIssue({ code: 'custom', message: 'At most 5000 points allowed' });
  if (new Set(points.map(([x, y]) => `${x},${y}`)).size < 2) context.addIssue({ code: 'custom', message: 'At least two distinct points required' });
});
const deliveryValues = z.object({
  confirmed: z.literal(true), method: z.enum(['paper', 'email', 'sms', 'other']), recipient: nonBlank(200), reference: z.string().max(500), note: z.string().max(2000),
}).strict();
const revocationValues = z.object({ confirmed: z.literal(true), reason: nonBlank(2000) }).strict();
const consentRequest = z.object({
  expected_revision: z.number().int().min(0).max(2147483647), operation_id: z.uuid(), action: z.enum(['sign', 'deliver', 'revoke']), values: z.record(z.string(), z.unknown()),
}).strict().superRefine((value, context) => {
  const schema = { sign: signatureValues, deliver: deliveryValues, revoke: revocationValues }[value.action];
  if (!schema.safeParse(value.values).success) context.addIssue({ code: 'custom', message: 'Invalid values for action' });
});

const fileUpload = z.object({
  original_name: z.string().transform((value) => value.trim()).pipe(z.string().min(1).max(255)),
  content_type: z.string().transform((value) => value.trim()).pipe(z.string().min(1).max(255)),
  size_bytes: z.number().int().min(0).max(MAX_FILE_SIZE),
}).strict();
const archivedFlag = z.string().transform((value) => value.toLowerCase()).pipe(z.enum(['1', 'true', 't', 'yes', 'y', 'on', '0', 'false', 'f', 'no', 'n', 'off', ''])).transform((value) => ['1', 'true', 't', 'yes', 'y', 'on'].includes(value));

export function registerDocumentRoutes(app: FastifyInstance, organizations: OrgAccess | undefined, documents: DocumentGateway | undefined): void {
  function context(request: FastifyRequest) {
    const token = bearerToken(request);
    if (!organizations || !documents) throw new ApiFailure(503, 'Document service unavailable');
    return { token, organizations, documents };
  }
  function parse<S extends z.ZodType>(schema: S, value: unknown, message: string): z.infer<S> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ApiFailure(422, message);
    return parsed.data;
  }
  const params = <S extends z.ZodType>(request: FastifyRequest, schema: S): z.infer<S> => parse(schema, request.params, 'Invalid identifier');
  const scopeOf = (p: z.infer<typeof treatmentParams>) => ({ organizationId: p.organizationId, customerId: p.customerId, treatmentId: p.treatmentId });
  /** 시술 문서·동의 라우트는 crm.basic 과 document.template 모두 필요하다. */
  async function requireTreatmentAccess(c: ReturnType<typeof context>, organizationId: string, write: boolean) {
    await c.organizations.requireAccess(c.token, organizationId, CRM_FEATURE);
    await c.organizations.requireAccess(c.token, organizationId, DOCUMENT_FEATURE, write);
  }

  // ----- 템플릿 -----
  app.get(`${base}/document-templates`, async (request) => {
    const c = context(request), p = params(request, orgParams);
    await c.organizations.requireAccess(c.token, p.organizationId, DOCUMENT_FEATURE);
    return c.documents.listTemplates(c.token, p.organizationId);
  });
  // 예전 직접 생성/수정은 버전 관리 우회가 되므로 막고, 버전 변경 엔드포인트를 안내한다.
  app.post(`${base}/document-templates`, async (request) => {
    const c = context(request), p = params(request, orgParams);
    parse(templateCreate, request.body, 'Invalid template input');
    await c.organizations.requireAccess(c.token, p.organizationId, DOCUMENT_FEATURE, true);
    throw new ApiFailure(409, 'Use the versioned template mutations endpoint');
  });
  app.patch(`${base}/document-templates/:templateId`, async (request) => {
    const c = context(request), p = params(request, templateParams);
    parse(templateUpdate, request.body, 'Invalid template input');
    await c.organizations.requireAccess(c.token, p.organizationId, DOCUMENT_FEATURE, true);
    throw new ApiFailure(409, 'Use the versioned template mutations endpoint');
  });
  app.post(`${base}/document-templates/:templateId/mutations`, async (request) => {
    const c = context(request), p = params(request, templateParams), input = parse(templateMutation, request.body, 'Invalid template mutation');
    await c.organizations.requireAccess(c.token, p.organizationId, DOCUMENT_FEATURE, true);
    return c.documents.mutateTemplate(c.token, p.organizationId, p.templateId, input);
  });
  app.get(`${base}/document-templates/:templateId/versions`, async (request) => {
    const c = context(request), p = params(request, templateParams);
    await c.organizations.requireAccess(c.token, p.organizationId, DOCUMENT_FEATURE);
    return c.documents.listTemplateVersions(c.token, p.organizationId, p.templateId);
  });

  // ----- 문서 -----
  app.get(`${base}/documents`, async (request) => {
    const c = context(request), p = params(request, orgParams);
    await c.organizations.requireAccess(c.token, p.organizationId, DOCUMENT_FEATURE);
    return c.documents.listDocuments(c.token, p.organizationId);
  });
  app.post(`${base}/documents`, async (request, reply) => {
    const c = context(request), p = params(request, orgParams), input = parse(documentCreate, request.body, 'Invalid document request');
    await c.organizations.requireAccess(c.token, p.organizationId, DOCUMENT_FEATURE, true);
    return reply.code(201).send(await c.documents.createDocument(c.token, p.organizationId, input));
  });
  app.patch(`${base}/documents/:documentId`, async (request) => {
    const c = context(request), p = params(request, documentParams), patch = parse(documentUpdate, request.body, 'Invalid document request');
    await c.organizations.requireAccess(c.token, p.organizationId, DOCUMENT_FEATURE, true);
    const saved = await c.documents.updateDocument(c.token, p.organizationId, p.documentId, patch);
    if (!saved) throw new ApiFailure(404, 'Document not found');
    return saved;
  });

  // ----- 시술 문서 미리보기·발행·이력 -----
  const treatmentDocuments = `${base}/customers/:customerId/treatments/:treatmentId/documents`;
  app.post(`${treatmentDocuments}/preview`, async (request) => {
    const c = context(request), p = params(request, treatmentParams), input = parse(previewRequest, request.body, 'Invalid document request');
    await requireTreatmentAccess(c, p.organizationId, false);
    return c.documents.previewTreatmentDocument(c.token, scopeOf(p), input.template_id);
  });
  app.post(treatmentDocuments, async (request, reply) => {
    const c = context(request), p = params(request, treatmentParams), input = parse(issueRequest, request.body, 'Invalid document request');
    await requireTreatmentAccess(c, p.organizationId, true);
    return reply.code(201).send(await c.documents.issueTreatmentDocument(c.token, scopeOf(p), input));
  });
  app.get(treatmentDocuments, async (request) => {
    const c = context(request), p = params(request, treatmentParams);
    await requireTreatmentAccess(c, p.organizationId, false);
    return c.documents.listIssuedTreatmentDocuments(c.token, scopeOf(p));
  });

  // ----- 동의서 서명·교부·철회 이력 -----
  const consentEvents = `${treatmentDocuments}/:documentId/events`;
  app.get(consentEvents, async (request) => {
    const c = context(request), p = params(request, issuedParams);
    await requireTreatmentAccess(c, p.organizationId, false);
    return c.documents.listConsentEvents(c.token, scopeOf(p), p.documentId);
  });
  app.post(consentEvents, async (request, reply) => {
    const c = context(request), p = params(request, issuedParams), input = parse(consentRequest, request.body, 'Invalid document consent request');
    await requireTreatmentAccess(c, p.organizationId, true);
    return reply.code(201).send(await c.documents.recordConsentEvent(c.token, scopeOf(p), p.documentId, input));
  });

  // 증빙 해시를 지금 이벤트 행으로 다시 계산해 저장값과 일치하는지 알려 준다(읽기 전용).
  app.get(`${consentEvents}/:eventId/verify`, async (request) => {
    const c = context(request), p = params(request, eventParams);
    await requireTreatmentAccess(c, p.organizationId, false);
    return c.documents.verifyConsentEvent(c.token, scopeOf(p), p.documentId, p.eventId);
  });

  // ----- 파일 자료(멤버 누구나 목록·업로드·다운로드, 보관은 owner/admin) -----
  app.get(`${base}/files`, async (request) => {
    const c = context(request), p = params(request, orgParams);
    const query = parse(z.object({ include_archived: archivedFlag.default(false) }), request.query, 'Invalid file request');
    await c.organizations.requireAccess(c.token, p.organizationId, FILE_FEATURE);
    return c.documents.listFiles(c.token, p.organizationId, query.include_archived);
  });
  app.post(`${base}/files/upload-url`, async (request, reply) => {
    const c = context(request), p = params(request, orgParams), input = parse(fileUpload, request.body, 'Invalid file request');
    await c.organizations.requireAccess(c.token, p.organizationId, FILE_FEATURE);
    return reply.code(201).send(await c.documents.createFileUpload(c.token, p.organizationId, input));
  });
  app.post(`${base}/files/:fileId/download-url`, async (request) => {
    const c = context(request), p = params(request, fileParams);
    await c.organizations.requireAccess(c.token, p.organizationId, FILE_FEATURE);
    return c.documents.createFileDownload(c.token, p.organizationId, p.fileId);
  });
  app.delete(`${base}/files/:fileId`, async (request) => {
    const c = context(request), p = params(request, fileParams);
    await c.organizations.requireAccess(c.token, p.organizationId, FILE_FEATURE, true);
    const archived = await c.documents.archiveFile(c.token, p.organizationId, p.fileId);
    if (!archived) throw new ApiFailure(404, 'File not found');
    return archived;
  });
}
