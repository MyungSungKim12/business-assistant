import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { buildDraft, combineNotes, defaultChoice, emailKey, fieldOptions, findDuplicateGroups, phoneKey, resolveDraft, unionTags } from './duplicates';
import { newThisMonth, recentlyRegistered } from './insights';
import { filterCustomers, matchesCustomer, searchPath, sortCustomers, trySearchCustomers } from './customerSearch';
import { isMergeArchive, restoreConfirmText } from './restore';
import type { Customer } from './types';

const make = (id: string, extra: Partial<Customer> = {}): Customer => ({
  id, organization_id: 'o', name: `고객${id}`, email: null, phone: null, notes: '', birth_date: null, skin_type: null, concerns: [], allergies: '',
  last_visit_date: null, next_visit_date: null, tags: [], status: 'active', ...extra,
});

describe('searchPath', () => {
  it('sends status, sort and page size and only adds q and cursor when present', () => {
    expect(searchPath('org', { q: '', status: 'active', sort: 'name' })).toBe('/organizations/org/customers/search?status=active&sort=name&limit=200');
    const path = searchPath('org', { q: ' 김 ', status: 'all', sort: 'created_at', limit: 50, cursor: 'abc' });
    expect(path).toContain('q=%EA%B9%80');
    expect(path).toContain('cursor=abc');
    expect(path).toContain('limit=50');
  });
});

describe('trySearchCustomers', () => {
  const failing = (error: unknown) => ({ call: vi.fn(async () => { throw error; }) }) as unknown as ApiClient;
  it('returns null (use the full list) for old servers and missing client support, but rethrows auth errors', async () => {
    expect(await trySearchCustomers(failing(new ApiError(404, 'NOT_FOUND', 'x', false)), 'org', { q: '', status: 'all', sort: 'name' })).toBeNull();
    expect(await trySearchCustomers({} as ApiClient, 'org', { q: '', status: 'all', sort: 'name' })).toBeNull();
    await expect(trySearchCustomers(failing(new ApiError(403, 'FORBIDDEN', 'x', false)), 'org', { q: '', status: 'all', sort: 'name' })).rejects.toBeInstanceOf(ApiError);
  });
});

