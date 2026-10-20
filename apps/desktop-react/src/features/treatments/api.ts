import { z } from 'zod';
import type { ApiClient } from '../../api/client';
import { treatmentContextSchema, type VisitLinkInput } from './visitContext';
import {
  issuedDocumentsSchema, saleDraftSchema, saleDraftsSchema, salePreviewSchema, treatmentEventsSchema, treatmentSchema, treatmentsSchema,
  type MutationBody, type SalePreview, type SaleValues, type TreatmentValues,
} from './schemas';

const customerBase = (organizationId: string, customerId: string) => `/organizations/${organizationId}/customers/${customerId}`;
const treatmentBase = (organizationId: string, customerId: string, treatmentId: string) => `${customerBase(organizationId, customerId)}/treatments/${treatmentId}`;

/** 시술 사진 구분: 시술 전/후/기타. null 은 미분류(043 이전에 만든 연결)로 화면에서는 '기타'와 같게 다룬다. */
export const photoPhaseSchema = z.enum(['before', 'after', 'other']);
export type PhotoPhase = z.infer<typeof photoPhaseSchema>;
export const treatmentPhotoSchema = z.object({
  id: z.string(), organization_id: z.string(), customer_id: z.string(), treatment_id: z.string(), storage_path: z.string(),
  thumbnail_path: z.string().nullable(), content_type: z.string(), caption: z.string(), sort_order: z.number(), taken_at: z.string().nullable(),
  phase: photoPhaseSchema.nullable().default(null),
});
export type TreatmentPhoto = z.infer<typeof treatmentPhotoSchema>;
export type TreatmentPhotoInput = { treatment_id: string; storage_path: string; thumbnail_path?: string | null; content_type?: string; caption?: string; sort_order?: number; taken_at?: string | null; phase?: PhotoPhase | null };

export const treatmentKeys = { customer: (organizationId: string, customerId: string) => ['organizations', organizationId, 'customers', customerId, 'treatments'] as const };

export const treatmentApi = {
  contextOptions:(api:ApiClient,organizationId:string,customerId:string)=>api.call('GET',`${customerBase(organizationId,customerId)}/treatment-context-options`,treatmentContextSchema),
  linkVisit:(api:ApiClient,organizationId:string,customerId:string,treatmentId:string,input:VisitLinkInput)=>api.call('PUT',`${treatmentBase(organizationId,customerId,treatmentId)}/visit-link`,treatmentSchema,input),
  list: (api: ApiClient, organizationId: string, customerId: string) => api.call('GET', `${customerBase(organizationId, customerId)}/treatments`, treatmentsSchema),
  create: (api: ApiClient, organizationId: string, customerId: string, values: TreatmentValues) => api.call('POST', `${customerBase(organizationId, customerId)}/treatments`, treatmentSchema, values),
  /** 수정·정정·상담·시작·완료·중단 모두 낙관적 잠금(expected_version)과 멱등 키(operation_id)를 쓰는 변이 API. */
  mutate: (api: ApiClient, organizationId: string, customerId: string, treatmentId: string, body: MutationBody) => api.call('POST', `${treatmentBase(organizationId, customerId, treatmentId)}/mutations`, treatmentSchema, body),
  setService: (api: ApiClient, organizationId: string, customerId: string, treatmentId: string, serviceId: string | null, expected_version: number, operation_id: string) =>
    api.call('PUT', `${treatmentBase(organizationId, customerId, treatmentId)}/service`, treatmentSchema, { service_id: serviceId, expected_version, operation_id }),
  events: (api: ApiClient, organizationId: string, customerId: string, treatmentId: string) => api.call('GET', `${treatmentBase(organizationId, customerId, treatmentId)}/events`, treatmentEventsSchema),

  listPhotos: (api: ApiClient, organizationId: string, customerId: string, treatmentId?: string) => api.call('GET', `${customerBase(organizationId, customerId)}/treatment-photos${treatmentId ? `?treatment_id=${treatmentId}` : ''}`, z.array(treatmentPhotoSchema)),
  createPhoto: (api: ApiClient, organizationId: string, customerId: string, input: TreatmentPhotoInput) => api.call('POST', `${customerBase(organizationId, customerId)}/treatment-photos`, treatmentPhotoSchema, input),
  /** 구분(phase)·설명만 바꾼다. */
  updatePhoto: (api: ApiClient, organizationId: string, customerId: string, photoId: string, patch: { phase?: PhotoPhase | null; caption?: string }) => api.call('PATCH', `${customerBase(organizationId, customerId)}/treatment-photos/${photoId}`, treatmentPhotoSchema, patch),
  deletePhoto: (api: ApiClient, organizationId: string, customerId: string, photoId: string) => api.callVoid('DELETE', `${customerBase(organizationId, customerId)}/treatment-photos/${photoId}`),

  saleDrafts: (api: ApiClient, organizationId: string, customerId: string, treatmentId: string) => api.call('GET', `${treatmentBase(organizationId, customerId, treatmentId)}/sale-draft`, saleDraftsSchema),
  previewSaleDraft: (api: ApiClient, organizationId: string, customerId: string, treatmentId: string, values: SaleValues) => api.call('POST', `${treatmentBase(organizationId, customerId, treatmentId)}/sale-draft/preview`, salePreviewSchema, { values }),
  createSaleDraft: (api: ApiClient, organizationId: string, customerId: string, treatmentId: string, body: { operation_id: string; expected_preview: SalePreview; confirmed: true }) => api.call('POST', `${treatmentBase(organizationId, customerId, treatmentId)}/sale-draft`, saleDraftSchema, body),
  /** 조직 전체의 미수납 시술 결제 초안(수납함). */
  allSaleDrafts: (api: ApiClient, organizationId: string) => api.call('GET', `/organizations/${organizationId}/treatment-sale-drafts`, saleDraftsSchema),
  /** 문서 발행 모듈이 제공하는 시술별 발행본 목록. 동의 문서 연결 선택지로만 쓴다. */
  issuedDocuments: (api: ApiClient, organizationId: string, customerId: string, treatmentId: string) => api.call('GET', `${treatmentBase(organizationId, customerId, treatmentId)}/documents`, issuedDocumentsSchema),
};
