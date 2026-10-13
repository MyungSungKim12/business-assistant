import { describe, expect, it, vi } from 'vitest';
import { buildExport } from '../../lib/io/exportTable';
import {
  blankHistoryForm, collectAllRows, defaultSort, nextSort, referenceText, salePaymentExportColumns, serverSortOf, signedAmount, sortHistoryRows, toSearchFilter,
} from './paymentHistory';
import { CART, CUSTOMER, VISIT, uid } from './testkit';
import type { SalePayment, SalePaymentsPage } from './types';

const row = (n: number, over: Partial<SalePayment> = {}): SalePayment => ({
  id: uid(n), kind: 'payment', method: 'card', amount: '60000', occurred_at: `2030-01-${String(10 + n).padStart(2, '0')}T02:00:00Z`, reference: 'A-1', reason: '',
  cart_id: CART, visit_id: VISIT, customer_id: CUSTOMER, customer_name: '김고객', ...over,
});
const totals = (rowCount: number) => ({ payment_total: '0', refund_total: '0', net_total: '0', payment_count: 0, refund_count: 0, row_count: rowCount });

describe('toSearchFilter', () => {
  it('빈 폼은 조건 없는 검색이 된다', () => {
    expect(toSearchFilter(blankHistoryForm())).toEqual({ ok: true, filter: {} });
  });

  it('입력값을 서버 조건으로 바꾸고 금액의 쉼표·공백을 지운다', () => {
    const result = toSearchFilter({ ...blankHistoryForm(), from: '2030-01-01', to: '2030-01-31', customerId: CUSTOMER, method: 'cash', kind: 'refund', minAmount: ' 1,000 ', maxAmount: '50000' });
    expect(result).toEqual({ ok: true, filter: { from: '2030-01-01', to: '2030-01-31', customerId: CUSTOMER, method: 'cash', kind: 'refund', minAmount: '1000', maxAmount: '50000' } });
  });

  it.each([
    ['시작일이 종료일보다 늦으면', { from: '2030-02-01', to: '2030-01-01' }, '시작일은 종료일보다 늦을 수 없습니다.'],
    ['금액이 숫자가 아니면', { minAmount: 'abc' }, '금액은 0 이상의 원 단위 정수로 입력하세요.'],
    ['금액에 소수가 있으면', { maxAmount: '10.5' }, '금액은 0 이상의 원 단위 정수로 입력하세요.'],
    ['금액이 음수이면', { minAmount: '-1' }, '금액은 0 이상의 원 단위 정수로 입력하세요.'],
    ['최소가 최대보다 크면', { minAmount: '500', maxAmount: '100' }, '최소 금액은 최대 금액보다 클 수 없습니다.'],
  ])('%s 거절한다', (_name, patch, message) => {
    expect(toSearchFilter({ ...blankHistoryForm(), ...patch })).toEqual({ ok: false, message });
  });

  it('최소와 최대가 같거나 0원도 허용한다', () => {
    expect(toSearchFilter({ ...blankHistoryForm(), minAmount: '0', maxAmount: '0' }).ok).toBe(true);
    expect(toSearchFilter({ ...blankHistoryForm(), minAmount: '700', maxAmount: '700' }).ok).toBe(true);
  });
});

describe('정렬', () => {
  const rows = [row(1, { customer_name: '다', amount: '300' }), row(2, { customer_name: '가', amount: '100', kind: 'refund', method: 'cash' }), row(3, { customer_name: '나', amount: '200', kind: 'return', method: 'transfer' })];

  it('시각 정렬은 서버 순서를 그대로 둔다', () => {
    expect(sortHistoryRows(rows, defaultSort)).toBe(rows);
  });

  it('금액·고객·유형·수단 열은 불러온 행 안에서 정렬하며 원본을 바꾸지 않는다', () => {
    expect(sortHistoryRows(rows, { key: 'amount', direction: 'asc' }).map((item) => item.amount)).toEqual(['100', '200', '300']);
    expect(sortHistoryRows(rows, { key: 'amount', direction: 'desc' }).map((item) => item.amount)).toEqual(['300', '200', '100']);
    expect(sortHistoryRows(rows, { key: 'customer_name', direction: 'asc' }).map((item) => item.customer_name)).toEqual(['가', '나', '다']);
    // 한글 가나다순: 반품 < 수납 < 환불, 이체 < 카드 < 현금
    expect(sortHistoryRows(rows, { key: 'kind', direction: 'asc' }).map((item) => item.kind)).toEqual(['return', 'payment', 'refund']);
    expect(sortHistoryRows(rows, { key: 'method', direction: 'asc' }).map((item) => item.method)).toEqual(['transfer', 'card', 'cash']);
    expect(rows.map((item) => item.amount)).toEqual(['300', '100', '200']);
  });

  it('같은 열을 다시 누르면 방향이 바뀌고 서버 정렬은 시각 열만 따른다', () => {
    expect(nextSort(defaultSort, 'occurred_at')).toEqual({ key: 'occurred_at', direction: 'asc' });
    expect(nextSort(defaultSort, 'customer_name')).toEqual({ key: 'customer_name', direction: 'asc' });
    expect(nextSort({ key: 'customer_name', direction: 'asc' }, 'amount')).toEqual({ key: 'amount', direction: 'desc' });
    expect(serverSortOf({ key: 'occurred_at', direction: 'asc' })).toBe('oldest');
    expect(serverSortOf(defaultSort)).toBe('newest');
    expect(serverSortOf({ key: 'amount', direction: 'asc' })).toBe('newest');
  });
});

