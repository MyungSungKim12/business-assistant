import { z } from 'zod';

export const templateSchema = z.object({
  id: z.uuid(), organization_id: z.uuid(), created_by: z.uuid(), name: z.string(), description: z.string(), content: z.string(), is_archived: z.boolean(),
  created_at: z.string(), updated_at: z.string(), status: z.string(), version: z.number(), revision: z.number(),
});
export const templatesSchema = z.array(templateSchema);
export const templateVersionSchema = z.object({
  template_id: z.uuid(), organization_id: z.uuid(), version: z.number(), name: z.string(), description: z.string(), content: z.string(), published_by: z.uuid(), published_at: z.string(),
});
export const templateVersionsSchema = z.array(templateVersionSchema);
export const documentSchema = z.object({
  id: z.uuid(), organization_id: z.uuid(), template_id: z.uuid().nullable(), created_by: z.uuid(), title: z.string(), content: z.string(), status: z.string(),
  created_at: z.string(), updated_at: z.string(), folder_id:z.uuid().nullable().default(null),tags:z.array(z.string()).max(10).default([]),
});
export const fileFoldersSchema=z.array(z.object({id:z.uuid(),organization_id:z.uuid(),name:z.string(),created_by:z.uuid(),created_at:z.string()}));
export const documentsSchema = z.array(documentSchema);
export const previewSchema = z.object({
  template_id: z.uuid(), template_version: z.number(), title: z.string(), content: z.string(), source_snapshot: z.record(z.string(), z.unknown()), missing_fields: z.array(z.string()),
});
export const issuedSchema = z.object({
  id: z.uuid(), organization_id: z.uuid(), customer_id: z.uuid(), treatment_id: z.uuid(), template_id: z.uuid(), template_version: z.number(), title: z.string(), content: z.string(),
  source_snapshot: z.record(z.string(), z.unknown()), issued_by: z.uuid(), issued_at: z.string(),
});
export const issuedListSchema = z.array(issuedSchema);
/** 서버가 기록 시점에 계산해 둔 증빙 해시. 증빙이 없던 옛 기록은 null. */
export const evidenceSchema = z.object({ algorithm: z.string(), hash: z.string() });
export const consentEventSchema = z.object({
  id: z.uuid(), organization_id: z.uuid(), document_id: z.uuid(), revision: z.number(), action: z.enum(['sign', 'deliver', 'revoke']), values: z.record(z.string(), z.unknown()),
  actor_id: z.uuid(), occurred_at: z.string(), content_hash: z.string(), evidence: evidenceSchema.nullable().default(null),
});
export const evidenceStatusSchema = z.enum(['match', 'mismatch', 'no_proof', 'unknown_algorithm']);
export const evidenceVerificationSchema = z.object({
  event_id: z.string(), revision: z.number(), status: evidenceStatusSchema, algorithm: z.string().nullable(), stored_hash: z.string().nullable(), computed_hash: z.string().nullable(), occurred_at: z.string(),
});
export const consentEventsSchema = z.array(consentEventSchema);
export const fileSchema = z.object({
  id: z.uuid(), organization_id: z.uuid(), uploaded_by: z.uuid(), original_name: z.string(), content_type: z.string(), size_bytes: z.number(), version_number:z.number().int().positive().default(1), is_archived: z.boolean(),
  created_at: z.string(), updated_at: z.string(), folder_id:z.uuid().nullable().default(null),tags:z.array(z.string()).max(10).default([]),
});
export const filesSchema = z.array(fileSchema);
export const signedFileSchema = z.object({ file: fileSchema, signed_url: z.string(), expires_in: z.number() });
export const signedUploadFileSchema=signedFileSchema.extend({reservation_id:z.uuid()});
export const preparedFileVersionSchema = signedFileSchema.extend({ version_upload_path:z.string(), version_operation_id:z.uuid() });
export const fileStorageUsageSchema=z.object({organization_id:z.uuid(),used_bytes:z.number().int().nonnegative(),reserved_bytes:z.number().int().nonnegative(),organization_quota_bytes:z.number().int().nonnegative(),plan_quota_bytes:z.number().int().nonnegative().nullable(),quota_bytes:z.number().int().nonnegative(),available_bytes:z.number().int().nonnegative()});
export type FileStorageUsage=z.infer<typeof fileStorageUsageSchema>;
export const fileVersionsSchema = z.array(z.object({id:z.uuid(),organization_id:z.uuid(),file_id:z.uuid(),version_number:z.number().int().positive(),original_name:z.string(),content_type:z.string(),size_bytes:z.number(),uploaded_by:z.uuid(),created_at:z.string()}));
// 고객·시술 선택용(발행 대상 찾기). 다른 모듈의 응답에서 필요한 열만 읽는다.
export const customerOptionsSchema = z.array(z.object({ id: z.uuid(), name: z.string() }));
export const treatmentOptionsSchema = z.array(z.object({ id: z.uuid(), customer_id: z.uuid(), treatment_name: z.string(), treatment_date: z.string() }));

