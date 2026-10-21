import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ServerConfig } from '../../config.js';
import { ApiFailure } from '../../errors.js';
import { createRest } from '../../supabase/rest.js';
import { computeEvidenceHash, embeddedProofSchema, EVIDENCE_ALGORITHM, evidenceInputOf, storedEvidenceOf, verifyEvidence, type EvidenceVerification } from './evidence.js';
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
// proof 는 증빙 해시 테이블(043) 임베드이며, 응답에는 evidence 로 바꿔 싣는다(증빙이 없던 옛 이벤트는 null).
const consentRowSchema = z.object({
  id: z.uuid(), organization_id: z.uuid(), document_id: z.uuid(), revision: z.number().int().min(1), action: z.enum(['sign', 'deliver', 'revoke']),
  values: z.record(z.string(), z.unknown()), actor_id: z.uuid(), occurred_at: z.string(), content_hash: z.string(), proof: embeddedProofSchema,
});
export const consentEventSchema = consentRowSchema.transform(({ proof, ...event }) => ({ ...event, evidence: storedEvidenceOf(proof) }));
const fileRowSchema = z.object({
  id: z.uuid(), organization_id: z.uuid(), uploaded_by: z.uuid(), storage_path: z.string(), original_name: z.string(), content_type: z.string(),
  size_bytes: z.number().int(), version_number: z.number().int().positive().default(1), is_archived: z.boolean(), created_at: z.string(), updated_at: z.string(), folder_id:z.uuid().nullable().default(null), tags:z.array(z.string()).max(10).default([]),
});
export const fileSchema = fileRowSchema.omit({ storage_path: true });
export const fileVersionSchema = z.object({ id:z.uuid(),organization_id:z.uuid(),file_id:z.uuid(),version_number:z.number().int().positive(),original_name:z.string(),content_type:z.string(),size_bytes:z.number().int(),uploaded_by:z.uuid(),created_at:z.string() });
export const fileStorageUsageSchema=z.object({organization_id:z.uuid(),used_bytes:z.number().int().nonnegative(),reserved_bytes:z.number().int().nonnegative(),organization_quota_bytes:z.number().int().nonnegative(),plan_quota_bytes:z.number().int().nonnegative().nullable(),quota_bytes:z.number().int().nonnegative(),available_bytes:z.number().int().nonnegative()});
const storedFileVersionSchema = fileVersionSchema.extend({ storage_path:z.string() });
const folderSchema=z.object({id:z.uuid(),organization_id:z.uuid(),name:z.string(),created_by:z.uuid(),created_at:z.string()});

export type DocumentTemplate = z.infer<typeof templateSchema>;
export type DocumentRecord = z.infer<typeof documentSchema>;
export type TemplateVersion = z.infer<typeof templateVersionSchema>;
export type TreatmentPreview = z.infer<typeof previewSchema>;
export type IssuedTreatmentDocument = z.infer<typeof issuedSchema>;
export type ConsentEvent = z.infer<typeof consentEventSchema>;
export type FileAsset = z.infer<typeof fileSchema>;
export type SignedFile = { file: FileAsset; signed_url: string; expires_in: number };
export type SignedUploadFile = SignedFile & { reservation_id:string };

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
  verifyConsentEvent(token: string, scope: TreatmentScope, documentId: string, eventId: string): Promise<EvidenceVerification>;
  listFiles(token: string, organizationId: string, includeArchived: boolean): Promise<FileAsset[]>;
  fileStorageUsage(token:string,organizationId:string):Promise<z.infer<typeof fileStorageUsageSchema>>;
  setFileStorageQuota(token:string,organizationId:string,quotaBytes:number):Promise<z.infer<typeof fileStorageUsageSchema>>;
  listFileFolders(token:string,organizationId:string):Promise<z.infer<typeof folderSchema>[]>;
  createFileFolder(token:string,organizationId:string,name:string):Promise<z.infer<typeof folderSchema>>;
  deleteFileFolder(token:string,organizationId:string,folderId:string):Promise<boolean>;
  updateFileMetadata(token:string,organizationId:string,fileId:string,folderId:string|null,tags:string[]):Promise<FileAsset|null>;
  createFileUpload(token: string, organizationId: string, input: FileUploadInput): Promise<SignedUploadFile>;
  completeFileUpload(token:string,organizationId:string,fileId:string,operationId:string):Promise<FileAsset>;
  releaseFileUpload(token:string,organizationId:string,operationId:string):Promise<boolean>;
  listFileVersions(token: string, organizationId: string, fileId: string): Promise<z.infer<typeof fileVersionSchema>[]>;
  createFileVersion(token: string, organizationId: string, fileId: string, expectedVersion: number, input: FileUploadInput): Promise<SignedFile & { version_upload_path: string; version_operation_id: string }>;
  commitFileVersion(token: string, organizationId: string, fileId: string, expectedVersion: number, operationId: string, path: string, input: FileUploadInput): Promise<FileAsset>;
  createFileVersionDownload(token: string, organizationId: string, fileId: string, version: number): Promise<SignedFile>;
  createFileDownload(token: string, organizationId: string, fileId: string): Promise<SignedFile>;
  archiveFile(token: string, organizationId: string, fileId: string): Promise<FileAsset | null>;
};

