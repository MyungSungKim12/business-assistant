import { describe, expect, it } from 'vitest';
import { birthdayCustomers, lapsedCustomers, summarizeCustomers, upcomingVisits } from './insights';
import { daysBetween, kstDate, kstToday } from './kst';
import type { Customer } from './types';

const make = (id: string, extra: Partial<Customer> = {}): Customer => ({
  id, organization_id: 'o', name: `고객${id}`, email: null, phone: null, notes: '', birth_date: null, skin_type: null, concerns: [], allergies: '',
  last_visit_date: null, next_visit_date: null, tags: [], status: 'active', ...extra,
});
const TODAY = '2026-10-13';

describe('kst', () => {
  it('uses the KST calendar day at the UTC boundary', () => {
    expect(kstDate('2026-10-12T14:59:59Z')).toBe('2026-10-12');
    expect(kstDate('2026-10-12T15:00:00Z')).toBe('2026-10-13');
    expect(kstToday(new Date('2026-12-31T16:00:00Z'))).toBe('2027-01-01');
    expect(kstDate('bad')).toBe('');
  });
  it('counts days across month and year ends', () => {
    expect(daysBetween('2026-10-13', '2026-10-20')).toBe(7);
    expect(daysBetween('2026-12-30', '2027-01-02')).toBe(3);
    expect(daysBetween('2026-10-13', '2026-10-01')).toBe(-12);
  });
});

describe('summarizeCustomers', () => {
  it('counts statuses, VIP, this-month visits and top tags without archived customers in tags', () => {
    const rows = [
      make('1', { tags: ['VIP', '재방문'], last_visit_date: '2026-10-02' }),
      make('2', { tags: ['재방문'], last_visit_date: '2026-09-30' }),
      make('3', { tags: ['vip '], status: 'archived', last_visit_date: '2026-10-05' }),
      make('4', { tags: ['신규', '재방문', '재방문'] }),
    ];
    const summary = summarizeCustomers(rows, TODAY);
    expect(summary).toMatchObject({ total: 4, active: 3, archived: 1, vip: 1, visitedThisMonth: 1 });
    expect(summary.topTags).toEqual([{ tag: '재방문', count: 3 }, { tag: 'VIP', count: 1 }, { tag: '신규', count: 1 }]);
  });
  it('is all zero for an empty list', () => {
    expect(summarizeCustomers([], TODAY)).toEqual({ total: 0, active: 0, vip: 0, archived: 0, visitedThisMonth: 0, topTags: [] });
  });
});

describe('upcomingVisits', () => {
  it('includes today through day 7 and excludes past, later and archived', () => {
    const rows = [
      make('a', { next_visit_date: '2026-10-20' }), make('b', { next_visit_date: '2026-10-13' }), make('c', { next_visit_date: '2026-10-21' }),
      make('d', { next_visit_date: '2026-10-12' }), make('e', { next_visit_date: '2026-10-15', status: 'archived' }), make('f'),
    ];
    expect(upcomingVisits(rows, TODAY).map((item) => [item.customer.id, item.days])).toEqual([['b', 0], ['a', 7]]);
  });
});

describe('lapsedCustomers', () => {
  it('lists 60+ days or never visited, oldest first, never-visited last', () => {
    const rows = [
      make('a', { last_visit_date: '2026-08-14' }),
      make('b', { last_visit_date: '2026-08-15' }),
      make('c', { last_visit_date: '2026-01-01' }),
      make('d'),
      make('e', { last_visit_date: '2026-01-01', next_visit_date: '2026-10-14' }),
      make('f', { last_visit_date: '2026-01-01', status: 'archived' }),
      make('g', { last_visit_date: '2026-01-01', next_visit_date: '2026-09-01' }),
    ];
    expect(lapsedCustomers(rows, TODAY).map((item) => [item.customer.id, item.days])).toEqual([['c', 285], ['g', 285], ['a', 60], ['d', null]]);
  });
});

describe('birthdayCustomers', () => {
  it('lists this month by day, marks today, ignores other months and malformed dates', () => {
    const rows = [
      make('a', { birth_date: '1990-10-30' }), make('b', { birth_date: '1985-10-13' }), make('c', { birth_date: '1985-11-01' }),
      make('d', { birth_date: 'oops' }), make('e', { birth_date: '1980-10-01', status: 'archived' }), make('f', { birth_date: '2000-10-02' }),
    ];
    const result = birthdayCustomers(rows, TODAY);
    expect(result.map((item) => item.customer.id)).toEqual(['f', 'b', 'a']);
    expect(result.map((item) => item.isToday)).toEqual([false, true, false]);
  });
});
