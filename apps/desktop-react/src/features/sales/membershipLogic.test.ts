import { describe, expect, it } from 'vitest';
import type { OrganizationWallet, WalletHistoryEvent } from '../catalog/schemas';
import { daysUntil, filterWallets, historyDetail, isExpiringSoon, kstToday, signedCount, signedWon, walletKind, walletStatus } from './membershipLogic';

const TODAY = '2026-10-13';
const wallet = (over: Partial<OrganizationWallet> = {}): OrganizationWallet => ({
  id: 'w1', organization_id: 'o', customer_id: 'c1', customer_name: '김고객', product_id: 'p', name_snapshot: '10회 패키지', money_balance: '0', count_balance: 4,
  issued_money: '0', issued_count: 10, valid_from: '2026-01-01', expires_on: '2026-12-31', lifecycle_status: 'active', paused_on: null, lifecycle_version: 1, created_at: '2026-01-01T00:00:00Z', ...over,
});

describe('kstToday / daysUntil', () => {
  it('UTC 늦은 시각도 한국 날짜로 바꾼다', () => {
    expect(kstToday(new Date('2026-10-12T16:00:00Z'))).toBe('2026-10-13');
    expect(kstToday(new Date('2026-10-13T14:59:00Z'))).toBe('2026-10-13');
  });
  it('만료까지 남은 일수를 센다', () => {
    expect(daysUntil('2026-10-13', TODAY)).toBe(0);
    expect(daysUntil('2026-11-12', TODAY)).toBe(30);
    expect(daysUntil('2026-10-12', TODAY)).toBe(-1);
    expect(daysUntil(null, TODAY)).toBeNull();
  });
});

describe('walletStatus / isExpiringSoon', () => {
  it('정지 > 소진 > 만료 > 사용 가능 순으로 판정한다', () => {
    expect(walletStatus(wallet({ lifecycle_status: 'paused', count_balance: 0 }), TODAY)).toBe('paused');
    expect(walletStatus(wallet({ count_balance: 0, money_balance: '0' }), TODAY)).toBe('depleted');
    expect(walletStatus(wallet({ expires_on: '2026-10-12' }), TODAY)).toBe('expired');
    expect(walletStatus(wallet({ expires_on: null }), TODAY)).toBe('active');
    expect(walletStatus(wallet({ count_balance: 0, money_balance: '5000' }), TODAY)).toBe('active');
  });
  it('만료 임박은 사용 가능한 지갑의 오늘~30일 이내만 해당한다', () => {
    expect(isExpiringSoon(wallet({ expires_on: '2026-11-12' }), TODAY)).toBe(true);
    expect(isExpiringSoon(wallet({ expires_on: '2026-11-13' }), TODAY)).toBe(false);
    expect(isExpiringSoon(wallet({ expires_on: '2026-10-13' }), TODAY)).toBe(true);
    expect(isExpiringSoon(wallet({ expires_on: '2026-10-12' }), TODAY)).toBe(false);
    expect(isExpiringSoon(wallet({ expires_on: '2026-10-20', lifecycle_status: 'paused' }), TODAY)).toBe(false);
    expect(isExpiringSoon(wallet({ expires_on: null }), TODAY)).toBe(false);
  });
});

describe('walletKind / filterWallets', () => {
  it('발급 혜택으로 종류를 나눈다', () => {
    expect(walletKind(wallet({ issued_money: '50000', issued_count: 0 }))).toBe('금액권');
    expect(walletKind(wallet())).toBe('횟수권');
    expect(walletKind(wallet({ issued_money: '1000', issued_count: 3 }))).toBe('금액+횟수');
    expect(walletKind(wallet({ issued_count: 0 }))).toBe('-');
  });
  it('고객·회원권 검색과 상태 필터를 함께 적용한다', () => {
    const rows = [
      wallet(), wallet({ id: 'w2', customer_name: '이고객', name_snapshot: '금액권', expires_on: '2026-10-20' }),
      wallet({ id: 'w3', customer_name: '박고객', lifecycle_status: 'paused' }), wallet({ id: 'w4', customer_name: '최고객', expires_on: '2026-01-31' }),
    ];
    const ids = (query: string, status: Parameters<typeof filterWallets>[1]['status']) => filterWallets(rows, { query, status }, TODAY).map((row) => row.id);
    expect(ids('', 'all')).toEqual(['w1', 'w2', 'w3', 'w4']);
    expect(ids('이고객', 'all')).toEqual(['w2']);
    expect(ids('금액', 'all')).toEqual(['w2']);
    expect(ids('', 'expiring')).toEqual(['w2']);
    expect(ids('', 'paused')).toEqual(['w3']);
    expect(ids('', 'expired')).toEqual(['w4']);
    expect(ids('김', 'expired')).toEqual([]);
  });
});

describe('이력 표시', () => {
  const event = (over: Partial<WalletHistoryEvent>): WalletHistoryEvent => ({
    id: 'e', event_type: 'use', occurred_at: '2026-10-05T01:00:00Z', money_delta: '0', count_delta: 0, reason: null, visit_id: null, previous_expires_on: null, expires_on: null, ...over,
  });
  it('부호가 있는 금액·횟수를 만든다', () => {
    expect(signedWon('-5000')).toBe('-5,000원');
    expect(signedWon('100000')).toBe('+100,000원');
    expect(signedWon('0')).toBe('0원');
    expect(signedCount(-1)).toBe('-1회');
    expect(signedCount(10)).toBe('+10회');
  });
  it('연장·재개는 만료일 변화와 사유를 함께 보여 준다', () => {
    expect(historyDetail(event({ event_type: 'extend', reason: '고객 요청', previous_expires_on: '2026-12-31', expires_on: '2027-01-07' }))).toBe('만료일 2026-12-31 → 2027-01-07 · 고객 요청');
    expect(historyDetail(event({ event_type: 'pause', reason: '여행' }))).toBe('여행');
    expect(historyDetail(event({ event_type: 'resume', previous_expires_on: '2026-12-31', expires_on: '2026-12-31', reason: '복귀' }))).toBe('복귀');
    expect(historyDetail(event({}))).toBe('');
  });
});
