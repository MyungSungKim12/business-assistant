import { describe, expect, it } from 'vitest';
import { DEFAULT_CATEGORIES, byCategory, byMonth, categoryExportColumns, categorySuggestions, monthExportColumns, taxDetailColumns, taxDetailRows, totalsOf } from './taxReport';
import type { Transaction } from './types';

let n = 0;
const tx = (type: 'income' | 'expense', amount: string, date: string, category: string, over: Partial<Transaction> = {}): Transaction => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, organization_id: 'o', transaction_type: type, amount, transaction_date: date, category, counterparty: '', memo: '', is_archived: false, ...over,
});
const rows = [
  tx('income', '300000', '2026-09-05', '시술 매출'),
  tx('expense', '1200000', '2026-09-25', '임대료'),
  tx('expense', '55000', '2026-09-30', '통신비'),
  tx('expense', '1200000', '2026-10-25', '임대료'),
  tx('income', '500000', '2026-10-10', '시술 매출'),
  tx('expense', '10000', '2026-10-11', '  ', { memo: '분류 없음' }),
  tx('expense', '999999', '2026-10-12', '보관됨', { is_archived: true }),
];

describe('분류별·월별 합계', () => {
  it('보관된 거래를 빼고 분류별로 더하며 지출이 큰 분류부터 정렬한다', () => {
    const result = byCategory(rows);
    expect(result.map((row) => row.category)).toEqual(['임대료', '통신비', '(분류 없음)', '시술 매출']);
    expect(result[0]).toMatchObject({ expense: 240_000_000n, income: 0n, net: -240_000_000n, count: 2 });
    expect(result.find((row) => row.category === '시술 매출')).toMatchObject({ income: 80_000_000n, expense: 0n, net: 80_000_000n, count: 2 });
    expect(result.some((row) => row.category === '보관됨')).toBe(false);
  });

  it('기간을 주면 양 끝을 포함해 그 안만 더한다', () => {
    expect(byCategory(rows, '2026-10-01', '2026-10-31').map((row) => row.category)).toEqual(['임대료', '(분류 없음)', '시술 매출']);
    expect(byCategory(rows, '2026-10-25', '2026-10-25')).toHaveLength(1);
    expect(byCategory(rows, '2030-01-01', '2030-12-31')).toEqual([]);
  });

  it('월별은 오래된 달부터이고 수입·지출·순액·건수를 센다', () => {
    const result = byMonth(rows);
    expect(result.map((row) => row.month)).toEqual(['2026-09', '2026-10']);
    expect(result[0]).toMatchObject({ income: 30_000_000n, expense: 125_500_000n, net: -95_500_000n, count: 3 });
    expect(result[1]).toMatchObject({ income: 50_000_000n, expense: 121_000_000n, count: 3 });
  });

  it('전체 합계는 월별 합과 같다', () => {
    const totals = totalsOf(rows);
    expect(totals).toEqual({ income: 80_000_000n, expense: 246_500_000n, net: -166_500_000n, count: 6 });
    expect(byMonth(rows).reduce((sum, row) => sum + row.net, 0n)).toBe(totals.net);
    expect(byCategory(rows).reduce((sum, row) => sum + row.net, 0n)).toBe(totals.net);
  });

  it('금액을 해석할 수 없는 거래는 건너뛴다', () => {
    expect(totalsOf([...rows, tx('expense', 'abc', '2026-10-13', '이상')]).count).toBe(6);
  });
});

describe('분류 제안', () => {
  it('자주 쓴 분류가 앞에 오고 아직 안 쓴 기본 분류가 뒤따른다(중복 없음)', () => {
    const suggestions = categorySuggestions(rows);
    // 둘 다 2건이면 이름(가나다) 순이다.
    expect(suggestions.slice(0, 2)).toEqual(['시술 매출', '임대료']);
    expect(suggestions.indexOf('임대료')).toBeLessThan(suggestions.indexOf('인건비'));
    expect(new Set(suggestions).size).toBe(suggestions.length);
    expect(suggestions).toContain('통신비');
    for (const name of DEFAULT_CATEGORIES) expect(suggestions).toContain(name);
  });
  it('거래가 없으면 기본 분류만', () => {
    expect(categorySuggestions([])).toEqual([...DEFAULT_CATEGORIES]);
  });
});

describe('내보내기 열', () => {
  it('금액은 숫자 열(원)로 낸다', () => {
    const [row] = byCategory(rows);
    expect(categoryExportColumns.map((column) => column.value(row))).toEqual(['임대료', 0, 2400000, -2400000, 2]);
    const [month] = byMonth(rows);
    expect(monthExportColumns.map((column) => column.value(month))).toEqual(['2026-09', 300000, 1255000, -955000, 3]);
  });
  it('세무 상세는 보관 제외, 날짜 오름차순이고 분류·거래처·금액을 담는다', () => {
    const detail = taxDetailRows(rows, null, null);
    expect(detail).toHaveLength(6);
    expect(detail.map((row) => row.transaction_date)).toEqual([...detail.map((row) => row.transaction_date)].sort());
    expect(taxDetailColumns.map((column) => column.header)).toEqual(['거래일', '유형', '분류', '거래처', '금액(원)', '메모']);
    expect(taxDetailColumns.map((column) => column.value(detail[0]))).toEqual(['2026-09-05', '수입', '시술 매출', '', '300000', '']);
  });
});
