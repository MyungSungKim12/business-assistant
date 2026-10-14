import { z } from 'zod';
import type { ApiClient } from '../../api/client';
import { cents, moneyText } from './format';
import { isMonthKey } from './ledger';

/** FIN-11 반복 지출. 매달 나가는 지출을 템플릿으로 저장하고, 월마다 한 번에 등록한다. */
export const recurringSchema = z.object({
  id: z.string(), organization_id: z.string(), name: z.string(), amount: z.string(), category: z.string(), counterparty: z.string(), memo: z.string(),
  day_of_month: z.number().int(), is_active: z.boolean(), version: z.number().int(), updated_at: z.string(),
});
export const recurringListSchema = z.array(recurringSchema);
export type RecurringExpense = z.infer<typeof recurringSchema>;
export const recurringRunSchema = z.object({ recurring_id: z.string(), organization_id: z.string(), month: z.string(), transaction_id: z.string().nullable() });
export const recurringRunsSchema = z.array(recurringRunSchema);
export const generateResultSchema = z.object({ month: z.string(), created: z.number().int(), skipped: z.number().int(), transaction_ids: z.array(z.string()) });
export type GenerateResult = z.infer<typeof generateResultSchema>;

export type RecurringForm = { name: string; amount: string; category: string; day_of_month: string; counterparty: string; memo: string; is_active: boolean };
export const blankRecurring = (): RecurringForm => ({ name: '', amount: '', category: '', day_of_month: '1', counterparty: '', memo: '', is_active: true });
export const recurringToForm = (item: RecurringExpense): RecurringForm => ({
  name: item.name, amount: item.amount.replace(/\.00$/, ''), category: item.category, day_of_month: String(item.day_of_month),
  counterparty: item.counterparty, memo: item.memo, is_active: item.is_active,
});

export type RecurringInput = { name: string; amount: string; category: string; day_of_month: number; counterparty: string; memo: string; is_active: boolean };

/** 입력을 서버 규칙(금액 0 초과·소수 둘째 자리, 날짜 1~31, 글자 수)으로 검사한다. 통과하면 정리된 값, 아니면 안내 문구. */
export function validateRecurring(form: RecurringForm): { value: RecurringInput } | { error: string } {
  const name = form.name.trim();
  const category = form.category.trim();
  const amount = form.amount.trim().replace(/,/g, '');
  const day = Number(form.day_of_month);
  if (!name) return { error: '이름을 입력하세요.' };
  if (name.length > 120) return { error: '이름은 120자 이내로 입력하세요.' };
  if (!moneyText.test(amount) || (cents(amount) ?? 0n) <= 0n) return { error: '금액은 0보다 큰 원 단위 숫자(소수 둘째 자리까지)로 입력하세요.' };
  if (!category) return { error: '분류를 입력하세요.' };
  if (category.length > 200) return { error: '분류는 200자 이내로 입력하세요.' };
  if (!Number.isInteger(day) || day < 1 || day > 31) return { error: '날짜는 1~31 사이로 입력하세요.' };
  if (form.counterparty.length > 5000 || form.memo.length > 5000) return { error: '거래처와 메모는 5,000자 이내로 입력하세요.' };
  return { value: { name, amount, category, day_of_month: day, counterparty: form.counterparty, memo: form.memo, is_active: form.is_active } };
}

/** 그 달에 실제로 등록되는 날짜. 31일 같은 값은 그 달의 마지막 날로 맞춘다(서버와 같은 규칙). */
export function dueDay(month: string, dayOfMonth: number): string {
  const [year, mon] = month.split('-').map(Number);
  const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return `${month}-${String(Math.min(dayOfMonth, last)).padStart(2, '0')}`;
}

export type RecurringStatus = 'registered' | 'pending' | 'inactive';
/** 달별 상태: 이미 등록됨 / 등록 대기 / 비활성(등록 안 함). */
export function recurringStatus(item: RecurringExpense, registeredIds: ReadonlySet<string>): RecurringStatus {
  if (registeredIds.has(item.id)) return 'registered';
  return item.is_active ? 'pending' : 'inactive';
}

export const pendingCount = (items: RecurringExpense[], registeredIds: ReadonlySet<string>) => items.filter((item) => recurringStatus(item, registeredIds) === 'pending').length;

/** 서버 규칙: 다음 달보다 먼 미래는 등록할 수 없다. */
export function monthTooFar(month: string, todayKey: string): boolean {
  if (!isMonthKey(month)) return false;
  const [year, mon] = todayKey.slice(0, 7).split('-').map(Number);
  const next = new Date(Date.UTC(year, mon, 1));
  const limit = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
  return month > limit;
}

const base = (organizationId: string) => `/organizations/${organizationId}/finance-recurring-expenses`;
export const recurringApi = {
  list: (api: ApiClient, organizationId: string) => api.call('GET', base(organizationId), recurringListSchema),
  runs: (api: ApiClient, organizationId: string, month: string) => api.call('GET', `${base(organizationId)}/runs?month=${month}`, recurringRunsSchema),
  create: (api: ApiClient, organizationId: string, input: RecurringInput) => api.call('POST', base(organizationId), recurringSchema, input),
  update: (api: ApiClient, organizationId: string, id: string, input: Partial<RecurringInput> & { expected_version: number }) => api.call('PATCH', `${base(organizationId)}/${id}`, recurringSchema, input),
  remove: (api: ApiClient, organizationId: string, id: string) => api.callVoid('DELETE', `${base(organizationId)}/${id}`),
  generate: (api: ApiClient, organizationId: string, month: string) => api.call('POST', `${base(organizationId)}/generate`, generateResultSchema, { month }),
};
