import { describe, expect, it } from 'vitest';
import type { Appointment, Customer, Task } from '../../api/schemas';
import type { Transaction } from '../sales/types';
import { buildChartModel } from './components/FinanceChart';
import {
  addDaysKey, appointmentsOnDay, bucketTasks, changeLabel, compareWithPreviousMonth, compactWon, prevMonthStartKey, previousMonthPeriod, dailySeries, expiringWallets, formatKstHeading, kstDateKey, kstTime, lowStock,
  monthTotals, niceMax, receivableSummary, receivableTotal, recentVisitors, stockThreshold, summarizeAppointments, upcomingVisits, wonOf,
} from './dashboardMetrics';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function appointment(n: number, start_at: string, status = 'reserved'): Appointment {
  return { id: id(n), organization_id: id(900), customer_id: id(n), staff_id: id(800), service_id: id(700), service_name_snapshot: '관리', duration_minutes: 30, buffer_minutes: 0, start_at, end_at: start_at, status, source: 'manual', cancellation_reason: null, version: 1, resource_ids: [] };
}

function task(n: number, due_at: string | null, status = 'open', priority = 'normal'): Task {
  return { id: id(n), organization_id: id(900), created_by: id(1), title: `할 일 ${n}`, description: '', due_at, status, priority };
}

function customer(n: number, patch: Partial<Customer> = {}): Customer {
  return { id: id(n), organization_id: id(900), name: `고객${n}`, email: null, phone: null, notes: '', birth_date: null, skin_type: null, concerns: [], allergies: '', last_visit_date: null, next_visit_date: null, tags: [], status: 'active', ...patch };
}

function tx(n: number, type: 'income' | 'expense', amount: string, date: string, archived = false): Transaction {
  return { id: id(n), organization_id: id(900), transaction_type: type, amount, transaction_date: date, category: '', counterparty: '', memo: '', is_archived: archived };
}

