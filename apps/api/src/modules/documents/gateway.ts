import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ServerConfig } from '../../config.js';
import { ApiFailure } from '../../errors.js';
import { createDocumentHttp, type ErrorMessages } from './http.js';

// ---------- 스키마(게이트웨이 반환·응답 형식) ----------
export const templateSchema = z.object({
  id: z.uuid(), organization_id: z.uuid(), created_by: z.uuid(), name: z.string(), description: z.string(), content: z.string(), is_archived: z.boolean(),
  created_at: z.string(), updated_at: z.string(), status: z.string().default('draft'), version: z.number().int().default(1), revision: z.number().int().default(1),
});
export const documentSchema = z.object({
  id: z.uuid(), organization_id: z.uuid(), template_id: z.uuid().nullable(), created_by: z.uuid(), title: z.string(), content: z.string(), status: z.string(),
  created_at: z.string(), updated_at: z.string(),
});
export const templateVersionSchema = z.object({
  template_id: z.uuid(), organization_id: z.uuid(), version: z.number().int(), name: z.string(), description: z.string(), content: z.string(),
  published_by: z.uuid(), published_at: z.string(),
});
export const previewSchema = z.object({
  template_id: z.uuid(), template_version: z.number().int(), title: z.string(), content: z.string(), source_snapshot: z.record(z.string(), z.unknown()),
  missing_fields: z.array(z.string()),
});
export const issuedSchema = z.object({
  id: z.uuid(), organization_id: z.uuid(), customer_id: z.uuid(), treatment_id: z.uuid(), template_id: z.uuid(), template_version: z.number().int(),
  title: z.string(), content: z.string(), source_snapshot: z.record(z.string(), z.unknown()), issued_by: z.uuid(), issued_at: z.string(),
});
// operation_id / request_fingerprint 는 일부러 파싱에서 제외한다(재시도 메타데이터 비노출).
export const consentEventSchema = z.object({
  id: z.uuid(), organization_id: z.uuid(), document_id: z.uuid(), revision: z.number().int().min(1), action: z.enum(['sign', 'deliver', 'revoke']),
  values: z.record(z.string(), z.unknown()), actor_id: z.uuid(), occurred_at: z.string(), content_hash: z.string(),
});
const fileRowSchema = z.object({
  id: z.uuid(), organization_id: z.uuid(), uploaded_by: z.uuid(), storage_path: z.string(), original_name: z.string(), content_type: z.string(),
  size_bytes: z.number().int(), is_archived: z.boolean(), created_at: z.string(), updated_at: z.string(),
});
export const fileSchema = fileRowSchema.omit({ storage_path: true });

export type DocumentTemplate = z.infer<typeof templateSchema>;
export type DocumentRecord = z.infer<typeof documentSchema>;
export type TemplateVersion = z.infer<typeof templateVersionSchema>;
export type TreatmentPreview = z.infer<typeof previewSchema>;
export type IssuedTreatmentDocument = z.infer<typeof issuedSchema>;
export type ConsentEvent = z.infer<typeof consentEventSchema>;
export type FileAsset = z.infer<typeof fileSchema>;
export type SignedFile = { file: FileAsset; signed_url: string; expires_in: number };

export type TemplateMutationInput = { operation_id: string; expected_revision: number; action: 'create' | 'save' | 'publish' | 'revise' | 'retire'; values: { name: string; description: string; content: string } | null };
export type DocumentCreateInput = { title: string; content: string; template_id: string | null; status: 'draft' | 'final' | 'archived' };
export type DocumentUpdateInput = Partial<{ title: string; content: string; template_id: string; status: 'draft' | 'final' | 'archived' }>;
export type ConsentInput = { expected_revision: number; operation_id: string; action: 'sign' | 'deliver' | 'revoke'; values: Record<string, unknown> };
export type FileUploadInput = { original_name: string; content_type: string; size_bytes: number };
export type TreatmentScope = { organizationId: string; customerId: string; treatmentId: string };

export const UPLOAD_EXPIRES_IN = 600;
export const DOWNLOAD_EXPIRES_IN = 300;

