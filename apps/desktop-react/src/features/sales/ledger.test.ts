import { describe, expect, it } from 'vitest';
import {
  activeClosings, closedMonthNotice, closingForDate, defaultLedgerSort, isMonthKey, monthFirstDay, monthLastDay, nextLedgerSort, previousMonth,
  searchTransactions, sortTransactions, summarizeLedger,
} from './ledger';
import { ORG, USER, uid } from './testkit';
import type { MonthClosing, Transaction } from './types';

const tx = (n: number, over: Partial<Transaction> = {}): Transaction => ({
  id: uid(n), organization_id: ORG, transaction_type: 'income', amount: '1000', transaction_date: '2030-01-10', category: '시술 매출', counterparty: '', memo: '', is_archived: false, ...over,
});
const closing = (month: string, over: Partial<MonthClosing> = {}): MonthClosing => ({
  id: uid(90), organization_id: ORG, month: `${month}-01`, note: '결산', closed_by: USER, closed_at: '2030-02-01T00:00:00Z', reopened_by: null, reopened_at: null, reopen_reason: null, ...over,
});

describe('searchTransactions', () => {
  const rows = [tx(1, { category: '소모품', counterparty: 'Acme Corp', memo: '세럼 대량 구매' }), tx(2, { category: '임대료', counterparty: '건물주', memo: '10월분' }), tx(3, { category: '소모품', counterparty: '쿠팡', memo: '' })];

  it('검색어가 없으면 그대로 돌려준다', () => {
    expect(searchTransactions(rows, '   ')).toBe(rows);
  });

  it('분류·거래처·메모를 대소문자 구분 없이 찾는다', () => {
    expect(searchTransactions(rows, '소모품').map((row) => row.id)).toEqual([uid(1), uid(3)]);
    expect(searchTransactions(rows, 'acme').map((row) => row.id)).toEqual([uid(1)]);
    expect(searchTransactions(rows, '10월').map((row) => row.id)).toEqual([uid(2)]);
  });

  it('여러 낱말은 모두 들어 있어야 한다', () => {
    expect(searchTransactions(rows, '소모품 쿠팡').map((row) => row.id)).toEqual([uid(3)]);
    expect(searchTransactions(rows, '소모품 임대료')).toEqual([]);
  });
});

describe('sortTransactions', () => {
  const rows = [
    tx(1, { amount: '300', category: '나', transaction_date: '2030-01-02' }),
    tx(2, { amount: '100.50', category: '가', transaction_date: '2030-01-03', transaction_type: 'expense', is_archived: true }),
    tx(3, { amount: '200', category: '다', transaction_date: '2030-01-01', counterparty: '거래처' }),
  ];
  const ids = (sorted: Transaction[]) => sorted.map((row) => row.id);

  it('열별로 정렬하고 원본은 바꾸지 않는다', () => {
    expect(ids(sortTransactions(rows, defaultLedgerSort))).toEqual([uid(2), uid(1), uid(3)]);
    expect(ids(sortTransactions(rows, { key: 'transaction_date', direction: 'asc' }))).toEqual([uid(3), uid(1), uid(2)]);
    expect(ids(sortTransactions(rows, { key: 'amount', direction: 'desc' }))).toEqual([uid(1), uid(3), uid(2)]);
    expect(ids(sortTransactions(rows, { key: 'category', direction: 'asc' }))).toEqual([uid(2), uid(1), uid(3)]);
    expect(ids(sortTransactions(rows, { key: 'transaction_type', direction: 'desc' }))[0]).toBe(uid(2));
    expect(ids(sortTransactions(rows, { key: 'is_archived', direction: 'desc' }))[0]).toBe(uid(2));
    expect(ids(sortTransactions(rows, { key: 'counterparty', direction: 'desc' }))[0]).toBe(uid(3));
    expect(ids(rows)).toEqual([uid(1), uid(2), uid(3)]);
  });

  it('같은 값은 거래일 최신순으로 안정적으로 정렬한다', () => {
    const same = [tx(1, { category: 'A', transaction_date: '2030-01-01' }), tx(2, { category: 'A', transaction_date: '2030-01-05' })];
    expect(ids(sortTransactions(same, { key: 'category', direction: 'asc' }))).toEqual([uid(2), uid(1)]);
  });

  it('같은 열을 다시 누르면 방향이 바뀐다', () => {
    expect(nextLedgerSort(defaultLedgerSort, 'transaction_date')).toEqual({ key: 'transaction_date', direction: 'asc' });
    expect(nextLedgerSort(defaultLedgerSort, 'category')).toEqual({ key: 'category', direction: 'asc' });
    expect(nextLedgerSort(defaultLedgerSort, 'amount')).toEqual({ key: 'amount', direction: 'desc' });
  });
});

