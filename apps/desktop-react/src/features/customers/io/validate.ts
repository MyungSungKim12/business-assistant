import { normalizeDate } from '../../../lib/io/dates';
import { restoreNeutralized } from '../../../lib/io/sanitize';
import type { CustomerInput } from '../types';
import type { FieldKey } from './fields';

/** 서버(apps/api customers.ts createInput)와 같은 한도. */
export const LIMITS = {
  name: 200, email: 255, phone: 50, notes: 5_000, skinType: 100, concerns: 30, concernLength: 100, allergies: 1_000, tags: 30, tagLength: 50,
} as const;

export type RawRecord = Partial<Record<FieldKey, string>>;
/** 값이 있는 필드만 담는다. 생성에는 기본값을 채우고, 덮어쓰기(PATCH)에는 이 값만 보낸다. */
export type ImportInput = Partial<CustomerInput> & { name: string };

export interface ValidatedRow {
  input: ImportInput;
  errors: string[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_CHARS = /^[0-9+\-\s().]+$/;
const ACTIVE = new Set(['active', '활성', '사용', '사용중', '이용중', '정상', '현재고객', 'y', 'yes']);
const ARCHIVED = new Set(['archived', 'archive', '보관', '보관고객', '비활성', '탈퇴', '중단', '휴면', 'inactive', 'n', 'no']);

const clean = (value: string | undefined): string => restoreNeutralized((value ?? '').trim());

/**
 * 연락처 표기 보정: 엑셀이 숫자로 저장하며 앞의 0이 빠진 휴대전화(1012345678)에 0을 되돌린다.
 * 그 밖의 값은 입력한 모양 그대로 둔다.
 */
export function tidyPhone(value: string): string {
  return /^1[016-9]\d{7,8}$/.test(value) ? `0${value}` : value;
}

/** 중복 판정용 연락처 키: 숫자만, +82 국가번호는 0으로. 숫자가 7자리 미만이면 null. */
export function phoneKey(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  let digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+82') || (digits.startsWith('82') && digits.length >= 11)) {
    digits = digits.slice(2);
    if (!digits.startsWith('0')) digits = `0${digits}`;
  } else if (/^1[016-9]\d{7,8}$/.test(digits)) {
    digits = `0${digits}`;
  }
  return digits.length >= 7 ? digits : null;
}

export function emailKey(value: string | null | undefined): string | null {
  const text = (value ?? '').trim().toLowerCase();
  return text || null;
}

/** 쉼표(,，)·세미콜론·줄바꿈으로 나눈 목록. 빈 항목과 중복은 제거한다. */
export function splitList(value: string): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const part of value.split(/[,，;；\n]/)) {
    const item = restoreNeutralized(part.trim());
    if (item && !seen.has(item)) {
      seen.add(item);
      items.push(item);
    }
  }
  return items;
}

export function parseStatus(value: string): 'active' | 'archived' | null {
  const key = value.replace(/\s/g, '').toLowerCase();
  if (ACTIVE.has(key)) return 'active';
  if (ARCHIVED.has(key)) return 'archived';
  return null;
}

function checkList(label: string, value: string, maxItems: number, maxLength: number, errors: string[]): string[] | undefined {
  const items = splitList(value);
  if (items.length === 0) return undefined;
  if (items.length > maxItems) errors.push(`${label} 개수는 최대 ${maxItems}개입니다. (${items.length}개)`);
  else if (items.some((item) => item.length > maxLength)) errors.push(`${label} 항목 하나는 ${maxLength}자 이하여야 합니다.`);
  return items;
}

function checkDate(label: string, value: string, errors: string[]): string | undefined {
  if (!value) return undefined;
  const date = normalizeDate(value);
  if (!date) errors.push(`${label} 형식이 올바르지 않습니다. (YYYY-MM-DD)`);
  return date ?? undefined;
}

function checkText(label: string, value: string, max: number, errors: string[]): string | undefined {
  if (!value) return undefined;
  if (value.length > max) errors.push(`${label} 길이는 ${max.toLocaleString('ko-KR')}자 이하여야 합니다.`);
  return value;
}

/** 한 행을 검증하고 서버 입력 모양으로 바꾼다. 매핑되지 않았거나 빈 칸인 필드는 결과에 넣지 않는다. */
export function validateRecord(record: RawRecord): ValidatedRow {
  const errors: string[] = [];
  const input: ImportInput = { name: '' };

  const name = clean(record.name);
  if (!name) errors.push('이름이 비어 있습니다.');
  else if (name.length > LIMITS.name) errors.push(`이름은 ${LIMITS.name}자 이하여야 합니다.`);
  input.name = name;

  const phone = tidyPhone(clean(record.phone));
  if (phone) {
    if (phone.length > LIMITS.phone) errors.push(`연락처는 ${LIMITS.phone}자 이하여야 합니다.`);
    else if (!PHONE_CHARS.test(phone) || phoneKey(phone) === null) errors.push('연락처 형식이 올바르지 않습니다. (숫자 7자리 이상, 하이픈 가능)');
    else input.phone = phone;
  }

  const email = clean(record.email);
  if (email) {
    if (email.length > LIMITS.email || !EMAIL.test(email)) errors.push('이메일 형식이 올바르지 않습니다.');
    else input.email = email;
  }

  const statusText = clean(record.status);
  if (statusText) {
    const status = parseStatus(statusText);
    if (status) input.status = status;
    else errors.push(`상태 값을 알 수 없습니다. (활성/보관) "${statusText.slice(0, 20)}"`);
  }

  const tags = checkList('태그', clean(record.tags), LIMITS.tags, LIMITS.tagLength, errors);
  if (tags) input.tags = tags;
  const concerns = checkList('고민', clean(record.concerns), LIMITS.concerns, LIMITS.concernLength, errors);
  if (concerns) input.concerns = concerns;

  const skin = checkText('피부타입', clean(record.skin_type), LIMITS.skinType, errors);
  if (skin) input.skin_type = skin;
  const notes = checkText('메모', clean(record.notes), LIMITS.notes, errors);
  if (notes) input.notes = notes;
  const allergies = checkText('알레르기', clean(record.allergies), LIMITS.allergies, errors);
  if (allergies) input.allergies = allergies;

  const birth = checkDate('생일', clean(record.birth_date), errors);
  if (birth) input.birth_date = birth;
  const last = checkDate('최근 방문', clean(record.last_visit_date), errors);
  if (last) input.last_visit_date = last;
  const next = checkDate('다음 방문', clean(record.next_visit_date), errors);
  if (next) input.next_visit_date = next;

  return { input, errors };
}