describe('금액·표시', () => {
  it('환불·반품은 음수로 계산한다', () => {
    expect(signedAmount(row(1))).toBe(6_000_000n);
    expect(signedAmount(row(1, { kind: 'refund', amount: '2500' }))).toBe(-250_000n);
    expect(signedAmount(row(1, { kind: 'return', amount: '1' }))).toBe(-100n);
  });

  it('참조는 번호와 사유를 이어 보여 준다', () => {
    expect(referenceText(row(1))).toBe('A-1');
    expect(referenceText(row(1, { reference: '', reason: '단순 변심' }))).toBe('단순 변심');
    expect(referenceText(row(1, { reference: '', reason: '' }))).toBe('');
  });
});

describe('내보내기', () => {
  it('열 정의는 금액을 숫자 열로, 환불·반품은 음수 순매출 열로 내보낸다', async () => {
    const rows = [row(1), row(2, { kind: 'refund', method: 'cash', amount: '10000', reference: '', reason: '단순 변심' })];
    const { bytes, fileName } = await buildExport({ title: '매출 내역', columns: salePaymentExportColumns, rows, format: 'csv', now: new Date('2030-02-01T00:00:00') });
    expect(fileName).toBe('매출_내역_20300201.csv');
    const text = new TextDecoder().decode(bytes).replace(/^﻿/, '');
    const lines = text.trim().split(/\r?\n/);
    expect(lines[0]).toBe('일시,일자,고객,유형,수단,금액,순매출 반영(환불·반품은 음수),승인·식별번호/회원권,사유');
    expect(lines[1]).toBe('2030-01-11 11:00,2030-01-11,김고객,수납,카드,60000,60000,A-1,');
    expect(lines[2]).toBe('2030-01-12 11:00,2030-01-12,김고객,환불,현금,10000,-10000,,단순 변심');
  });
});

describe('collectAllRows', () => {
  const page = (rows: SalePayment[], next: string | null, count: number): SalePaymentsPage => ({ rows, next_cursor: next, totals: totals(count) });

  it('커서를 따라 모든 페이지를 모으고 중복 행은 한 번만 담는다', async () => {
    const load = vi.fn(async (cursor: string | undefined) => (cursor === undefined ? page([row(1), row(2)], 'c1', 3) : page([row(2), row(3)], null, 3)));
    const result = await collectAllRows(load, 100, 2);
    expect(result.tooMany).toBe(false);
    expect(result.rows.map((item) => item.id)).toEqual([uid(1), uid(2), uid(3)]);
    expect(load.mock.calls.map((call) => call[0])).toEqual([undefined, 'c1']);
  });

  it('합계 건수가 한도를 넘으면 더 요청하지 않고 tooMany를 돌려준다', async () => {
    const load = vi.fn(async () => page([row(1)], 'c1', 101));
    expect(await collectAllRows(load, 100, 50)).toEqual({ rows: [], tooMany: true });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('같은 커서가 반복되거나 끝나지 않으면 멈춘다', async () => {
    const same = vi.fn(async () => page([row(1)], 'c1', 2));
    expect((await collectAllRows(same, 100, 50)).rows).toHaveLength(1);
    expect(same).toHaveBeenCalledTimes(2);
    let n = 0;
    const endless = vi.fn(async () => page([row(++n)], `c${n}`, 3));
    expect((await collectAllRows(endless, 4, 2)).tooMany).toBe(true);
    expect(endless.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('요청 오류는 그대로 던진다', async () => {
    await expect(collectAllRows(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });
});