export type DocumentTemplate = z.infer<typeof templateSchema>;
export type TemplateVersion = z.infer<typeof templateVersionSchema>;
export type DocumentRecord = z.infer<typeof documentSchema>;
export type TreatmentPreview = z.infer<typeof previewSchema>;
export type IssuedDocument = z.infer<typeof issuedSchema>;
export type ConsentEvent = z.infer<typeof consentEventSchema>;
export type ConsentAction = ConsentEvent['action'];
export type EvidenceVerification = z.infer<typeof evidenceVerificationSchema>;
export type FileAsset = z.infer<typeof fileSchema>;
export type SignedFile = z.infer<typeof signedFileSchema>;
export type TemplateAction = 'create' | 'save' | 'publish' | 'revise' | 'retire';
export type TemplateMutation = { operation_id: string; expected_revision: number; action: TemplateAction; values?: { name: string; description: string; content: string } };
export type ConsentRequest = { expected_revision: number; operation_id: string; action: ConsentAction; values: Record<string, unknown> };
export type Scope = { organizationId: string; customerId: string; treatmentId: string };

export const documentStatusLabel: Record<string, string> = { draft: '초안', final: '완료', archived: '보관' };
export const templateStatusLabel: Record<string, string> = { draft: '초안', published: '게시됨', retired: '폐기됨' };
export const evidenceStatusLabel: Record<EvidenceVerification['status'], string> = {
  match: '일치 · 기록 이후 변경 없음', mismatch: '불일치 · 기록 내용이 달라졌습니다', no_proof: '증빙 해시 없음 · 이전 기록', unknown_algorithm: '확인 불가 · 알 수 없는 해시 방식',
};
export const consentActionLabel: Record<ConsentAction, string> = { sign: '현장 손서명', deliver: '교부 확인 기록', revoke: '철회 기록' };
export const deliveryMethodLabel: Record<string, string> = { paper: '종이 교부', email: '외부 이메일', sms: '외부 문자', other: '기타' };
export const FIELD_NAMES: Record<string, string> = {
  'customer.name': '고객 이름', 'customer.phone': '고객 연락처', 'customer.birth_date': '고객 생년월일', 'treatment.name': '시술명', 'treatment.date': '시술일',
  'treatment.practitioner': '담당자', 'treatment.amount': '예정 금액', 'treatment.consultation_goal': '상담 목표',
  // 054에서 추가한 항목
  'organization.name': '매장 이름', today: '오늘 날짜', 'customer.skin_type': '고객 피부 타입', 'customer.allergies': '고객 알레르기·주의사항',
  'treatment.category': '시술 분류', 'treatment.next_visit_date': '다음 방문일', 'treatment.consultation_plan': '예정 관리 내용', malformed_placeholder: '잘못된 중괄호 표시', '': '빈 자동 채움 표시',
};
export const TEMPLATE_FIELDS = ['customer.name', 'customer.phone', 'customer.birth_date', 'treatment.name', 'treatment.date', 'treatment.practitioner', 'treatment.amount', 'treatment.consultation_goal',
  'organization.name', 'today', 'customer.skin_type', 'customer.allergies', 'treatment.category', 'treatment.next_visit_date', 'treatment.consultation_plan'];
