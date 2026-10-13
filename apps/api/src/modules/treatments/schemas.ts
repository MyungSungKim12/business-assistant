import { z } from 'zod';

/** 테스트·운영 UUID를 모두 받는 느슨한 형식(zod 4의 z.uuid()는 버전·변형 비트까지 검사한다). */
export const id = z.guid();

function daysIn(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** YYYY-MM-DD 달력 날짜(Python iso_date 검증과 같은 규칙). */
export function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month);
}
export const isoDate = z.string().refine(isValidIsoDate, 'Expected YYYY-MM-DD');

/**
 * 금액(0 이상, 정수부 12자리 이하, 소수 두 자리 이하)을 "1000.00" 형태로 정규화한다.
 * 문자열·숫자(지수 표기 포함)를 받고, 유효하지 않으면 undefined.
 */
export function normalizeAmount(input: string | number): string | undefined {
  const text = (typeof input === 'number' ? (Number.isFinite(input) ? String(input) : '') : input).trim();
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return undefined;
  const [, sign, whole = '', fraction = '', exponent = '0'] = match;
  if (!whole && !fraction) return undefined;
  const digits = BigInt(`${whole}${fraction}` || '0');
  if (digits === 0n) return '0.00';
  if (sign === '-') return undefined;
  const exp10 = Number(exponent) - fraction.length;
  if (!Number.isSafeInteger(exp10) || exp10 > 20) return undefined;
  let scaled: bigint;
  if (exp10 >= -2) scaled = digits * 10n ** BigInt(exp10 + 2);
  else {
    const shift = -exp10 - 2;
    if (shift > digits.toString().length) return undefined;
    const base = 10n ** BigInt(shift);
    if (digits % base !== 0n) return undefined;
    scaled = digits / base;
  }
  if (scaled >= 10n ** 14n) return undefined;
  return `${scaled / 100n}.${String(scaled % 100n).padStart(2, '0')}`;
}

/** DB(PostgREST numeric)가 돌려준 금액을 두 자리 문자열로 만든다. */
export const amountOut = z.union([z.string(), z.number()]).transform((value, ctx) => {
  const normalized = normalizeAmount(value);
  if (normalized === undefined) { ctx.addIssue({ code: 'custom', message: 'Invalid amount' }); return z.NEVER; }
  return normalized;
});

const amountIn = z.union([z.string(), z.number(), z.null()]).transform((value, ctx) => {
  if (value === null) return null;
  const normalized = normalizeAmount(value);
  if (normalized === undefined) { ctx.addIssue({ code: 'custom', message: 'Invalid amount' }); return z.NEVER; }
  return normalized;
}).default(null);

const treatmentFields = {
  treatment_date: isoDate,
  treatment_name: z.string().trim().min(1).max(200),
  category: z.string().trim().max(100).default(''),
  practitioner: z.string().trim().max(100).default(''),
  notes: z.string().max(10_000).default(''),
  amount: amountIn,
  next_visit_date: isoDate.nullable().default(null),
};
const nextVisitOk = (value: { treatment_date: string; next_visit_date: string | null }) => !value.next_visit_date || value.next_visit_date >= value.treatment_date;

export const treatmentRequest = z.strictObject(treatmentFields).refine(nextVisitOk, { message: 'Next visit cannot be before the treatment date', path: ['next_visit_date'] });
export const treatmentUpdateRequest = z.strictObject({ ...treatmentFields, expected_version: z.number().int().min(1).optional(), operation_id: id.optional() })
  .refine(nextVisitOk, { message: 'Next visit cannot be before the treatment date', path: ['next_visit_date'] });
export type TreatmentValues = z.infer<typeof treatmentRequest>;

export const consultationValues = z.strictObject({
  goal: z.string().max(2000),
  plan: z.string().max(5000),
  acknowledge_cautions: z.boolean(),
  expected_cautions: z.strictObject({ allergies: z.string(), skin_type: z.string().nullable(), concerns: z.array(z.string()) }),
});
export type ConsultationValues = z.infer<typeof consultationValues>;

export type TreatmentMutation = {
  action: 'edit' | 'correct' | 'consult' | 'start' | 'complete' | 'cancel';
  expected_version: number;
  operation_id: string;
  reason: string;
  values: TreatmentValues | ConsultationValues | null;
};

