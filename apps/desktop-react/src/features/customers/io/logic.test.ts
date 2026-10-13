import { describe, expect, it } from 'vitest';
import { tableFromGrid } from '../../../lib/io/readTable';
import type { Customer } from '../types';
import { assignField, guessMapping, normalizeHeader } from './fields';
import { buildPlan, summarizePlan } from './plan';
import { phoneKey, splitList, tidyPhone, validateRecord } from './validate';

const existing = (patch: Partial<Customer>): Customer => ({
  id: '11111111-1111-4111-8111-111111111111', organization_id: '22222222-2222-4222-8222-222222222222', name: '기존', email: null, phone: null, notes: '',
  birth_date: null, skin_type: null, concerns: [], allergies: '', last_visit_date: null, next_visit_date: null, tags: [], status: 'active', ...patch,
});

describe('guessMapping', () => {
  it('maps Korean and English header synonyms, ignoring spaces, case and parenthetical notes', () => {
    const headers = ['이름 (필수)', 'Phone', 'E-mail', '태그', '상태', '피부 타입', '생년월일', '최근 방문일', 'Next Visit', '고민', '알레르기', '비고', '기타'];
    expect(guessMapping(headers)).toEqual(['name', 'phone', 'email', 'tags', 'status', 'skin_type', 'birth_date', 'last_visit_date', 'next_visit_date', 'concerns', 'allergies', 'notes', null]);
  });

  it('assigns each field to one column only (first wins)', () => {
    expect(guessMapping(['이름', '고객명', '전화', '휴대폰'])).toEqual(['name', null, 'phone', null]);
  });

  it('normalizes headers', () => {
    expect(normalizeHeader(' Last_Visit-Date ')).toBe('lastvisitdate');
  });

  it('moves a field when the user reassigns it to another column', () => {
    expect(assignField(['name', 'phone', null], 2, 'phone')).toEqual(['name', null, 'phone']);
    expect(assignField(['name', 'phone', null], 1, null)).toEqual(['name', null, null]);
  });
});

describe('validateRecord', () => {
  it('requires a name', () => {
    expect(validateRecord({ name: '  ' }).errors).toContain('이름이 비어 있습니다.');
    expect(validateRecord({}).errors).toHaveLength(1);
  });

  it('normalizes dates, status, tags and the Excel numeric phone without a leading zero', () => {
    const { input, errors } = validateRecord({
      name: ' 김고객 ', phone: '1012345678', email: 'A@B.com', birth_date: '45292', last_visit_date: '2024.3.5', next_visit_date: '20250102',
      status: '보관', tags: 'VIP, 재방문，VIP;신규', concerns: '건조, 홍조', skin_type: '건성', notes: '메모', allergies: '없음',
    });
    expect(errors).toEqual([]);
    expect(input).toEqual({
      name: '김고객', phone: '01012345678', email: 'A@B.com', birth_date: '2024-01-01', last_visit_date: '2024-03-05', next_visit_date: '2025-01-02',
      status: 'archived', tags: ['VIP', '재방문', '신규'], concerns: ['건조', '홍조'], skin_type: '건성', notes: '메모', allergies: '없음',
    });
  });

  it('omits empty cells so overwrite does not blank existing data', () => {
    const { input } = validateRecord({ name: '김', phone: '', email: ' ', tags: '' });
    expect(input).toEqual({ name: '김' });
  });

  it('reports each invalid field', () => {
    const { errors } = validateRecord({ name: '김', phone: 'abc', email: 'not-mail', birth_date: '2024-02-30', status: '??', tags: Array.from({ length: 31 }, (_, i) => `t${i}`).join(',') });
    expect(errors).toHaveLength(5);
    const text = errors.join('|');
    for (const word of ['연락처', '이메일', '생일', '상태', '태그']) expect(text).toContain(word);
  });

  it('enforces tag length (50) and name length (200)', () => {
    expect(validateRecord({ name: '김', tags: 'a'.repeat(51) }).errors[0]).toContain('50자');
    expect(validateRecord({ name: 'a'.repeat(201) }).errors[0]).toContain('200자');
    expect(validateRecord({ name: 'a'.repeat(200), tags: 'a'.repeat(50) }).errors).toEqual([]);
  });

  it('undoes the export-time formula guard', () => {
    expect(validateRecord({ name: "'=SUM(1)" }).input.name).toBe('=SUM(1)');
  });
});

describe('phone keys', () => {
  it('treats hyphen, space, country code and missing leading zero as the same number', () => {
    const keys = ['010-1234-5678', '01012345678', '010 1234 5678', '+82 10-1234-5678', '1012345678', '(010)1234.5678'].map(phoneKey);
    expect(new Set(keys)).toEqual(new Set(['01012345678']));
  });

  it('returns null for empty or too short numbers', () => {
    expect(phoneKey('')).toBeNull();
    expect(phoneKey('123')).toBeNull();
    expect(phoneKey(null)).toBeNull();
  });

  it('only fixes numeric mobile numbers', () => {
    expect(tidyPhone('1012345678')).toBe('01012345678');
    expect(tidyPhone('02-123-4567')).toBe('02-123-4567');
    expect(tidyPhone('2123456')).toBe('2123456');
  });
});

describe('splitList', () => {
  it('splits on commas, drops blanks and duplicates', () => {
    expect(splitList(' a, ,b,,a ')).toEqual(['a', 'b']);
  });
});

describe('buildPlan', () => {
  const table = tableFromGrid([
    ['이름', '연락처', '이메일'],
    ['신규', '010-1111-2222', ''],
    ['중복 하이픈', '01099998888', ''],
    ['중복 이메일', '', 'Dup@Example.com'],
    ['오류', 'xx', ''],
    ['파일 안 중복', '010 1111 2222', ''],
    ['', '', ''],
    ['', '010-5555-6666', ''],
  ]);
  const customers = [
    existing({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: '김기존', phone: '010-9999-8888' }),
    existing({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: '이기존', email: 'dup@example.com' }),
  ];

  it('detects duplicates by phone (ignoring formatting) or e-mail, plus file-internal duplicates and errors', () => {
    const plan = buildPlan(table, ['name', 'phone', 'email'], customers);
    expect(plan.map((row) => row.sourceRow)).toEqual([2, 3, 4, 5, 6, 8]);
    expect(plan[0].match).toBeUndefined();
    expect(plan[1].match).toMatchObject({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', by: 'phone' });
    expect(plan[2].match).toMatchObject({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', by: 'email' });
    expect(plan[3].errors[0]).toContain('연락처 형식');
    expect(plan[4].errors[0]).toContain('2행과 연락처가 같습니다');
    expect(plan[5].errors[0]).toContain('이름');
    expect(summarizePlan(plan)).toEqual({ total: 6, errors: 3, duplicates: 2, creates: 1 });
  });

  it('keeps blank rows out of the plan and keeps the original row numbers', () => {
    expect(table.blankRows).toBe(1);
  });
});
