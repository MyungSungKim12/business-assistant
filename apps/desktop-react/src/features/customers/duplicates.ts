import type { Customer } from './types';

/** 같은 연락처·이메일을 가진 고객 후보 묶음과 병합 값 결정에 쓰는 순수 함수들. */
export type DuplicateReason = 'phone' | 'email';
export type DuplicateGroup = { key: string; reasons: DuplicateReason[]; customers: Customer[] };

/** 연락처 숫자만 비교할 때 이 자릿수 이상이어야 후보로 본다(내선·짧은 번호 오탐 방지). */
export const MIN_PHONE_DIGITS = 7;

export const phoneKey = (phone: string | null | undefined): string => {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= MIN_PHONE_DIGITS ? digits : '';
};
export const emailKey = (email: string | null | undefined): string => (email ?? '').trim().toLowerCase();

/**
 * 보관되지 않은 고객 중 같은 연락처(숫자만)나 같은 이메일을 가진 고객을 묶는다.
 * A-B가 연락처로, B-C가 이메일로 겹치면 A·B·C를 한 묶음으로 본다. 큰 묶음·이름 순으로 정렬한다.
 */
export function findDuplicateGroups(customers: readonly Customer[]): DuplicateGroup[] {
  const candidates = customers.filter((customer) => customer.status !== 'archived');
  const parent = new Map<string, string>(candidates.map((customer) => [customer.id, customer.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string) => { parent.set(find(a), find(b)); };

  const firstByKey = new Map<string, string>();
  const reasonsByCustomer = new Map<string, Set<DuplicateReason>>();
  const note = (customerId: string, reason: DuplicateReason) => {
    const set = reasonsByCustomer.get(customerId) ?? new Set<DuplicateReason>();
    set.add(reason);
    reasonsByCustomer.set(customerId, set);
  };
  const seen = new Set<string>();
  for (const customer of candidates) {
    const keys: Array<[DuplicateReason, string]> = [['phone', phoneKey(customer.phone)], ['email', emailKey(customer.email)]];
    for (const [reason, key] of keys) {
      if (!key) continue;
      const token = `${reason}:${key}`;
      const first = firstByKey.get(token);
      if (first === undefined) { firstByKey.set(token, customer.id); continue; }
      union(first, customer.id);
      note(first, reason);
      note(customer.id, reason);
      seen.add(first);
      seen.add(customer.id);
    }
  }

  const grouped = new Map<string, Customer[]>();
  for (const customer of candidates) {
    if (!seen.has(customer.id)) continue;
    const root = find(customer.id);
    grouped.set(root, [...(grouped.get(root) ?? []), customer]);
  }
  return [...grouped.entries()]
    .map(([root, members]): DuplicateGroup => ({
      key: root,
      reasons: (['phone', 'email'] as const).filter((reason) => members.some((member) => reasonsByCustomer.get(member.id)?.has(reason))),
      customers: members.slice().sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.name.localeCompare(b.name, 'ko')),
    }))
    .sort((a, b) => b.customers.length - a.customers.length || a.customers[0]!.name.localeCompare(b.customers[0]!.name, 'ko'));
}

export const REASON_LABELS: Record<DuplicateReason, string> = { phone: '같은 연락처', email: '같은 이메일' };

// ---- 병합 값 결정 ----

export const SCALAR_FIELDS = [
  { key: 'name', label: '이름' },
  { key: 'phone', label: '연락처' },
  { key: 'email', label: '이메일' },
  { key: 'birth_date', label: '생년월일' },
  { key: 'skin_type', label: '피부 타입' },
  { key: 'allergies', label: '알레르기' },
  { key: 'last_visit_date', label: '최근 방문일' },
  { key: 'next_visit_date', label: '다음 방문일' },
] as const;
export type ScalarKey = (typeof SCALAR_FIELDS)[number]['key'];
export type ScalarChoice = Record<ScalarKey, string>;

export type MergeResolved = {
  name: string; email: string | null; phone: string | null; birth_date: string | null; skin_type: string | null; allergies: string;
  last_visit_date: string | null; next_visit_date: string | null; notes: string; tags: string[]; concerns: string[];
};

const textOf = (customer: Customer, key: ScalarKey): string => {
  const value = customer[key];
  return typeof value === 'string' ? value.trim() : '';
};

/** 필드별 후보 값(비어 있지 않은 서로 다른 값). 대표 고객의 값이 맨 앞. */
export function fieldOptions(key: ScalarKey, primary: Customer, others: readonly Customer[]): Array<{ customerId: string; value: string }> {
  const options: Array<{ customerId: string; value: string }> = [];
  for (const customer of [primary, ...others]) {
    const value = textOf(customer, key);
    if (value && !options.some((option) => option.value === value)) options.push({ customerId: customer.id, value });
  }
  return options;
}

/** 기본 선택: 대표 고객 값이 있으면 그것, 없으면 첫 후보. 최근 방문일은 가장 늦은 날짜. */
export function defaultChoice(primary: Customer, others: readonly Customer[]): ScalarChoice {
  const choice = {} as ScalarChoice;
  for (const { key } of SCALAR_FIELDS) {
    const options = fieldOptions(key, primary, others);
    if (key === 'last_visit_date' && options.length > 0) {
      choice[key] = options.reduce((best, option) => (option.value > best.value ? option : best)).customerId;
    } else {
      choice[key] = options[0]?.customerId ?? primary.id;
    }
  }
  return choice;
}

const unique = (values: readonly string[]) => [...new Set(values.map((value) => value.trim()).filter(Boolean))];
export const unionTags = (customers: readonly Customer[]) => unique(customers.flatMap((customer) => customer.tags));
export const unionConcerns = (customers: readonly Customer[]) => unique(customers.flatMap((customer) => customer.concerns));

/** 메모 합치기: 대표 메모 뒤에 다른 고객의 메모를 '[병합: 이름]' 머리글과 함께 이어 붙인다(같은 내용·빈 메모는 건너뜀). */
export function combineNotes(primary: Customer, others: readonly Customer[]): string {
  let notes = primary.notes;
  for (const other of others) {
    const extra = other.notes.trim();
    if (!extra || notes.includes(extra)) continue;
    notes = notes.trim() ? `${notes}\n\n[병합: ${other.name}]\n${other.notes}` : other.notes;
  }
  return notes;
}

export type MergeDraft = { primaryId: string; choice: ScalarChoice; notes: string; tags: string[]; concerns: string[] };

/** 대표 고객을 바꾸거나 처음 열 때 쓰는 기본 초안. */
export function buildDraft(group: readonly Customer[], primaryId: string): MergeDraft {
  const primary = group.find((customer) => customer.id === primaryId) ?? group[0]!;
  const others = group.filter((customer) => customer.id !== primary.id);
  return { primaryId: primary.id, choice: defaultChoice(primary, others), notes: combineNotes(primary, others), tags: unionTags([primary, ...others]), concerns: unionConcerns([primary, ...others]) };
}

/** 초안 → 서버로 보낼 최종 값. 선택한 고객의 값을 필드마다 가져온다(비어 있으면 null). */
export function resolveDraft(group: readonly Customer[], draft: MergeDraft): MergeResolved {
  const pick = (key: ScalarKey): string | null => {
    const owner = group.find((customer) => customer.id === draft.choice[key]);
    const value = owner ? textOf(owner, key) : '';
    return value === '' ? null : value;
  };
  return {
    name: pick('name') ?? group.find((customer) => customer.id === draft.primaryId)?.name ?? '',
    phone: pick('phone'), email: pick('email'), birth_date: pick('birth_date'), skin_type: pick('skin_type'),
    allergies: pick('allergies') ?? '', last_visit_date: pick('last_visit_date'), next_visit_date: pick('next_visit_date'),
    notes: draft.notes, tags: draft.tags.slice(0, 30), concerns: draft.concerns.slice(0, 30),
  };
}

/** 병합 전 확인 문구에 쓰는 한 줄 요약. */
export const describeCustomer = (customer: Customer) => [customer.name, customer.phone, customer.email].filter(Boolean).join(' · ');
