import { z } from 'zod';

/** DB numeric이 숫자로 와도 문자열(소수 두 자리)로 통일해 다룬다. */
const amount = z.union([z.string(), z.number()]).nullable().transform((value) => (typeof value === 'number' ? value.toFixed(2) : value));

export const treatmentSchema = z.object({
  id: z.string(), organization_id: z.string(), customer_id: z.string(),
  treatment_date: z.string(), treatment_name: z.string(), category: z.string(), practitioner: z.string(), notes: z.string(),
  amount, next_visit_date: z.string().nullable(),
  status: z.string(), version: z.number(), started_at: z.string().nullable(), ended_at: z.string().nullable(),
  consultation_goal: z.string().default(''), consultation_plan: z.string().default(''),
  cautions_snapshot: z.record(z.string(), z.unknown()).default({}),
  cautions_acknowledged_by: z.string().nullable().default(null), cautions_acknowledged_at: z.string().nullable().default(null),
  appointment_service_id: z.string().nullable().default(null),
});
export const treatmentsSchema = z.array(treatmentSchema);
export type Treatment = z.infer<typeof treatmentSchema>;

export const treatmentEventSchema = z.object({
  id: z.string(), actor_id: z.string(), action: z.string(), reason: z.string(), occurred_at: z.string(),
  before_data: z.record(z.string(), z.unknown()), after_data: z.record(z.string(), z.unknown()),
});
export const treatmentEventsSchema = z.array(treatmentEventSchema);
export type TreatmentEvent = z.infer<typeof treatmentEventSchema>;

export const saleValuesSchema = z.object({
  description: z.string(), amount: z.string(), consent_document_id: z.string().nullable(), exception_reason: z.string(), partial_reason: z.string(),
});
export type SaleValues = z.infer<typeof saleValuesSchema>;

export const consentStatusSchema = z.enum(['not_linked', 'unsigned', 'signed', 'revoked']);
export const salePreviewSchema = z.object({
  values: saleValuesSchema,
  line: z.object({ description: z.string(), quantity: z.literal(1), unit_price: z.string(), line_total: z.string(), practitioner: z.string() }),
  total_amount: z.string(),
  source_snapshot: z.record(z.string(), z.unknown()),
  consent_status: consentStatusSchema,
  warnings: z.array(z.string()),
});
export type SalePreview = z.infer<typeof salePreviewSchema>;

export const saleDraftSchema = z.object({
  id: z.string(), organization_id: z.string(), customer_id: z.string(), treatment_id: z.string(), status: z.string(),
  description: z.string(), amount: z.string(), source_snapshot: z.record(z.string(), z.unknown()), created_by: z.string(), created_at: z.string(),
});
export const saleDraftsSchema = z.array(saleDraftSchema);
export type SaleDraft = z.infer<typeof saleDraftSchema>;

/** 동의 문서 선택에 필요한 최소 필드. 문서 발행 API(다른 모듈)의 나머지 필드는 무시한다. */
export const issuedDocumentSchema = z.object({ id: z.string(), title: z.string(), template_version: z.union([z.number(), z.string()]).optional() });
export const issuedDocumentsSchema = z.array(issuedDocumentSchema);
export type IssuedDocument = z.infer<typeof issuedDocumentSchema>;

export type TreatmentValues = {
  treatment_date: string; treatment_name: string; category: string; practitioner: string; notes: string; amount: string | null; next_visit_date: string | null;
};
export type TreatmentAction = 'edit' | 'correct' | 'consult' | 'start' | 'complete' | 'cancel';
export type ConsultationValues = {
  goal: string; plan: string; acknowledge_cautions: boolean;
  expected_cautions: { allergies: string; skin_type: string | null; concerns: string[] };
};
export type MutationBody = {
  action: TreatmentAction; expected_version: number; operation_id: string; reason: string; values: TreatmentValues | ConsultationValues | null;
};
