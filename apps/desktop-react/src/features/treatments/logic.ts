import type { Customer } from '../../api/schemas';
import type { Treatment, TreatmentEvent, TreatmentValues } from './schemas';

export const STATUS_LABELS: Record<string, string> = { legacy: '기존 기록', draft: '준비', in_progress: '진행 중', completed: '완료', cancelled: '중단' };
export const ACTION_LABELS: Record<string, string> = {
  consult: '상담 기록·주의 확인', edit: '기록 수정', correct: '기록 정정', start: '시술 시작', complete: '시술 완료', cancel: '시술 중단',
};
export const FIELD_LABELS: Record<string, string> = {
  consultation_goal: '상담 목표', consultation_plan: '예정 관리 내용', cautions_snapshot: '확인한 고객 주의정보', cautions_acknowledged_by: '주의 확인자',
  cautions_acknowledged_at: '주의 확인 시각', treatment_name: '시술명', treatment_date: '시술일', category: '분류', practitioner: '담당자', notes: '시술 내용',
  amount: '예정 금액', next_visit_date: '다음 방문일', status: '상태', version: '버전', started_at: '시작 시각', ended_at: '종료 시각',
};
export const CONSENT_LABELS: Record<string, string> = { signed: '손서명 기록 있음', unsigned: '서명 미확인', revoked: '철회 기록 있음', not_linked: '동의 문서 미연결' };

export const statusLabel = (status: string) => STATUS_LABELS[status] ?? status;
export const isLocked = (record: Treatment | undefined) => record?.status === 'completed' || record?.status === 'cancelled';

export function todayIso(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function localTime(value: unknown): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value || '—');
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function newOperationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.floor(Math.random() * 16); return (c === 'x' ? r : (r & 3) | 8).toString(16); });
}

// ---- 시술 기록 입력 ----
export type FormState = { treatment_date: string; treatment_name: string; category: string; practitioner: string; amount: string; next_visit_date: string; notes: string };

export const emptyForm = (today = todayIso()): FormState => ({ treatment_date: today, treatment_name: '', category: '', practitioner: '', amount: '', next_visit_date: '', notes: '' });
export const formFromRecord = (record: Treatment): FormState => ({
  treatment_date: record.treatment_date, treatment_name: record.treatment_name, category: record.category, practitioner: record.practitioner,
  amount: record.amount ?? '', next_visit_date: record.next_visit_date ?? '', notes: record.notes,
});
export const formDirty = (form: FormState, baseline: FormState) => (Object.keys(form) as (keyof FormState)[]).some((key) => form[key] !== baseline[key]);

export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(2000, month - 1, day));
  date.setUTCFullYear(year);
  return year >= 1 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** 서버(zod)와 같은 규칙으로 화면 입력을 검증한다. 실패하면 사용자에게 보여줄 문구를 돌려준다. */
export function validateForm(form: FormState): { values: TreatmentValues } | { error: string } {
  const name = form.treatment_name.trim();
  if (!name) return { error: '시술명을 입력하세요.' };
  if (name.length > 200) return { error: '시술명은 200자 이내로 입력하세요.' };
  if (form.category.trim().length > 100 || form.practitioner.trim().length > 100) return { error: '분류와 담당자는 100자 이내로 입력하세요.' };
  const date = form.treatment_date.trim();
  const next = form.next_visit_date.trim();
  if (!isCalendarDate(date) || (next && !isCalendarDate(next))) return { error: '날짜는 YYYY-MM-DD 형식으로 입력하세요.' };
  if (next && next < date) return { error: '다음 방문일은 시술일 이후여야 합니다.' };
  if (form.notes.length > 10_000) return { error: '시술 내용은 10,000자 이내로 입력하세요.' };
  const amount = form.amount.trim();
  if (amount && !/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(amount)) return { error: '금액은 0 이상, 1조 미만의 소수 두 자리까지 입력하세요.' };
  return { values: { treatment_date: date, treatment_name: name, category: form.category.trim(), practitioner: form.practitioner.trim(), notes: form.notes, amount: amount || null, next_visit_date: next || null } };
}

// ---- 상담·고객 주의사항 ----
export type Cautions = { allergies: string; skin_type: string | null; concerns: string[] };
export const cautionSnapshot = (customer: Customer): Cautions => ({ allergies: customer.allergies, skin_type: customer.skin_type, concerns: [...customer.concerns] });

/** 서버 jsonb의 키 순서와 무관하게 확인 당시 주의정보가 현재 고객 정보와 같은지 비교한다. */
export function sameCautions(snapshot: Record<string, unknown>, customer: Customer): boolean {
  const current = cautionSnapshot(customer);
  const concerns = snapshot.concerns;
  return Object.keys(snapshot).length === 3 && snapshot.allergies === current.allergies && snapshot.skin_type === current.skin_type
    && Array.isArray(concerns) && concerns.length === current.concerns.length && concerns.every((item, index) => item === current.concerns[index]);
}

export const cautionsAcknowledged = (record: Treatment) => Boolean(record.cautions_acknowledged_by && record.cautions_acknowledged_at);
export const consultationReady = (record: Treatment, customer: Customer) =>
  Boolean(record.consultation_goal.trim()) && cautionsAcknowledged(record) && sameCautions(record.cautions_snapshot, customer);

// ---- 목록 필터 ----
const compact = (value: string) => value.trim().toLowerCase().replace(/-/g, '');
export const filterCustomers = (customers: Customer[], query: string) => {
  const needle = compact(query);
  return customers.filter((customer) => compact(`${customer.name}${customer.phone ?? ''}`).includes(needle));
};

export type RecordFilters = { query: string; from: string; to: string; category: string };
export const ALL_CATEGORIES = '';
export function filterRecords(records: Treatment[], filters: RecordFilters): Treatment[] {
  const needle = filters.query.trim().toLowerCase();
  return records.filter((record) => `${record.treatment_name} ${record.practitioner} ${record.notes}`.toLowerCase().includes(needle)
    && (!filters.from || record.treatment_date >= filters.from) && (!filters.to || record.treatment_date <= filters.to)
    && (filters.category === ALL_CATEGORIES || record.category === filters.category));
}
export const sortRecords = (records: Treatment[]) => [...records].sort((a, b) => (a.treatment_date === b.treatment_date ? b.id.localeCompare(a.id) : b.treatment_date.localeCompare(a.treatment_date)));

// ---- 변경 이력 ----
const show = (value: unknown) => (value === null || value === undefined ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value));
export function eventChanges(event: TreatmentEvent): string[] {
  return Object.entries(FIELD_LABELS)
    .filter(([field]) => JSON.stringify(event.before_data[field]) !== JSON.stringify(event.after_data[field]))
    .map(([field, label]) => `${label}: ${show(event.before_data[field])} → ${show(event.after_data[field])}`);
}

/** 오류 상태 코드를 사용자 문구용으로 꺼낸다. */
export const errorStatus = (error: unknown): number | undefined => (typeof error === 'object' && error !== null && 'status' in error ? Number((error as { status: unknown }).status) : undefined);