describe('summarizeLedger', () => {
  it('유형별·분류별 합계를 전 단위로 계산하고 보관된 거래는 뺀다', () => {
    const rows = [
      tx(1, { amount: '1234.50', category: '시술 매출' }),
      tx(2, { amount: '0.10', category: '시술 매출' }),
      tx(3, { amount: '0.20', category: '소모품', transaction_type: 'expense' }),
      tx(4, { amount: '5000', category: '소모품', transaction_type: 'expense' }),
      tx(5, { amount: '999999', category: '보관됨', is_archived: true }),
    ];
    const summary = summarizeLedger(rows);
    expect(summary).toMatchObject({ income: 123460n, expense: 500020n, net: -376560n, count: 4, incomeCount: 2, expenseCount: 2, archived: 1 });
    expect(summary.byCategory.map((group) => [group.category, group.income, group.expense, group.count])).toEqual([['소모품', 0n, 500020n, 2], ['시술 매출', 123460n, 0n, 2]]);
  });

  it('분류별은 규모가 큰 순이고 같으면 이름순이다', () => {
    const rows = [tx(1, { category: '나', amount: '100' }), tx(2, { category: '가', amount: '100' }), tx(3, { category: '다', amount: '900', transaction_type: 'expense' })];
    expect(summarizeLedger(rows).byCategory.map((group) => group.category)).toEqual(['다', '가', '나']);
  });

  it('거래가 없으면 모두 0이다', () => {
    expect(summarizeLedger([])).toEqual({ income: 0n, expense: 0n, net: 0n, count: 0, incomeCount: 0, expenseCount: 0, archived: 0, byCategory: [] });
  });
});

describe('월 마감 계산', () => {
  it('달 키를 검증하고 첫날·마지막 날을 구한다', () => {
    expect(isMonthKey('2030-01')).toBe(true);
    expect(['2030-13', '2030-00', '2030-1', '2030-01-01', ''].some(isMonthKey)).toBe(false);
    expect(monthFirstDay('2030-02')).toBe('2030-02-01');
    expect(monthLastDay('2030-01')).toBe('2030-01-31');
    expect(monthLastDay('2030-02')).toBe('2030-02-28');
    expect(monthLastDay('2032-02')).toBe('2032-02-29');
    expect(monthLastDay('2030-12')).toBe('2030-12-31');
  });

  it('지난달을 구한다', () => {
    expect(previousMonth('2030-03-15')).toBe('2030-02');
    expect(previousMonth('2030-01-02')).toBe('2029-12');
  });

  it('재오픈된 마감은 유효하지 않다', () => {
    const closings = [closing('2030-01'), closing('2029-12', { reopened_at: '2030-01-05T00:00:00Z', reopened_by: USER, reopen_reason: '정정' }), closing('2029-11')];
    expect([...activeClosings(closings).keys()].sort()).toEqual(['2029-11', '2030-01']);
    expect(closingForDate(closings, '2030-01-31')?.month).toBe('2030-01-01');
    expect(closingForDate(closings, '2029-12-15')).toBeNull();
    expect(closingForDate(closings, '2030-02-01')).toBeNull();
    expect(closingForDate([], '2030-01-01')).toBeNull();
  });

  it('안내 문구에 달이 들어간다', () => {
    expect(closedMonthNotice('2030-01-12')).toContain('2030-01');
    expect(closedMonthNotice('2030-01-12')).toContain('월 마감');
  });
});
