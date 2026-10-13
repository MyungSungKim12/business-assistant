import { cents } from './format';
import type { MonthClosing, Transaction } from './types';

/** 수입·지출 화면의 순수 로직(검색·정렬·합계, 월 마감 판단). 화면 상태와 분리해 단위 테스트한다. */

export type LedgerSortKey = 'transaction_date' | 'transaction_type' | 'amount' | 'category' | 'counterparty' | 'is_archived';
export type LedgerSort = { key: LedgerSortKey; direction: 'asc' | 'desc' };
export const defaultLedgerSort: LedgerSort = { key: 'transaction_date', direction: 'desc' };

export const typeLabel = { income: '수입', expense: '지출' } as const;

/** 분류·거래처·메모에 검색어(공백으로 나눈 모든 낱말)가 들어 있는 거래만 남긴다. 대소문자는 구분하지 않는다. */
export function searchTransactions(rows: Transaction[], text: string): Transaction[] {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return rows;
  return rows.filter((row) => {
    const haystack = `${row.category} ${row.counterparty} ${row.memo}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

function compareBy(key: LedgerSortKey, a: Transaction, b: Transaction): number {
  switch (key) {
    case 'amount': { const x = cents(a.amount) ?? 0n; const y = cents(b.amount) ?? 0n; return x < y ? -1 : x > y ? 1 : 0; }
    case 'transaction_date': return a.transaction_date.localeCompare(b.transaction_date);
    case 'transaction_type': return typeLabel[a.transaction_type].localeCompare(typeLabel[b.transaction_type], 'ko');
    case 'category': return a.category.localeCompare(b.category, 'ko');
    case 'counterparty': return a.counterparty.localeCompare(b.counterparty, 'ko');
    default: return Number(a.is_archived) - Number(b.is_archived);
  }
}

/** 같은 값이면 거래일 최신순, 그다음 id 순으로 항상 같은 순서가 되게 한다. 원본은 바꾸지 않는다. */
export function sortTransactions(rows: Transaction[], sort: LedgerSort): Transaction[] {
  const factor = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => factor * compareBy(sort.key, a, b) || b.transaction_date.localeCompare(a.transaction_date) || a.id.localeCompare(b.id));
}

export function nextLedgerSort(current: LedgerSort, key: LedgerSortKey): LedgerSort {
  if (current.key === key) return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  return { key, direction: key === 'transaction_date' || key === 'amount' ? 'desc' : 'asc' };
}

export interface CategoryTotal { category: string; income: bigint; expense: bigint; count: number }
export interface LedgerSummary {
  income: bigint; expense: bigint; net: bigint; count: number; incomeCount: number; expenseCount: number; archived: number; byCategory: CategoryTotal[];
}

/** 보관된 거래는 합계에서 뺀다(서버 요약과 같은 규칙). 분류별은 거래 규모(수입+지출)가 큰 순이다. */
export function summarizeLedger(rows: Transaction[]): LedgerSummary {
  let income = 0n;
  let expense = 0n;
  let incomeCount = 0;
  let expenseCount = 0;
  let archived = 0;
  const groups = new Map<string, CategoryTotal>();
  for (const row of rows) {
    if (row.is_archived) { archived += 1; continue; }
    const amount = cents(row.amount);
    if (amount === null) continue;
    const group = groups.get(row.category) ?? { category: row.category, income: 0n, expense: 0n, count: 0 };
    group.count += 1;
    if (row.transaction_type === 'income') { income += amount; incomeCount += 1; group.income += amount; } else { expense += amount; expenseCount += 1; group.expense += amount; }
    groups.set(row.category, group);
  }
  const byCategory = [...groups.values()].sort((a, b) => {
    const x = a.income + a.expense;
    const y = b.income + b.expense;
    return x < y ? 1 : x > y ? -1 : a.category.localeCompare(b.category, 'ko');
  });
  return { income, expense, net: income - expense, count: incomeCount + expenseCount, incomeCount, expenseCount, archived, byCategory };
}

/* ---------- 월 마감 ---------- */

const MONTH = /^(\d{4})-(\d{2})$/;
export function isMonthKey(value: string): boolean {
  const match = MONTH.exec(value);
  return match !== null && Number(match[2]) >= 1 && Number(match[2]) <= 12;
}
export const monthOfDate = (date: string): string => date.slice(0, 7);
export const monthFirstDay = (month: string): string => `${month}-01`;
export function monthLastDay(month: string): string {
  const [year, number] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(year, number, 0)).getUTCDate()).padStart(2, '0')}`;
}
export function previousMonth(todayKey: string): string {
  const year = Number(todayKey.slice(0, 4));
  const month = Number(todayKey.slice(5, 7));
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
}

/** 재오픈되지 않은(지금 유효한) 마감만 달(YYYY-MM)별로 모은다. */
export function activeClosings(closings: MonthClosing[]): Map<string, MonthClosing> {
  const result = new Map<string, MonthClosing>();
  for (const closing of closings) if (closing.reopened_at === null) result.set(closing.month.slice(0, 7), closing);
  return result;
}

/** 거래일이 마감된 달에 속하면 그 마감을, 아니면 null. */
export function closingForDate(closings: MonthClosing[], date: string): MonthClosing | null {
  return activeClosings(closings).get(monthOfDate(date)) ?? null;
}

export const closedMonthNotice = (date: string): string =>
  `${monthOfDate(date)}은(는) 월 마감된 달이라 이 날짜의 거래는 등록·수정(보관 포함)할 수 없습니다. 관리자가 월 마감을 재오픈해야 합니다.`;
