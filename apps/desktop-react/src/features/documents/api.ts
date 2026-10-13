import type { ApiClient } from '../../api/client';
import type { BinarySource, Platform } from '../../platform/types';
import { validateFile } from './fileValidation';
import { previewTypeOf } from './filePreview';
import { uploadWithProgress, type UploadOptions } from './uploadProgress';
import { consentEventSchema, consentEventsSchema, customerOptionsSchema, evidenceVerificationSchema, documentSchema, documentsSchema, fileSchema, filesSchema, issuedListSchema, issuedSchema, previewSchema, signedFileSchema, templateSchema, templatesSchema, templateVersionsSchema, treatmentOptionsSchema } from './schemas';
import type { ConsentRequest, Scope, TemplateMutation } from './schemas';

const org = (o: string) => `/organizations/${o}`;
const treatmentBase = (s: Scope) => `${org(s.organizationId)}/customers/${s.customerId}/treatments/${s.treatmentId}/documents`;

export const documentApi = {
  listTemplates: (api: ApiClient, o: string) => api.call('GET', `${org(o)}/document-templates`, templatesSchema),
  listTemplateVersions: (api: ApiClient, o: string, templateId: string) => api.call('GET', `${org(o)}/document-templates/${templateId}/versions`, templateVersionsSchema),
  mutateTemplate: (api: ApiClient, o: string, templateId: string, input: TemplateMutation) => api.call('POST', `${org(o)}/document-templates/${templateId}/mutations`, templateSchema, input),
  listDocuments: (api: ApiClient, o: string) => api.call('GET', `${org(o)}/documents`, documentsSchema),
  createDocument: (api: ApiClient, o: string, input: { title: string; content: string; template_id: string | null; status: string }) => api.call('POST', `${org(o)}/documents`, documentSchema, input),
  updateDocument: (api: ApiClient, o: string, id: string, patch: Partial<{ title: string; content: string; template_id: string; status: string }>) => api.call('PATCH', `${org(o)}/documents/${id}`, documentSchema, patch),
  preview: (api: ApiClient, s: Scope, templateId: string) => api.call('POST', `${treatmentBase(s)}/preview`, previewSchema, { template_id: templateId }),
  issue: (api: ApiClient, s: Scope, input: { template_id: string; operation_id: string; expected_preview: Record<string, unknown> }) => api.call('POST', treatmentBase(s), issuedSchema, input),
  listIssued: (api: ApiClient, s: Scope) => api.call('GET', treatmentBase(s), issuedListSchema),
  listEvents: (api: ApiClient, s: Scope, documentId: string) => api.call('GET', `${treatmentBase(s)}/${documentId}/events`, consentEventsSchema),
  /** 서버가 저장된 증빙 해시와 지금 기록으로 다시 계산한 값을 비교한 결과. */
  verifyEvent: (api: ApiClient, s: Scope, documentId: string, eventId: string) => api.call('GET', `${treatmentBase(s)}/${documentId}/events/${eventId}/verify`, evidenceVerificationSchema),
  recordEvent: (api: ApiClient, s: Scope, documentId: string, input: ConsentRequest) => api.call('POST', `${treatmentBase(s)}/${documentId}/events`, consentEventSchema, input),
  listCustomers: (api: ApiClient, o: string) => api.call('GET', `${org(o)}/customers`, customerOptionsSchema),
  listTreatments: (api: ApiClient, o: string) => api.call('GET', `${org(o)}/operations/treatments`, treatmentOptionsSchema),
};

/** 데스크톱(Tauri)은 운영체제 파일 선택 창을 열어 경로 기반 BinarySource를 돌려주는 pickFiles를 제공해야 한다. */
export type FilePlatform = Platform & { pickFiles?: () => Promise<BinarySource[]> };

export const fileApi = {
  list: (api: ApiClient, o: string, includeArchived = false) => api.call('GET', `${org(o)}/files${includeArchived ? '?include_archived=true' : ''}`, filesSchema),
  archive: (api: ApiClient, o: string, id: string) => api.call('DELETE', `${org(o)}/files/${id}`, fileSchema),
  downloadUrl: (api: ApiClient, o: string, id: string) => api.call('POST', `${org(o)}/files/${id}/download-url`, signedFileSchema, {}),
  /**
   * 크기를 검사하고 서명 URL을 받아 직접 올린다. 올리기에 실패하거나 취소하면 만든 메타데이터를 보관 처리해 되돌린다.
   * options 가 있으면 진행률·취소를 지원하는 경로(uploadWithProgress)를 쓰고, 없으면 기존 platform.uploadBinary 를 그대로 쓴다.
   */
  async upload(api: ApiClient, o: string, source: BinarySource, options?: UploadOptions) {
    validateFile(source);
    const prepared = await api.call('POST', `${org(o)}/files/upload-url`, signedFileSchema, {
      original_name: source.name.trim(), content_type: source.contentType || 'application/octet-stream', size_bytes: source.size,
    });
    try {
      if (options) await uploadWithProgress(api.filePlatform, prepared.signed_url, source, options);
      else await api.filePlatform.uploadBinary(prepared.signed_url, source);
    } catch (error) {
      await fileApi.archive(api, o, prepared.file.id).catch(() => undefined);
      throw error;
    }
    return prepared.file;
  },
  /** 미리보기용: 서명 URL로 내려받은 바이트를 형식이 맞는 Blob 으로 돌려준다(미리보기를 지원하지 않는 형식이면 오류). */
  async fetchPreview(api: ApiClient, o: string, id: string): Promise<{ blob: Blob; kind: 'image' | 'pdf' }> {
    const signed = await fileApi.downloadUrl(api, o, id);
    const type = previewTypeOf(signed.file);
    if (!type) throw new Error('미리보기를 지원하지 않는 형식입니다.');
    const bytes = await api.filePlatform.downloadBinary(signed.signed_url);
    return { blob: new Blob([Uint8Array.from(bytes)], { type: type.mime }), kind: type.kind };
  },
  /** 서명 URL로 내려받은 바이트를 파일로 저장한다. */
  async download(api: ApiClient, o: string, id: string) {
    const signed = await fileApi.downloadUrl(api, o, id);
    const bytes = await api.filePlatform.downloadBinary(signed.signed_url);
    saveBytes(bytes, signed.file.original_name, signed.file.content_type);
  },
};

export function saveBytes(bytes: Uint8Array, name: string, contentType: string): void {
  const blob = new Blob([Uint8Array.from(bytes)], { type: contentType || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
