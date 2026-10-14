import { describe, expect, it } from 'vitest';
import { buildComparison, comparisonExportColumns, periodChangeLabel, previousPeriod, staffBars } from './managementCompare';

const summary = (income: string, expense: string, net: string, receipts = '0', refunds = '0') => ({ income, expense, net, receipts, refunds });

describe('previousPeriod', () => {
  it('같은 길이의 바로 앞 기간을 구한다', () => {
    expect(previousPeriod('2026-10-01', '2026-10-13')).toEqual({ from: '2026-09-18', to: '2026-09-30' });
    expect(previousPeriod('2026-10-05', '2026-10-05')).toEqual({ from: '2026-10-04', to: '2026-10-04' });
    expect(previousPeriod('2026-03-01', '2026-03-31')).toEqual({ from: '2026-01-29', to: '2026-02-28' });
  });
  it('연 경계와 잘못된 입력', () => {
    expect(previousPeriod('2026-01-01', '2026-01-10')).toEqual({ from: '2025-12-22', to: '2025-12-31' });
    expect(previousPeriod('2026-10-13', '2026-10-01')).toBeNull();
    expect(previousPeriod('abc', '2026-10-01')).toBeNull();
  });
});

describe('periodChangeLabel', () => {
  it('증감 비율과 기준 0, 비교 불가를 구분한다', () => {
    expect(periodChangeLabel(15_000n, 10_000n)).toBe('▲ 50%');
    expect(periodChangeLabel(5_000n, 10_000n)).toBe('▼ 50%');
    expect(periodChangeLabel(10_000n, 10_000n)).toBe('변화 없음');
    expect(periodChangeLabel(0n, 0n)).toBe('변화 없음');
    expect(periodChangeLabel(5_000n, 0n)).toBe('이전 기간 기록 없음');
    expect(periodChangeLabel(5_000n, null)).toBe('비교 불가');
    expect(periodChangeLabel(-5_000n, -10_000n)).toBe('▲ 50%');
  });
});

describe('buildComparison', () => {
  it('금액 문자열을 "전" 단위로 바꿔 항목별 행을 만든다', () => {
    const rows = buildComparison(summary('100000', '20000', '80000', '100000', '0'), summary('50000', '20000', '30000', '40000', '10000'));
    expect(rows.map((row) => row.label)).toEqual(['기록된 수입', '기록된 지출', '순액', '방문 수납', '방문 환불']);
    expect(rows[0]).toMatchObject({ current: 10_000_000n, previous: 5_000_000n, change: '▲ 100%' });
    expect(rows[1].change).toBe('변화 없음');
    expect(rows[2].change).toBe('▲ 167%');
    expect(rows[4]).toMatchObject({ current: 0n, previous: 1_000_000n, change: '▼ 100%' });
  });
  it('이전 기간이 없으면 이전 값은 null이고 비교 불가로 표시한다', () => {
    const rows = buildComparison(summary('100', '0', '100'), null);
    expect(rows.every((row) => row.previous === null && row.change === '비교 불가')).toBe(true);
  });
  it('내보내기 열은 숫자(원)와 비운 칸을 낸다', () => {
    const [row] = buildComparison(summary('100000', '0', '100000'), null);
    expect(comparisonExportColumns.map((column) => column.value(row))).toEqual(['기록된 수입', 100000, null, '비교 불가']);
  });
});

describe('staffBars', () => {
  it('총액 큰 순으로 정렬하고 최댓값 대비 비율을 구한다', () => {
    const bars = staffBars([
      { staff_id: 'a', staff_name_snapshot: '김담당', gross_line_total: '30000' },
      { staff_id: null, staff_name_snapshot: '', gross_line_total: '90000' },
      { staff_id: 'c', staff_name_snapshot: '이담당', gross_line_total: '0' },
    ]);
    expect(bars.map((bar) => bar.name)).toEqual(['담당 미지정', '김담당', '이담당']);
    expect(bars.map((bar) => Math.round(bar.share))).toEqual([100, 33, 0]);
  });
  it('총액이 모두 0이거나 숫자가 아니면 막대는 0이다', () => {
    expect(staffBars([{ staff_id: 'a', staff_name_snapshot: 'x', gross_line_total: 'bad' }])[0].share).toBe(0);
  });
});
