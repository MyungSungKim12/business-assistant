import type { ExportColumn } from '../../lib/io/exportTable';
import { cents, centsToText } from './format';
import type { Transaction } from './types';

/** FIN-11 분류별·월별 요약과 세무용 내보내기. 보관된 거래는 모두 제외한다. 금액은 "전" 단위 BigInt로만 더한다. */

/** 분류 입력 칸에 제안할 기본 분류. 이 매장에서 쓴 분류가 앞에 오고, 아직 안 쓴 기본 분류가 뒤따른다. */
export const DEFAULT_CATEGORIES = ['임대료', '인건비', '재료비', '광고비', '통신비', '공과금', '보험', '세금', '장비·수리', '소모품', '기타'] as const;

export function categorySuggestions(rows: Transaction[]): string[] {
  const used = new Map<string, number>();
  for (const row of rows) {
    const category = row.category.trim();
    if (category) used.set(category, (used.get(category) ?? 0) + 1);
  }
  const mine = [...used.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko')).map(([name]) => name);
  return [...mine, ...DEFAULT_CATEGORIES.filter((name) => !used.has(name))];
}

export interface CategoryRow { category: string; income: bigint; expense: bigint; net: bigint; count: number }
export interface MonthRow { month: string; income: bigint; expense: bigint; net: bigint; count: number }
export interface ReportTotals { income: bigint; expense: bigint; net: bigint; count: number }

const active = (rows: Transaction[], from: string | null, to: string | null) => rows.filter((row) => {
  if (row.is_archived) return false;
  const date = row.transaction_date.slice(0, 10);
  return (!from || date >= from) && (!to || date <= to) && cents(row.amount) !== null;
});

/** 분류별 합계. 지출이 큰 분류부터, 같으면 수입·이름 순이다. 분류가 비어 있으면 '(분류 없음)'으로 묶는다. */
export function byCategory(rows: Transaction[], from: string | null = null, to: string | null = null): CategoryRow[] {
  const map = new Map<string, CategoryRow>();
  for (const row of active(rows, from, to)) {
    const key = row.category.trim() || '(분류 없음)';
    const entry = map.get(key) ?? { category: key, income: 0n, expense: 0n, net: 0n, count: 0 };
    const amount = cents(row.amount)!;
    if (row.transaction_type === 'income') entry.income += amount; else entry.expense += amount;
    entry.net = entry.income - entry.expense;
    entry.count += 1;
    map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => (a.expense < b.expense ? 1 : a.expense > b.expense ? -1 : a.income < b.income ? 1 : a.income > b.income ? -1 : a.category.localeCompare(b.category, 'ko')));
}

/** 월별 합계(오래된 달부터). */
export function byMonth(rows: Transaction[], from: string | null = null, to: string | null = null): MonthRow[] {
  const map = new Map<string, MonthRow>();
  for (const row of active(rows, from, to)) {
    const key = row.transaction_date.slice(0, 7);
    const entry = map.get(key) ?? { month: key, income: 0n, expense: 0n, net: 0n, count: 0 };
    const amount = cents(row.amount)!;
    if (row.transaction_type === 'income') entry.income += amount; else entry.expense += amount;
    entry.net = entry.income - entry.expense;
    entry.count += 1;
    map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
}

export function totalsOf(rows: Transaction[], from: string | null = null, to: string | null = null): ReportTotals {
  let income = 0n; let expense = 0n; let count = 0;
  for (const row of active(rows, from, to)) {
    const amount = cents(row.amount)!;
    if (row.transaction_type === 'income') income += amount; else expense += amount;
    count += 1;
  }
  return { income, expense, net: income - expense, count };
}

const won = (value: bigint) => Number(centsToText(value));

export const categoryExportColumns: ExportColumn<CategoryRow>[] = [
  { header: '분류', width: 20, value: (row) => row.category },
  { header: '수입(원)', type: 'number', width: 16, value: (row) => won(row.income) },
  { header: '지출(원)', type: 'number', width: 16, value: (row) => won(row.expense) },
  { header: '순액(원)', type: 'number', width: 16, value: (row) => won(row.net) },
  { header: '건수', type: 'number', width: 8, value: (row) => row.count },
];
export const monthExportColumns: ExportColumn<MonthRow>[] = [
  { header: '월', width: 10, value: (row) => row.month },
  { header: '수입(원)', type: 'number', width: 16, value: (row) => won(row.income) },
  { header: '지출(원)', type: 'number', width: 16, value: (row) => won(row.expense) },
  { header: '순액(원)', type: 'number', width: 16, value: (row) => won(row.net) },
  { header: '건수', type: 'number', width: 8, value: (row) => row.count },
];

/** 세무 자료용 거래 상세: 거래일·분류·거래처·금액 순서이고 보관된 거래는 뺀다. */
export const taxDetailColumns: ExportColumn<Transaction>[] = [
  { header: '거래일', type: 'date', width: 12, value: (row) => row.transaction_date },
  { header: '유형', width: 8, value: (row) => (row.transaction_type === 'income' ? '수입' : '지출') },
  { header: '분류', width: 16, value: (row) => row.category },
  { header: '거래처', width: 20, value: (row) => row.counterparty },
  { header: '금액(원)', type: 'number', width: 16, value: (row) => row.amount },
  { header: '메모', width: 30, value: (row) => row.memo },
];

/** 세무 상세 내보내기에 쓸 거래(기간 안, 보관 제외, 날짜 오름차순). */
export function taxDetailRows(rows: Transaction[], from: string | null, to: string | null): Transaction[] {
  return active(rows, from, to).sort((a, b) => a.transaction_date.localeCompare(b.transaction_date) || a.category.localeCompare(b.category, 'ko') || a.id.localeCompare(b.id));
}