export const mutationRequest = z.strictObject({
  action: z.enum(['edit', 'correct', 'consult', 'start', 'complete', 'cancel']),
  expected_version: z.number().int().min(1),
  operation_id: id,
  reason: z.string().max(2000).default(''),
  values: z.unknown().optional(),
}).transform((request, ctx): TreatmentMutation => {
  const reason = request.reason.trim();
  const fail = (message: string) => { ctx.addIssue({ code: 'custom', message }); return z.NEVER; };
  let values: TreatmentValues | ConsultationValues | null = null;
  if ((request.action === 'correct' || request.action === 'cancel') && !reason) return fail('Reason is required');
  if (request.action === 'edit' || request.action === 'correct') {
    const parsed = treatmentRequest.safeParse(request.values);
    if (!parsed.success) return fail('Edit/correct require treatment values');
    values = parsed.data;
  } else if (request.action === 'consult') {
    const parsed = consultationValues.safeParse(request.values);
    if (!parsed.success) return fail('Consult requires consultation values');
    values = parsed.data;
  } else if (request.values !== undefined && request.values !== null) return fail('Transitions do not accept values');
  return { action: request.action, expected_version: request.expected_version, operation_id: request.operation_id, reason, values };
});

/** 시술 사진 구분: 시술 전/후/기타. null·생략은 미분류. */
export const photoPhase = z.enum(['before', 'after', 'other']);
export const photoRequest = z.strictObject({
  treatment_id: id,
  phase: photoPhase.nullable().optional(),
  storage_path: z.string().min(1).max(1000),
  thumbnail_path: z.string().nullable().default(null),
  content_type: z.string().default('image/jpeg'),
  caption: z.string().default(''),
  sort_order: z.number().int().min(0).default(0),
  taken_at: z.string().nullable().default(null),
});

export const treatmentRow = z.object({
  id, organization_id: id, customer_id: id,
  treatment_date: z.string(), treatment_name: z.string(), category: z.string(), practitioner: z.string(), notes: z.string(),
  amount: amountOut.nullable().default(null), next_visit_date: z.string().nullable().default(null),
  status: z.string().default('legacy'), version: z.number().int().default(1),
  started_at: z.string().nullable().default(null), ended_at: z.string().nullable().default(null),
  consultation_goal: z.string().default(''), consultation_plan: z.string().default(''),
  cautions_snapshot: z.record(z.string(), z.unknown()).default({}),
  cautions_acknowledged_by: id.nullable().default(null), cautions_acknowledged_at: z.string().nullable().default(null),
});
export type TreatmentRow = z.infer<typeof treatmentRow>;

export const eventRow = z.object({
  id, actor_id: id, action: z.string(), reason: z.string(), occurred_at: z.string(),
  before_data: z.record(z.string(), z.unknown()), after_data: z.record(z.string(), z.unknown()),
});
export type TreatmentEvent = z.infer<typeof eventRow>;

/** 구분(phase)·설명만 바꿀 수 있다. 연결된 시술·저장 경로는 바꾸지 않는다(다시 연결하려면 해제 후 새로 연결). */
export const photoPatch = z.strictObject({ phase: photoPhase.nullable().optional(), caption: z.string().max(500).optional() })
  .refine((value) => Object.keys(value).length > 0, 'at least one photo field is required');
export const photoRow = z.object({
  id, organization_id: id, customer_id: id, treatment_id: id, storage_path: z.string(), thumbnail_path: z.string().nullable().default(null),
  phase: photoPhase.nullable().optional(),
  content_type: z.string(), caption: z.string(), sort_order: z.number().int(), taken_at: z.string().nullable().default(null),
});
export type TreatmentPhoto = z.infer<typeof photoRow>;

// ---- 시술 판매 초안 ----
export const saleValues = z.strictObject({
  description: z.string().min(1).max(200).refine((value) => value.trim().length > 0, 'description is required'),
  amount: z.string().regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/),
  consent_document_id: id.nullable(),
  exception_reason: z.string().max(2000),
  partial_reason: z.string().max(2000),
});
export const salePreview = z.strictObject({
  values: saleValues,
  line: z.strictObject({ description: z.string(), quantity: z.literal(1), unit_price: z.string(), line_total: z.string(), practitioner: z.string() }),
  total_amount: z.string(),
  source_snapshot: z.record(z.string(), z.unknown()),
  consent_status: z.enum(['not_linked', 'unsigned', 'signed', 'revoked']),
  warnings: z.array(z.string()),
});
export type SalePreview = z.infer<typeof salePreview>;
export const salePreviewRequest = z.strictObject({ values: saleValues });
export const saleCreateRequest = z.strictObject({ operation_id: id, expected_preview: salePreview, confirmed: z.literal(true) });
// 재시도 지문·operation_id는 공개 필드가 아니므로 응답에서 제외된다(알 수 없는 키는 버려진다).
export const saleDraftRow = z.object({
  id, organization_id: id, customer_id: id, treatment_id: id, status: z.literal('draft'), description: z.string(),
  amount: amountOut, source_snapshot: z.record(z.string(), z.unknown()), created_by: id, created_at: z.string(),
});
export type SaleDraft = z.infer<typeof saleDraftRow>;
