import type { ParsedTable } from '../../../lib/io/readTable';
import type { Customer } from '../types';
import { mappedRecord, type Mapping } from './fields';
import { emailKey, phoneKey, validateRecord, type ImportInput } from './validate';

export type DuplicatePolicy = 'skip' | 'overwrite';

export interface PlanRow {
  /** 파일에서의 행 번호(머리글이 1행) */
  sourceRow: number;
  cells: string[];
  input: ImportInput;
  errors: string[];
  /** 이미 등록된 고객과 연락처·이메일이 같을 때 */
  match?: { id: string; name: string; by: 'phone' | 'email' };
}

export interface ExistingIndex {
  byPhone: Map<string, Customer>;
  byEmail: Map<string, Customer>;
}

export function indexExisting(customers: readonly Customer[]): ExistingIndex {
  const byPhone = new Map<string, Customer>();
  const byEmail = new Map<string, Customer>();
  for (const customer of customers) {
    const phone = phoneKey(customer.phone);
    if (phone && !byPhone.has(phone)) byPhone.set(phone, customer);
    const email = emailKey(customer.email);
    if (email && !byEmail.has(email)) byEmail.set(email, customer);
  }
  return { byPhone, byEmail };
}

/** 연락처 → 이메일 순서로 기존 고객을 찾는다. */
export function findExisting(input: { phone?: string | null; email?: string | null }, index: ExistingIndex): PlanRow['match'] | undefined {
  const phone = phoneKey(input.phone);
  const byPhone = phone ? index.byPhone.get(phone) : undefined;
  if (byPhone) return { id: byPhone.id, name: byPhone.name, by: 'phone' };
  const email = emailKey(input.email);
  const byEmail = email ? index.byEmail.get(email) : undefined;
  if (byEmail) return { id: byEmail.id, name: byEmail.name, by: 'email' };
  return undefined;
}

/** 표 전체를 검증하고 기존 고객·파일 안 중복을 표시한다. 오류가 있는 행은 errors가 채워진다. */
export function buildPlan(table: ParsedTable, mapping: Mapping, existing: readonly Customer[]): PlanRow[] {
  const index = indexExisting(existing);
  const seenPhone = new Map<string, number>();
  const seenEmail = new Map<string, number>();
  return table.rows.map((row) => {
    const { input, errors } = validateRecord(mappedRecord(row.cells, mapping));
    const plan: PlanRow = { sourceRow: row.sourceRow, cells: row.cells, input, errors: [...errors] };
    if (errors.length > 0) return plan;

    const phone = phoneKey(input.phone);
    const email = emailKey(input.email);
    const phoneRow = phone ? seenPhone.get(phone) : undefined;
    const emailRow = email ? seenEmail.get(email) : undefined;
    if (phoneRow !== undefined) plan.errors.push(`${phoneRow}행과 연락처가 같습니다. (파일 안 중복)`);
    else if (emailRow !== undefined) plan.errors.push(`${emailRow}행과 이메일이 같습니다. (파일 안 중복)`);
    if (plan.errors.length > 0) return plan;
    if (phone) seenPhone.set(phone, row.sourceRow);
    if (email) seenEmail.set(email, row.sourceRow);

    plan.match = findExisting(input, index);
    return plan;
  });
}

export interface PlanSummary {
  total: number;
  errors: number;
  duplicates: number;
  creates: number;
}

export function summarizePlan(plan: readonly PlanRow[]): PlanSummary {
  const errors = plan.filter((row) => row.errors.length > 0).length;
  const duplicates = plan.filter((row) => row.errors.length === 0 && row.match).length;
  return { total: plan.length, errors, duplicates, creates: plan.length - errors - duplicates };
}