describe('KST 날짜 계산', () => {
  it('UTC 15:00은 KST 다음 날 00:00이다', () => {
    expect(kstDateKey('2026-10-13T14:59:59Z')).toBe('2026-10-13');
    expect(kstDateKey('2026-10-13T15:00:00Z')).toBe('2026-10-14');
    expect(kstTime('2026-10-13T15:00:00Z')).toBe('00:00');
    expect(kstDateKey('not-a-date')).toBeNull();
  });

  it('날짜 이동은 월·연 경계를 넘는다', () => {
    expect(addDaysKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysKey('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('제목 날짜는 KST 요일을 쓴다', () => {
    expect(formatKstHeading(new Date('2026-10-13T01:00:00Z'))).toBe('2026년 10월 13일 (화)');
    expect(formatKstHeading(new Date('2026-10-13T15:30:00Z'))).toBe('2026년 10월 14일 (수)');
  });
});

describe('예약', () => {
  const items = [
    appointment(1, '2026-10-13T14:59:59Z'),
    appointment(2, '2026-10-13T15:00:00Z'),
    appointment(3, '2026-10-13T01:00:00Z', 'completed'),
    appointment(4, '2026-10-13T00:00:00Z', 'canceled'),
    appointment(5, '2026-10-13T02:00:00Z', 'checked_in'),
  ];

  it('KST 날짜 경계로 오늘 예약만 시간순으로 고른다', () => {
    expect(appointmentsOnDay(items, '2026-10-13').map((item) => item.id)).toEqual([id(4), id(3), id(5), id(1)]);
    expect(appointmentsOnDay(items, '2026-10-14').map((item) => item.id)).toEqual([id(2)]);
  });

  it('취소·노쇼는 합계에서 빼고 완료/미완료를 나눈다', () => {
    expect(summarizeAppointments(appointmentsOnDay(items, '2026-10-13'))).toEqual({ total: 3, open: 2, done: 1, canceled: 1 });
  });
});

describe('할 일', () => {
  it('기한 지남·오늘·이번 주·이후를 KST 날짜로 나누고 완료는 제외한다', () => {
    const buckets = bucketTasks([
      task(1, '2026-10-12T14:59:00Z'), // KST 10/12 23:59 -> 기한 지남
      task(2, '2026-10-12T15:00:00Z'), // KST 10/13 00:00 -> 오늘
      task(3, '2026-10-20T14:59:00Z'), // KST 10/20 -> 이번 주(7일 이내)
      task(4, '2026-10-20T15:00:00Z'), // KST 10/21 -> 이후
      task(5, null),
      task(6, '2026-10-13T00:00:00Z', 'done'),
      task(7, '2026-10-13T00:00:00Z', 'canceled'),
      task(8, '2026-10-13T00:00:00Z', 'in_progress', 'high'),
    ], '2026-10-13');
    expect(buckets.overdue.map((item) => item.id)).toEqual([id(1)]);
    expect(buckets.today.map((item) => item.id)).toEqual([id(2), id(8)]);
    expect(buckets.week.map((item) => item.id)).toEqual([id(3)]);
    expect(buckets.later).toBe(2);
    expect(buckets.active).toBe(6);
  });
});

describe('고객', () => {
  const list = [
    customer(1, { next_visit_date: '2026-10-13' }),
    customer(2, { next_visit_date: '2026-10-20' }),
    customer(3, { next_visit_date: '2026-10-21' }),
    customer(4, { next_visit_date: '2026-10-12' }),
    customer(5, { next_visit_date: '2026-10-15', status: 'archived' }),
    customer(6, { last_visit_date: '2026-10-10' }),
    customer(7, { last_visit_date: '2026-10-12' }),
  ];

  it('오늘부터 7일 이내(양끝 포함)의 방문 예정만 날짜순으로 고른다', () => {
    expect(upcomingVisits(list, '2026-10-13').map((item) => item.id)).toEqual([id(1), id(2)]);
  });

  it('최근 방문 고객은 마지막 방문일 내림차순 최대 5명이다', () => {
    expect(recentVisitors(list).map((item) => item.id)).toEqual([id(7), id(6)]);
    const many = Array.from({ length: 8 }, (_, index) => customer(index + 1, { last_visit_date: `2026-10-0${index + 1}` }));
    expect(recentVisitors(many)).toHaveLength(5);
  });
});

describe('수입·지출', () => {
  const rows = [
    tx(1, 'income', '100000', '2026-10-01'),
    tx(2, 'income', '50000.50', '2026-10-13'),
    tx(3, 'expense', '30000', '2026-10-13'),
    tx(4, 'income', '999', '2026-09-30'),
    tx(5, 'expense', '5000', '2026-10-13', true),
    tx(6, 'income', '7000', '2026-10-14'),
  ];

  it('이번 달 합계는 월 초~오늘만, 보관된 거래는 제외한다', () => {
    const totals = monthTotals(rows, '2026-10-13');
    expect(wonOf(totals.income)).toBe('150,000.50원');
    expect(wonOf(totals.expense)).toBe('30,000원');
    expect(wonOf(totals.net)).toBe('120,000.50원');
  });

  it('순수입이 음수이면 음수로 표시한다', () => {
    expect(wonOf(monthTotals([tx(1, 'expense', '1234567', '2026-10-02')], '2026-10-13').net)).toBe('-1,234,567원');
  });

  it('일별 시계열은 오늘로 끝나는 14일을 0으로 채워 만든다', () => {
    const series = dailySeries(rows, '2026-10-13');
    expect(series).toHaveLength(14);
    expect(series[0].date).toBe('2026-09-30');
    expect(series[13]).toEqual({ date: '2026-10-13', income: 50000, expense: 30000 });
    expect(series[1].date).toBe('2026-10-01');
    expect(series[1].income).toBe(100000);
    expect(series[4]).toEqual({ date: '2026-10-04', income: 0, expense: 0 });
  });

  it('차트 모델: 축 최댓값과 막대 높이, 빈 데이터에서도 틀 유지', () => {
    const model = buildChartModel(dailySeries(rows, '2026-10-13'));
    expect(model.max).toBe(100_000);
    expect(model.hasData).toBe(true);
    expect(model.bars).toHaveLength(14);
    expect(model.bars[1].incomeHeight).toBeCloseTo(100);
    expect(model.bars[13].incomeHeight).toBeCloseTo(50);
    const empty = buildChartModel(dailySeries([], '2026-10-13'));
    expect(empty.hasData).toBe(false);
    expect(empty.max).toBe(100_000);
    expect(empty.bars).toHaveLength(14);
    expect(empty.bars.every((bar) => bar.incomeHeight === 0 && bar.expenseHeight === 0)).toBe(true);
  });

  it('축 도우미', () => {
    expect(niceMax(0)).toBe(100_000);
    expect(niceMax(130_000)).toBe(200_000);
    expect(niceMax(200_000)).toBe(200_000);
    expect(niceMax(450_000)).toBe(500_000);
    expect(compactWon(0)).toBe('0');
    expect(compactWon(250_000)).toBe('25만');
    expect(compactWon(5_000)).toBe('5,000');
  });
});

describe('미수금·재고·회원권', () => {
  it('미수금은 0보다 큰 금액만 합산한다', () => {
    expect(receivableTotal([{ due_amount: '10000' }, { due_amount: '0' }, { due_amount: '2500' }])).toEqual({ total: 1_250_000n, count: 2 });
  });

  it('재고 부족은 활성 상품 중 기준 이하만 적은 순으로 고른다', () => {
    const low = lowStock([
      { id: 'a', name: 'A', kind: 'product', is_active: true, stock_quantity: 5 },
      { id: 'b', name: 'B', kind: 'product', is_active: true, stock_quantity: 6 },
      { id: 'c', name: 'C', kind: 'membership', is_active: true, stock_quantity: 0 },
      { id: 'd', name: 'D', kind: 'product', is_active: false, stock_quantity: 0 },
      { id: 'e', name: 'E', kind: 'product', is_active: true, stock_quantity: 1 },
    ]);
    expect(low.map((item) => item.id)).toEqual(['e', 'a']);
  });

  it('전체 미수 요약은 서버 합계를 전 단위로 바꾸고 해석할 수 없으면 0으로 본다', () => {
    expect(receivableSummary({ total_due: '1250000', receivable_count: 3 })).toEqual({ total: 125_000_000n, count: 3 });
    expect(receivableSummary({ total_due: '0', receivable_count: 0 })).toEqual({ total: 0n, count: 0 });
    expect(receivableSummary({ total_due: 'x', receivable_count: 2 })).toEqual({ total: 0n, count: 2 });
  });

  it('안전재고는 상품별 값을 쓰고 null·미지정이면 기본 5를 쓴다', () => {
    expect(stockThreshold({})).toBe(5);
    expect(stockThreshold({ low_stock_threshold: null })).toBe(5);
    expect(stockThreshold({ low_stock_threshold: 0 })).toBe(0);
    expect(stockThreshold({ low_stock_threshold: 12 })).toBe(12);
    expect(stockThreshold({ low_stock_threshold: null }, 8)).toBe(8);
  });

  it('재고 부족은 상품별 안전재고 이하를 고르고 0 기준은 품절일 때만 포함한다', () => {
    const low = lowStock([
      { id: 'a', name: 'A', kind: 'product', is_active: true, stock_quantity: 5 },
      { id: 'b', name: 'B', kind: 'product', is_active: true, stock_quantity: 9, low_stock_threshold: 10 },
      { id: 'c', name: 'C', kind: 'product', is_active: true, stock_quantity: 3, low_stock_threshold: 2 },
      { id: 'd', name: 'D', kind: 'product', is_active: true, stock_quantity: 1, low_stock_threshold: 0 },
      { id: 'e', name: 'E', kind: 'product', is_active: true, stock_quantity: 0, low_stock_threshold: 0 },
      { id: 'f', name: 'F', kind: 'product', is_active: true, stock_quantity: 7, low_stock_threshold: null },
      { id: 'g', name: 'G', kind: 'product', is_active: false, stock_quantity: 0, low_stock_threshold: 10 },
    ]);
    expect(low.map((item) => item.id)).toEqual(['e', 'a', 'b']);
    expect(lowStock([{ id: 'x', name: 'X', kind: 'product', is_active: true, stock_quantity: 7 }], 8)).toHaveLength(1);
  });

  it('회원권 만료 임박은 30일 이내·잔액 있는 것만 임박 순으로 고른다', () => {
    const rows = expiringWallets([
      { id: 'w1', expires_on: '2026-11-12', money_balance: '1000' },
      { id: 'w2', expires_on: '2026-11-13', money_balance: '1000' },
      { id: 'w3', expires_on: '2026-10-14', count_balance: 3 },
      { id: 'w4', expires_on: '2026-10-12', money_balance: '1000' },
      { id: 'w5', expires_on: '2026-10-20', money_balance: '0', count_balance: 0 },
      { id: 'w6', expires_on: null, money_balance: '1000' },
    ], '2026-10-13');
    expect(rows.map((row) => [row.id, row.daysLeft])).toEqual([['w3', 1], ['w1', 30]]);
  });
});

describe('전월 동기 비교(HOME-03)', () => {
  it('전월 1일과 같은 기간을 구하고, 전월에 없는 일자는 말일로 맞춘다', () => {
    expect(prevMonthStartKey('2026-10-13')).toBe('2026-09-01');
    expect(prevMonthStartKey('2026-01-15')).toBe('2025-12-01');
    expect(previousMonthPeriod('2026-10-13')).toEqual({ from: '2026-09-01', to: '2026-09-13' });
    expect(previousMonthPeriod('2026-03-31')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(previousMonthPeriod('2024-03-31')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(previousMonthPeriod('2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-15' });
  });

  it('이번 달 오늘까지와 전월 같은 기간만 합산한다(보관·범위 밖 거래 제외)', () => {
    const rows = [
      tx(1, 'income', '300000', '2026-10-12'), tx(2, 'expense', '100000', '2026-10-13'), tx(3, 'income', '999', '2026-10-14'),
      tx(4, 'income', '200000', '2026-09-05'), tx(5, 'expense', '50000', '2026-09-13'), tx(6, 'income', '777000', '2026-09-14'), tx(7, 'income', '123000', '2026-09-02', true),
    ];
    const { current, previous } = compareWithPreviousMonth(rows, '2026-10-13');
    expect(current.net).toBe(20_000_000n);
    expect(previous.net).toBe(15_000_000n);
    expect(previous.income).toBe(20_000_000n);
  });

  it('변화 문구: 증감 비율, 기준 0, 변화 없음, 음수 기준', () => {
    expect(changeLabel(15_000_000n, 10_000_000n)).toBe('전월 동기 대비 ▲ 50%');
    expect(changeLabel(5_000_000n, 10_000_000n)).toBe('전월 동기 대비 ▼ 50%');
    expect(changeLabel(10_000_000n, 10_000_000n)).toBe('전월 동기와 같음');
    expect(changeLabel(0n, 0n)).toBe('전월 동기와 같음');
    expect(changeLabel(5_000_000n, 0n)).toBe('전월 동기 기록 없음');
    expect(changeLabel(-5_000_000n, -10_000_000n)).toBe('전월 동기 대비 ▲ 50%');
    expect(changeLabel(-15_000_000n, -10_000_000n)).toBe('전월 동기 대비 ▼ 50%');
    expect(changeLabel(10_001_000n, 10_000_000n)).toBe('전월 동기 대비 ▲ 0%');
  });

  it('차트 기간을 30일까지 늘려 시계열을 만든다', () => {
    const series = dailySeries([tx(1, 'income', '1000', '2026-09-15')], '2026-10-13', 30);
    expect(series).toHaveLength(30);
    expect(series[0].date).toBe('2026-09-14');
    expect(series[1].income).toBe(1000);
  });
});