export type DocumentGateway = {
  listTemplates(token: string, organizationId: string): Promise<DocumentTemplate[]>;
  mutateTemplate(token: string, organizationId: string, templateId: string, input: TemplateMutationInput): Promise<DocumentTemplate>;
  listTemplateVersions(token: string, organizationId: string, templateId: string): Promise<TemplateVersion[]>;
  listDocuments(token: string, organizationId: string): Promise<DocumentRecord[]>;
  createDocument(token: string, organizationId: string, input: DocumentCreateInput): Promise<DocumentRecord>;
  updateDocument(token: string, organizationId: string, documentId: string, patch: DocumentUpdateInput): Promise<DocumentRecord | null>;
  previewTreatmentDocument(token: string, scope: TreatmentScope, templateId: string): Promise<TreatmentPreview>;
  issueTreatmentDocument(token: string, scope: TreatmentScope, input: { template_id: string; operation_id: string; expected_preview: Record<string, unknown> }): Promise<IssuedTreatmentDocument>;
  listIssuedTreatmentDocuments(token: string, scope: TreatmentScope): Promise<IssuedTreatmentDocument[]>;
  listConsentEvents(token: string, scope: TreatmentScope, documentId: string): Promise<ConsentEvent[]>;
  recordConsentEvent(token: string, scope: TreatmentScope, documentId: string, input: ConsentInput): Promise<ConsentEvent>;
  listFiles(token: string, organizationId: string, includeArchived: boolean): Promise<FileAsset[]>;
  createFileUpload(token: string, organizationId: string, input: FileUploadInput): Promise<SignedFile>;
  createFileDownload(token: string, organizationId: string, fileId: string): Promise<SignedFile>;
  archiveFile(token: string, organizationId: string, fileId: string): Promise<FileAsset | null>;
};

const documentMessages: ErrorMessages = { invalid: 'Invalid document request', unavailable: 'Document service unavailable' };
const templateMessages: ErrorMessages = {
  conflict: 'Template changed or transition is not allowed', notFound: 'Template not found', forbidden: 'Template management permission required',
  invalid: 'Invalid template fields or empty publication', unavailable: 'Template service unavailable',
};
const issuanceMessages: ErrorMessages = {
  conflict: 'Preview changed or operation conflicts; review again', notFound: 'Customer, treatment or published template not found',
  forbidden: 'Document access permission required', invalid: 'Invalid document request or missing template values', unavailable: 'Document service unavailable',
};
const consentMessages: ErrorMessages = {
  conflict: 'Document state changed or operation conflicts; reload', notFound: 'Issued document not found', forbidden: 'Document access permission required',
  invalid: 'Invalid document consent request', unavailable: 'Document consent service unavailable',
};
const fileMessages: ErrorMessages = { invalid: 'Invalid file request', unavailable: 'File service unavailable' };

/** 저장 경로용 파일명: 영숫자·점·밑줄·하이픈만 남긴다(표시용 원본 이름은 DB에 그대로 보관). */
export function safeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '');
  return (cleaned || 'file').slice(0, 180);
}