describe('local filtering and sorting', () => {
  const rows = [
    make('a', { name: '다고객', phone: '010-1234-5678', created_at: '2026-10-01T00:00:00Z', last_visit_date: '2026-09-01' }),
    make('b', { name: '가고객', email: 'Kim@Example.com', tags: ['VIP'], created_at: '2026-10-10T00:00:00Z' }),
    make('c', { name: '나고객', status: 'archived', last_visit_date: '2026-10-02' }),
  ];
  it('matches name, phone digits, email and tags', () => {
    expect(matchesCustomer(rows[0]!, '01012345678')).toBe(true);
    expect(matchesCustomer(rows[0]!, '1234')).toBe(true);
    expect(matchesCustomer(rows[1]!, 'kim@example')).toBe(true);
    expect(matchesCustomer(rows[1]!, 'vip')).toBe(true);
    expect(matchesCustomer(rows[2]!, '없는말')).toBe(false);
  });
  it('filters by status and sorts by name, newest registration and latest visit with blanks last', () => {
    expect(filterCustomers(rows, { query: '', status: 'active', sort: 'name' }).map((row) => row.id)).toEqual(['b', 'a']);
    expect(filterCustomers(rows, { query: '', status: 'all', sort: 'name' }).map((row) => row.id)).toEqual(['b', 'c', 'a']);
    expect(sortCustomers(rows, 'created_at').map((row) => row.id)).toEqual(['b', 'a', 'c']);
    expect(sortCustomers(rows, 'last_visit_date').map((row) => row.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('new-this-month and recent registration insights', () => {
  const today = '2026-10-13';
  it('counts active customers created this month in KST and returns null without any created_at', () => {
    const rows = [
      make('1', { created_at: '2026-09-30T15:00:00Z' }), // KST 10/1
      make('2', { created_at: '2026-09-30T14:59:59Z' }), // KST 9/30
      make('3', { created_at: '2026-10-05T00:00:00Z', status: 'archived' }),
    ];
    expect(newThisMonth(rows, today)).toEqual({ count: 1 });
    expect(newThisMonth([make('x')], today)).toEqual({ count: null });
  });
  it('lists the newest active registrations first and skips customers without a date', () => {
    const rows = [make('old', { created_at: '2026-01-01T00:00:00Z' }), make('new', { created_at: '2026-10-12T10:00:00Z' }), make('none'), make('gone', { created_at: '2026-10-13T00:00:00Z', status: 'archived' })];
    expect(recentlyRegistered(rows).map((item) => item.customer.id)).toEqual(['new', 'old']);
    expect(recentlyRegistered(rows, 1)).toHaveLength(1);
    expect(recentlyRegistered(rows)[0]!.createdDate).toBe('2026-10-12');
  });
});

describe('findDuplicateGroups', () => {
  it('normalizes phone numbers to digits and emails to lower case and ignores short or archived values', () => {
    expect(phoneKey('010-1234-5678')).toBe('01012345678');
    expect(phoneKey('123')).toBe('');
    expect(emailKey(' A@B.com ')).toBe('a@b.com');
  });

  it('groups by phone or email and chains overlapping groups', () => {
    const rows = [
      make('1', { name: '김가', phone: '010-1111-2222', created_at: '2026-01-01T00:00:00Z' }),
      make('2', { name: '김나', phone: '01011112222', email: 'x@x.com', created_at: '2026-02-01T00:00:00Z' }),
      make('3', { name: '김다', email: 'X@x.com' }),
      make('4', { name: '이라', phone: '010-9999-0000' }),
      make('5', { name: '이마', phone: '010-9999-0000', status: 'archived' }),
      make('6', { name: '박바', phone: '12-34' }), make('7', { name: '박사', phone: '12-34' }),
    ];
    const groups = findDuplicateGroups(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.customers.map((row) => row.id)).toEqual(['3', '1', '2']);
    expect(groups[0]!.reasons).toEqual(['phone', 'email']);
  });

  it('returns nothing when every contact differs', () => {
    expect(findDuplicateGroups([make('1', { phone: '010-1111-2222' }), make('2', { phone: '010-3333-4444' })])).toEqual([]);
  });
});

describe('merge draft', () => {
  const primary = make('p', { name: '김대표', phone: '010-1111-2222', notes: '대표 메모', tags: ['VIP', '재방문'], concerns: ['건조'], last_visit_date: '2026-09-01' });
  const other = make('s', { name: '김보조', phone: '010-1111-2222', email: 'a@b.com', notes: '보조 메모', tags: ['재방문', '신규'], concerns: ['건조', '민감'], last_visit_date: '2026-10-01', skin_type: '지성' });

  it('offers distinct non-empty values with the primary first and defaults to the primary value', () => {
    expect(fieldOptions('phone', primary, [other])).toEqual([{ customerId: 'p', value: '010-1111-2222' }]);
    expect(fieldOptions('email', primary, [other])).toEqual([{ customerId: 's', value: 'a@b.com' }]);
    const choice = defaultChoice(primary, [other]);
    expect(choice.name).toBe('p');
    expect(choice.email).toBe('s');
    expect(choice.last_visit_date).toBe('s');
  });

  it('merges notes, tags and concerns without duplicates', () => {
    expect(combineNotes(primary, [other])).toBe('대표 메모\n\n[병합: 김보조]\n보조 메모');
    expect(combineNotes(primary, [make('x', { notes: '대표 메모' }), make('y', { notes: '  ' })])).toBe('대표 메모');
    expect(combineNotes(make('e'), [other])).toBe('보조 메모');
    expect(unionTags([primary, other])).toEqual(['VIP', '재방문', '신규']);
  });

  it('resolves the chosen values into the payload sent to the server', () => {
    const draft = buildDraft([primary, other], 'p');
    expect(draft.concerns).toEqual(['건조', '민감']);
    const resolved = resolveDraft([primary, other], { ...draft, choice: { ...draft.choice, name: 's' } });
    expect(resolved).toMatchObject({ name: '김보조', phone: '010-1111-2222', email: 'a@b.com', skin_type: '지성', last_visit_date: '2026-10-01', birth_date: null, allergies: '' });
    expect(resolved.tags).toEqual(['VIP', '재방문', '신규']);
    expect(resolved.notes).toContain('보조 메모');
  });

  it('rebuilds the draft around another primary', () => {
    expect(buildDraft([primary, other], 's').primaryId).toBe('s');
    expect(buildDraft([primary, other], 's').notes).toBe('보조 메모\n\n[병합: 김대표]\n대표 메모');
  });
});

describe('restore helpers', () => {
  it('detects merge-archived customers and warns before restoring them', () => {
    const merged = make('m', { status: 'archived', notes: '메모\n\n[병합되어 보관됨: 김대표]' });
    expect(isMergeArchive(merged)).toBe(true);
    expect(isMergeArchive(make('n', { status: 'archived' }))).toBe(false);
    expect(isMergeArchive(make('a', { notes: '[병합되어 보관됨: x]' }))).toBe(false);
    expect(restoreConfirmText([make('n', { name: '홍길동', status: 'archived' })])).toBe("'홍길동' 고객을 활성 고객으로 되돌립니다.");
    expect(restoreConfirmText([merged, make('n', { status: 'archived' })])).toContain('1명은 다른 고객에 병합되어');
  });
});
