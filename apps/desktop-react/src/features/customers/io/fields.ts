/** 고객 가져오기의 열 정의와 헤더 자동 매핑(한글/영문 동의어). */

export type FieldKey =
  | 'name' | 'phone' | 'email' | 'tags' | 'status' | 'skin_type' | 'birth_date'
  | 'last_visit_date' | 'next_visit_date' | 'concerns' | 'allergies' | 'notes';

export interface FieldDef {
  key: FieldKey;
  label: string;
  required?: boolean;
  /** 정규화된 헤더(공백·기호 제거, 소문자)와 비교하는 동의어 */
  synonyms: readonly string[];
}

export const FIELD_DEFS: readonly FieldDef[] = [
  { key: 'name', label: '이름', required: true, synonyms: ['이름', '고객명', '고객이름', '성명', '성함', 'name', 'customer', 'customername', 'fullname'] },
  { key: 'phone', label: '연락처', synonyms: ['연락처', '전화번호', '전화', '휴대폰', '휴대전화', '핸드폰', '휴대폰번호', 'phone', 'phonenumber', 'mobile', 'tel', 'cell'] },
  { key: 'email', label: '이메일', synonyms: ['이메일', '메일', '이메일주소', 'email', 'emailaddress', 'mail'] },
  { key: 'tags', label: '태그', synonyms: ['태그', '분류', '그룹', 'tags', 'tag', 'label', 'labels'] },
  { key: 'status', label: '상태', synonyms: ['상태', '고객상태', 'status'] },
  { key: 'skin_type', label: '피부타입', synonyms: ['피부타입', '피부유형', '피부', 'skintype', 'skin'] },
  { key: 'birth_date', label: '생일', synonyms: ['생일', '생년월일', '생년', 'birth', 'birthday', 'birthdate', 'dob', 'dateofbirth'] },
  { key: 'last_visit_date', label: '최근 방문', synonyms: ['최근방문', '최근방문일', '마지막방문', '마지막방문일', '최종방문', 'lastvisit', 'lastvisitdate'] },
  { key: 'next_visit_date', label: '다음 방문', synonyms: ['다음방문', '다음방문일', '다음예약', '방문예정', '예약일', 'nextvisit', 'nextvisitdate'] },
  { key: 'concerns', label: '고민', synonyms: ['고민', '피부고민', 'concerns', 'concern'] },
  { key: 'allergies', label: '알레르기', synonyms: ['알레르기', '알러지', 'allergies', 'allergy'] },
  { key: 'notes', label: '메모', synonyms: ['메모', '비고', '특이사항', '참고', 'notes', 'note', 'memo', 'remark', 'remarks', 'comment', 'comments'] },
];

export const FIELD_LABEL: Record<FieldKey, string> = Object.fromEntries(FIELD_DEFS.map((def) => [def.key, def.label])) as Record<FieldKey, string>;

/** 헤더 비교용 정규화: 괄호 안 설명 제거, 공백·_·-·. 제거, 소문자. 예: "연락처 (필수)" → "연락처". */
export function normalizeHeader(header: string): string {
  return header
    .replace(/[(（][^)）]*[)）]/g, '')
    .replace(/[\s_\-.·*]/g, '')
    .toLowerCase();
}

export type Mapping = (FieldKey | null)[];

/** 열마다 가장 알맞은 필드를 추정한다. 한 필드는 한 열에만 배정한다(먼저 나온 열 우선). */
export function guessMapping(headers: readonly string[]): Mapping {
  const used = new Set<FieldKey>();
  return headers.map((header) => {
    const normalized = normalizeHeader(header);
    if (!normalized) return null;
    const found = FIELD_DEFS.find((def) => !used.has(def.key) && def.synonyms.includes(normalized));
    if (!found) return null;
    used.add(found.key);
    return found.key;
  });
}

/** 한 열의 배정을 바꾼다. 이미 다른 열에 있던 같은 필드는 '무시'로 돌린다. */
export function assignField(mapping: Mapping, columnIndex: number, field: FieldKey | null): Mapping {
  return mapping.map((current, index) => {
    if (index === columnIndex) return field;
    return field !== null && current === field ? null : current;
  });
}

export function mappedRecord(cells: readonly string[], mapping: Mapping): Partial<Record<FieldKey, string>> {
  const record: Partial<Record<FieldKey, string>> = {};
  mapping.forEach((field, index) => {
    if (field) record[field] = cells[index] ?? '';
  });
  return record;
}