export function createDocumentGateway(config: ServerConfig, fetcher: typeof fetch = fetch): DocumentGateway {
  const http = createDocumentHttp(config, fetcher);

  function parseRows<T>(rows: unknown, schema: z.ZodType<T>, messages: ErrorMessages): T[] {
    const parsed = z.array(schema).safeParse(rows);
    if (!parsed.success) throw new ApiFailure(503, messages.unavailable);
    return parsed.data;
  }
  function inOrganization<T extends { organization_id: string }>(rows: T[], organizationId: string, messages: ErrorMessages): T[] {
    if (rows.some((row) => row.organization_id !== organizationId)) throw new ApiFailure(503, messages.unavailable);
    return rows;
  }
  const exactlyOne = <T>(rows: T[], messages: ErrorMessages): T => {
    if (rows.length !== 1) throw new ApiFailure(503, messages.unavailable);
    return rows[0];
  };
  const eq = (value: string) => `eq.${value}`;

  async function requireParent(token: string, table: string, query: Record<string, string>, id: string, messages: ErrorMessages): Promise<void> {
    const parent = await http.request(token, 'GET', `/rest/v1/${table}`, messages, { query: { ...query, select: 'id' }, mapCodes: true });
    if (!Array.isArray(parent)) throw new ApiFailure(503, messages.unavailable);
    if (parent.length === 0) throw new ApiFailure(404, messages.notFound ?? 'Not found');
    const only = parent[0] as { id?: unknown } | null;
    if (parent.length !== 1 || typeof only !== 'object' || only === null || only.id !== id) throw new ApiFailure(503, messages.unavailable);
  }

  async function listIssuedRows(token: string, scope: TreatmentScope): Promise<IssuedTreatmentDocument[]> {
    // 접근 불가/불일치 상위 레코드를 빈 이력과 구분한다.
    await requireParent(token, 'treatment_records', { organization_id: eq(scope.organizationId), customer_id: eq(scope.customerId), id: eq(scope.treatmentId) }, scope.treatmentId, issuanceMessages);
    const rows = await http.request(token, 'GET', '/rest/v1/issued_treatment_documents', issuanceMessages, {
      query: { organization_id: eq(scope.organizationId), customer_id: eq(scope.customerId), treatment_id: eq(scope.treatmentId), order: 'issued_at.desc,id.desc' }, mapCodes: true,
    });
    return inOrganization(parseRows(rows, issuedSchema, issuanceMessages), scope.organizationId, issuanceMessages);
  }

  async function getFile(token: string, organizationId: string, fileId: string): Promise<z.infer<typeof fileRowSchema> | null> {
    const rows = parseRows(await http.request(token, 'GET', '/rest/v1/file_assets', fileMessages, { query: { id: eq(fileId), organization_id: eq(organizationId) } }), fileRowSchema, fileMessages);
    inOrganization(rows, organizationId, fileMessages);
    return rows[0] ?? null;
  }
  const publicFile = (row: z.infer<typeof fileRowSchema>): FileAsset => fileSchema.parse(row);

  return {
    async listTemplates(token, organizationId) {
      const rows = await http.request(token, 'GET', '/rest/v1/document_templates', documentMessages, { query: { organization_id: eq(organizationId) }, badRequestIsInvalid: true });
      return inOrganization(parseRows(rows, templateSchema, documentMessages), organizationId, documentMessages);
    },
    async mutateTemplate(token, organizationId, templateId, input) {
      const rows = await http.request(token, 'POST', '/rest/v1/rpc/mutate_document_template', templateMessages, {
        body: {
          p_organization_id: organizationId, p_template_id: templateId, p_expected_revision: input.expected_revision, p_operation_id: input.operation_id,
          p_action: input.action, p_values: input.values ?? {},
        }, mapCodes: true, badRequestIsInvalid: true,
      });
      if (!Array.isArray(rows) || rows.length === 0) throw new ApiFailure(503, templateMessages.unavailable);
      return inOrganization(parseRows(rows.slice(0, 1), templateSchema, templateMessages), organizationId, templateMessages)[0];
    },
    async listTemplateVersions(token, organizationId, templateId) {
      const rows = await http.request(token, 'GET', '/rest/v1/document_template_versions', templateMessages, {
        query: { organization_id: eq(organizationId), template_id: eq(templateId), order: 'version.desc' },
      });
      return inOrganization(parseRows(rows, templateVersionSchema, templateMessages), organizationId, templateMessages);
    },
    async listDocuments(token, organizationId) {
      const rows = await http.request(token, 'GET', '/rest/v1/documents', documentMessages, { query: { organization_id: eq(organizationId) }, badRequestIsInvalid: true });
      return inOrganization(parseRows(rows, documentSchema, documentMessages), organizationId, documentMessages);
    },
    async createDocument(token, organizationId, input) {
      const createdBy = await http.userId(token, documentMessages);
      const rows = await http.request(token, 'POST', '/rest/v1/documents', documentMessages, {
        query: { select: '*' }, body: { ...input, organization_id: organizationId, created_by: createdBy }, representation: true, badRequestIsInvalid: true,
      });
      return inOrganization([exactlyOne(parseRows(rows, documentSchema, documentMessages).slice(0, 1), documentMessages)], organizationId, documentMessages)[0];
    },
    async updateDocument(token, organizationId, documentId, patch) {
      const rows = await http.request(token, 'PATCH', '/rest/v1/documents', documentMessages, {
        query: { select: '*', id: eq(documentId), organization_id: eq(organizationId) }, body: patch, representation: true, badRequestIsInvalid: true,
      });
      const parsed = inOrganization(parseRows(rows, documentSchema, documentMessages), organizationId, documentMessages);
      return parsed[0] ?? null;
    },
    async previewTreatmentDocument(token, scope, templateId) {
      const payload = await http.request(token, 'POST', '/rest/v1/rpc/preview_treatment_document', issuanceMessages, {
        body: { p_organization_id: scope.organizationId, p_customer_id: scope.customerId, p_treatment_id: scope.treatmentId, p_template_id: templateId }, mapCodes: true,
      });
      const parsed = previewSchema.safeParse(payload);
      if (!parsed.success) throw new ApiFailure(503, issuanceMessages.unavailable);
      return parsed.data;
    },
    async issueTreatmentDocument(token, scope, input) {
      const payload = await http.request(token, 'POST', '/rest/v1/rpc/issue_treatment_document', issuanceMessages, {
        body: {
          p_organization_id: scope.organizationId, p_customer_id: scope.customerId, p_treatment_id: scope.treatmentId, p_template_id: input.template_id,
          p_operation_id: input.operation_id, p_expected_preview: input.expected_preview,
        }, mapCodes: true,
      });
      if (!Array.isArray(payload) || payload.length !== 1) throw new ApiFailure(503, issuanceMessages.unavailable);
      return inOrganization(parseRows(payload, issuedSchema, issuanceMessages), scope.organizationId, issuanceMessages)[0];
    },
    listIssuedTreatmentDocuments: listIssuedRows,
    async listConsentEvents(token, scope, documentId) {
      await requireParent(token, 'issued_treatment_documents', {
        organization_id: eq(scope.organizationId), customer_id: eq(scope.customerId), treatment_id: eq(scope.treatmentId), id: eq(documentId),
      }, documentId, consentMessages);
      const events: ConsentEvent[] = [];
      for (;;) {
        const payload = await http.request(token, 'GET', '/rest/v1/treatment_document_events', consentMessages, {
          query: { organization_id: eq(scope.organizationId), document_id: eq(documentId), order: 'revision.asc', limit: '250', offset: String(events.length) }, mapCodes: true,
        });
        const page = inOrganization(parseRows(payload, consentEventSchema, consentMessages), scope.organizationId, consentMessages);
        if (page.some((event, index) => event.revision !== events.length + index + 1 || event.document_id !== documentId)) throw new ApiFailure(503, consentMessages.unavailable);
        events.push(...page);
        if (page.length < 250) return events;
      }
    },
    async recordConsentEvent(token, scope, documentId, input) {
      const payload = await http.request(token, 'POST', '/rest/v1/rpc/record_treatment_document_event', consentMessages, {
        body: {
          p_organization_id: scope.organizationId, p_customer_id: scope.customerId, p_treatment_id: scope.treatmentId, p_document_id: documentId,
          p_expected_revision: input.expected_revision, p_operation_id: input.operation_id, p_action: input.action, p_values: input.values,
        }, mapCodes: true,
      });
      if (!Array.isArray(payload) || payload.length !== 1) throw new ApiFailure(503, consentMessages.unavailable);
      return inOrganization(parseRows(payload, consentEventSchema, consentMessages), scope.organizationId, consentMessages)[0];
    },
    async listFiles(token, organizationId, includeArchived) {
      const query: Record<string, string> = { organization_id: eq(organizationId), order: 'created_at.desc' };
      if (!includeArchived) query.is_archived = 'eq.false';
      const rows = await http.request(token, 'GET', '/rest/v1/file_assets', fileMessages, { query, badRequestIsInvalid: true });
      return inOrganization(parseRows(rows, fileRowSchema, fileMessages), organizationId, fileMessages).map(publicFile);
    },
    async createFileUpload(token, organizationId, input) {
      const uploadedBy = await http.userId(token, fileMessages);
      const id = randomUUID();
      const path = `${organizationId}/${id}-${safeFilename(input.original_name)}`;
      const rows = await http.request(token, 'POST', '/rest/v1/file_assets', fileMessages, {
        query: { select: '*' }, representation: true, badRequestIsInvalid: true,
        body: { id, storage_path: path, original_name: input.original_name, content_type: input.content_type, size_bytes: input.size_bytes, organization_id: organizationId, uploaded_by: uploadedBy },
      });
      const row = exactlyOne(inOrganization(parseRows(rows, fileRowSchema, fileMessages), organizationId, fileMessages).slice(0, 1), fileMessages);
      try {
        const url = await http.signedUrl(token, `object/upload/sign/${config.APP_FILE_BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`, {}, fileMessages);
        return { file: publicFile(row), signed_url: url, expires_in: UPLOAD_EXPIRES_IN };
      } catch (error) {
        // 업로드 URL을 못 받았으면 방금 만든 메타데이터 행을 보관 처리해 고아 행이 목록에 남지 않게 한다.
        await http.request(token, 'PATCH', '/rest/v1/file_assets', fileMessages, { query: { id: eq(id), organization_id: eq(organizationId) }, body: { is_archived: true } }).catch(() => undefined);
        throw error;
      }
    },
    async createFileDownload(token, organizationId, fileId) {
      const row = await getFile(token, organizationId, fileId);
      if (!row || row.is_archived) throw new ApiFailure(404, 'File not found');
      const url = await http.signedUrl(token, `object/sign/${config.APP_FILE_BUCKET}/${row.storage_path.split('/').map(encodeURIComponent).join('/')}`, { expiresIn: DOWNLOAD_EXPIRES_IN }, fileMessages);
      return { file: publicFile(row), signed_url: url, expires_in: DOWNLOAD_EXPIRES_IN };
    },
    async archiveFile(token, organizationId, fileId) {
      const rows = await http.request(token, 'PATCH', '/rest/v1/file_assets', fileMessages, {
        query: { select: '*', id: eq(fileId), organization_id: eq(organizationId) }, body: { is_archived: true }, representation: true, badRequestIsInvalid: true,
      });
      const parsed = inOrganization(parseRows(rows, fileRowSchema, fileMessages), organizationId, fileMessages);
      return parsed[0] ? publicFile(parsed[0]) : null;
    },
  };
}