const eventSelect = '*,proof:treatment_document_event_proofs(algorithm,evidence_hash)';
type StoredEvidenceView = { algorithm: string; hash: string };

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
  const fileLists = createRest(config, fetcher, fileMessages.unavailable);
  const issuanceLists = createRest(config, fetcher, issuanceMessages.unavailable);
  const consentLists = createRest(config, fetcher, consentMessages.unavailable);

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
    const rows = inOrganization(await issuanceLists.selectAll(token, 'issued_treatment_documents', {
      organization_id: eq(scope.organizationId), customer_id: eq(scope.customerId), treatment_id: eq(scope.treatmentId), order: 'issued_at.desc,id.desc',
    }, issuedSchema), scope.organizationId, issuanceMessages);
    if (rows.some(row => row.customer_id !== scope.customerId || row.treatment_id !== scope.treatmentId)) throw new ApiFailure(503, issuanceMessages.unavailable);
    return rows;
  }

  async function getFile(token: string, organizationId: string, fileId: string): Promise<z.infer<typeof fileRowSchema> | null> {
    const rows = parseRows(await http.request(token, 'GET', '/rest/v1/file_assets', fileMessages, { query: { id: eq(fileId), organization_id: eq(organizationId) } }), fileRowSchema, fileMessages);
    inOrganization(rows, organizationId, fileMessages);
    return rows[0] ?? null;
  }
  /**
   * 방금 기록된 이벤트의 증빙 해시를 계산해 저장한다. 증빙 저장이 실패해도 이벤트 자체는 이미 확정되어 있으므로
   * 오류를 올리지 않고 evidence 를 null 로 돌려준다(나중에 "무결성 확인"에서 증빙 없음으로 표시된다).
   * 같은 operation_id 재시도는 on_conflict 로 무시되어 증빙이 한 번만 남는다.
   */
  async function storeEvidence(token: string, event: z.infer<typeof consentEventSchema>): Promise<StoredEvidenceView | null> {
    const hash = computeEvidenceHash(evidenceInputOf({ ...event, event_id: event.id }));
    try {
      await http.request(token, 'POST', '/rest/v1/treatment_document_event_proofs', consentMessages, {
        query: { on_conflict: 'event_id' }, prefer: 'resolution=ignore-duplicates,return=minimal',
        body: { event_id: event.id, organization_id: event.organization_id, document_id: event.document_id, algorithm: EVIDENCE_ALGORITHM, evidence_hash: hash },
      });
      return { algorithm: EVIDENCE_ALGORITHM, hash };
    } catch {
      return event.evidence;
    }
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
      const events = inOrganization(await consentLists.selectAll(token, 'treatment_document_events', {
        select: eventSelect, organization_id: eq(scope.organizationId), document_id: eq(documentId), order: 'revision.asc,id.asc',
      }, consentEventSchema), scope.organizationId, consentMessages);
      if (events.some((event, index) => event.revision !== index + 1 || event.document_id !== documentId)) throw new ApiFailure(503, consentMessages.unavailable);
      return events;
    },
    async recordConsentEvent(token, scope, documentId, input) {
      const payload = await http.request(token, 'POST', '/rest/v1/rpc/record_treatment_document_event', consentMessages, {
        body: {
          p_organization_id: scope.organizationId, p_customer_id: scope.customerId, p_treatment_id: scope.treatmentId, p_document_id: documentId,
          p_expected_revision: input.expected_revision, p_operation_id: input.operation_id, p_action: input.action, p_values: input.values,
        }, mapCodes: true,
      });
      if (!Array.isArray(payload) || payload.length !== 1) throw new ApiFailure(503, consentMessages.unavailable);
      const event = inOrganization(parseRows(payload, consentEventSchema, consentMessages), scope.organizationId, consentMessages)[0];
      return { ...event, evidence: await storeEvidence(token, event) };
    },
    async verifyConsentEvent(token, scope, documentId, eventId) {
      await requireParent(token, 'issued_treatment_documents', {
        organization_id: eq(scope.organizationId), customer_id: eq(scope.customerId), treatment_id: eq(scope.treatmentId), id: eq(documentId),
      }, documentId, consentMessages);
      const payload = await http.request(token, 'GET', '/rest/v1/treatment_document_events', consentMessages, {
        query: { select: eventSelect, organization_id: eq(scope.organizationId), document_id: eq(documentId), id: eq(eventId), limit: '2' }, mapCodes: true,
      });
      const rows = inOrganization(parseRows(payload, consentEventSchema, consentMessages), scope.organizationId, consentMessages);
      if (rows.length === 0) throw new ApiFailure(404, consentMessages.notFound ?? 'Not found');
      if (rows.length !== 1 || rows[0].id !== eventId || rows[0].document_id !== documentId) throw new ApiFailure(503, consentMessages.unavailable);
      const event = rows[0];
      return verifyEvidence(evidenceInputOf({ ...event, event_id: event.id }), event.evidence);
    },
    async listFiles(token, organizationId, includeArchived) {
      const query: Record<string, string> = { organization_id: eq(organizationId), order: 'created_at.desc,id.desc' };
      if (!includeArchived) query.is_archived = 'eq.false';
      const rows = await fileLists.selectAll(token, 'file_assets', query, fileRowSchema);
      return inOrganization(rows, organizationId, fileMessages).map(publicFile);
    },
    async fileStorageUsage(token,organizationId){
      const payload=await http.request(token,'POST','/rest/v1/rpc/get_file_storage_usage',fileMessages,{body:{p_organization_id:organizationId},mapCodes:true});
      const parsed=fileStorageUsageSchema.safeParse(payload);if(!parsed.success||parsed.data.organization_id!==organizationId)throw new ApiFailure(503,fileMessages.unavailable);return parsed.data;
    },
    async setFileStorageQuota(token,organizationId,quotaBytes){
      const payload=await http.request(token,'POST','/rest/v1/rpc/set_organization_file_storage_quota',fileMessages,{body:{p_organization_id:organizationId,p_quota_bytes:quotaBytes},mapCodes:true});
      const parsed=fileStorageUsageSchema.safeParse(payload);if(!parsed.success||parsed.data.organization_id!==organizationId||parsed.data.organization_quota_bytes!==quotaBytes)throw new ApiFailure(503,fileMessages.unavailable);return parsed.data;
    },
    async listFileFolders(token,organizationId){
      const rows=await fileLists.selectAll(token,'file_folders',{organization_id:eq(organizationId),order:'name.asc,id.asc'},folderSchema);
      return inOrganization(rows,organizationId,fileMessages);
    },
    async createFileFolder(token,organizationId,name){
      const uploadedBy=await http.userId(token,fileMessages);
      const rows=await http.request(token,'POST','/rest/v1/file_folders',fileMessages,{query:{select:'*'},body:{organization_id:organizationId,name,created_by:uploadedBy},representation:true,badRequestIsInvalid:true});
      return exactlyOne(inOrganization(parseRows(rows,folderSchema,fileMessages),organizationId,fileMessages),fileMessages);
    },
    async deleteFileFolder(token,organizationId,folderId){
      const rows=await http.request(token,'DELETE','/rest/v1/file_folders',fileMessages,{query:{id:eq(folderId),organization_id:eq(organizationId),select:'id'},representation:true,badRequestIsInvalid:true});
      return Array.isArray(rows)&&rows.length===1;
    },
    async updateFileMetadata(token,organizationId,fileId,folderId,tags){
      const rows=await http.request(token,'PATCH','/rest/v1/file_assets',fileMessages,{query:{id:eq(fileId),organization_id:eq(organizationId),select:'*'},body:{folder_id:folderId,tags},representation:true,badRequestIsInvalid:true});
      const parsed=inOrganization(parseRows(rows,fileRowSchema,fileMessages),organizationId,fileMessages);return parsed[0]?publicFile(parsed[0]):null;
    },
    async createFileUpload(token, organizationId, input) {
      const uploadedBy = await http.userId(token, fileMessages);
      const id = randomUUID();
      const reservationId=randomUUID();
      const path = `${organizationId}/${id}-${safeFilename(input.original_name)}`;
      await http.request(token,'POST','/rest/v1/rpc/reserve_file_storage_upload',fileMessages,{body:{p_organization_id:organizationId,p_operation_id:reservationId,p_storage_path:path,p_size_bytes:input.size_bytes},mapCodes:true,badRequestIsInvalid:true});
      try {
        const rows = await http.request(token, 'POST', '/rest/v1/file_assets', fileMessages, {
          query: { select: '*' }, representation: true, badRequestIsInvalid: true,
          body: { id, storage_path: path, original_name: input.original_name, content_type: input.content_type, size_bytes: input.size_bytes, organization_id: organizationId, uploaded_by: uploadedBy },
        });
        const row = exactlyOne(inOrganization(parseRows(rows, fileRowSchema, fileMessages), organizationId, fileMessages).slice(0, 1), fileMessages);
        const url = await http.signedUrl(token, `object/upload/sign/${config.APP_FILE_BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`, {}, fileMessages);
        return { file: publicFile(row), signed_url: url, expires_in: UPLOAD_EXPIRES_IN, reservation_id:reservationId };
      } catch (error) {
        // 업로드 URL을 못 받았으면 방금 만든 메타데이터 행을 보관 처리해 고아 행이 목록에 남지 않게 한다.
        await http.request(token, 'PATCH', '/rest/v1/file_assets', fileMessages, { query: { id: eq(id), organization_id: eq(organizationId) }, body: { is_archived: true } }).catch(() => undefined);
        await http.request(token,'POST','/rest/v1/rpc/release_file_storage_upload',fileMessages,{body:{p_organization_id:organizationId,p_operation_id:reservationId},mapCodes:true}).catch(()=>undefined);
        throw error;
      }
    },
    async completeFileUpload(token,organizationId,fileId,operationId){
      const payload=await http.request(token,'POST','/rest/v1/rpc/complete_file_upload',fileMessages,{body:{p_organization_id:organizationId,p_file_id:fileId,p_operation_id:operationId},mapCodes:true});
      const parsed=fileRowSchema.safeParse(payload);if(!parsed.success||parsed.data.organization_id!==organizationId||parsed.data.id!==fileId)throw new ApiFailure(503,fileMessages.unavailable);return publicFile(parsed.data);
    },
    async releaseFileUpload(token,organizationId,operationId){
      const payload=await http.request(token,'POST','/rest/v1/rpc/release_file_storage_upload',fileMessages,{body:{p_organization_id:organizationId,p_operation_id:operationId},mapCodes:true});
      if(typeof payload!=='object'||payload===null||typeof (payload as {released?:unknown}).released!=='boolean')throw new ApiFailure(503,fileMessages.unavailable);return(payload as {released:boolean}).released;
    },
    async createFileDownload(token, organizationId, fileId) {
      const row = await getFile(token, organizationId, fileId);
      if (!row || row.is_archived) throw new ApiFailure(404, 'File not found');
      const url = await http.signedUrl(token, `object/sign/${config.APP_FILE_BUCKET}/${row.storage_path.split('/').map(encodeURIComponent).join('/')}`, { expiresIn: DOWNLOAD_EXPIRES_IN }, fileMessages);
      return { file: publicFile(row), signed_url: url, expires_in: DOWNLOAD_EXPIRES_IN };
    },
    async listFileVersions(token, organizationId, fileId) {
      const file = await getFile(token, organizationId, fileId);
      if (!file) throw new ApiFailure(404, 'File not found');
      const rows = await fileLists.selectAll(token, 'file_asset_versions', { organization_id:eq(organizationId), file_id:eq(fileId), order:'version_number.desc,id.asc' }, fileVersionSchema);
      if (rows.some(row => row.organization_id !== organizationId || row.file_id !== fileId)) throw new ApiFailure(503, fileMessages.unavailable);
      return rows;
    },
    async createFileVersion(token, organizationId, fileId, expectedVersion, input) {
      const current = await getFile(token, organizationId, fileId);
      if (!current || current.is_archived) throw new ApiFailure(404, 'File not found');
      if (current.version_number !== expectedVersion) throw new ApiFailure(409, 'File version changed');
      const operationId = randomUUID();
      const path = `${organizationId}/${operationId}-${safeFilename(input.original_name)}`;
      await http.request(token,'POST','/rest/v1/rpc/reserve_file_storage_upload',fileMessages,{body:{p_organization_id:organizationId,p_operation_id:operationId,p_storage_path:path,p_size_bytes:input.size_bytes},mapCodes:true,badRequestIsInvalid:true});
      try{
        const url = await http.signedUrl(token, `object/upload/sign/${config.APP_FILE_BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`, {}, fileMessages);
        return { file:publicFile(current), signed_url:url, expires_in:UPLOAD_EXPIRES_IN, version_upload_path:path, version_operation_id:operationId };
      }catch(error){await http.request(token,'POST','/rest/v1/rpc/release_file_storage_upload',fileMessages,{body:{p_organization_id:organizationId,p_operation_id:operationId},mapCodes:true}).catch(()=>undefined);throw error;}
    },
    async commitFileVersion(token, organizationId, fileId, expectedVersion, operationId, path, input) {
      if (!path.startsWith(`${organizationId}/${operationId}-`) || !/^([0-9a-f-]{36})-[A-Za-z0-9._-]+$/.test(path.slice(organizationId.length + 1))) throw new ApiFailure(422, 'Invalid file version path');
      // A signed download URL can only be created for a completed Storage object. This prevents publishing a version before upload succeeds.
      await http.signedUrl(token, `object/sign/${config.APP_FILE_BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`, { expiresIn:60 }, fileMessages);
      const payload = await http.request(token, 'POST', '/rest/v1/rpc/create_file_asset_version', fileMessages, { body:{p_organization_id:organizationId,p_file_id:fileId,p_expected_version:expectedVersion,p_operation_id:operationId,p_storage_path:path,p_original_name:input.original_name,p_content_type:input.content_type,p_size_bytes:input.size_bytes}, mapCodes:true, badRequestIsInvalid:true });
      const parsed = fileRowSchema.safeParse(payload);
      if (!parsed.success || parsed.data.organization_id !== organizationId || parsed.data.id !== fileId || parsed.data.version_number !== expectedVersion + 1) throw new ApiFailure(503, fileMessages.unavailable);
      return publicFile(parsed.data);
    },
    async createFileVersionDownload(token, organizationId, fileId, version) {
      const parent = await getFile(token, organizationId, fileId);
      if (!parent || parent.is_archived) throw new ApiFailure(404, 'File not found');
      const rows = await fileLists.select(token, 'file_asset_versions', { organization_id:eq(organizationId), file_id:eq(fileId), version_number:eq(String(version)), limit:'2' }, storedFileVersionSchema);
      if (rows.some(row => row.organization_id !== organizationId || row.file_id !== fileId)) throw new ApiFailure(503, fileMessages.unavailable);
      const row = rows[0];
      if (!row || rows.length !== 1) throw new ApiFailure(404, 'File version not found');
      const url = await http.signedUrl(token, `object/sign/${config.APP_FILE_BUCKET}/${row.storage_path.split('/').map(encodeURIComponent).join('/')}`, { expiresIn:DOWNLOAD_EXPIRES_IN }, fileMessages);
      return { file:{id:row.file_id,organization_id:row.organization_id,uploaded_by:row.uploaded_by,original_name:row.original_name,content_type:row.content_type,size_bytes:row.size_bytes,version_number:row.version_number,is_archived:false,created_at:row.created_at,updated_at:row.created_at,folder_id:null,tags:[]}, signed_url:url, expires_in:DOWNLOAD_EXPIRES_IN };
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
