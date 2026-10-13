import { describe, expect, it } from 'vitest';
import type { Appointment, Customer, Task } from '../../api/schemas';
import { addDays, daysBetween, kstDateKey, kstTimeLabel } from './kstTime';
import { buildNotifications, walletRowsFrom, type WalletRow } from './notificationModel';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** 2026-10-13 14:00 KST (= 05:00Z) */
const NOW = new Date('2026-10-13T05:00:00Z');

const customer = (n: number, patch: Partial<Customer> = {}): Customer => ({
  id: ID(n), organization_id: ID(900), name: `고객${n}`, email: null, phone: null, notes: '', birth_date: null, skin_type: null, concerns: [], allergies: '',
  last_visit_date: null, next_visit_date: null, tags: [], status: 'active', ...patch,
});
const appointment = (n: number, startKst: string, patch: Partial<Appointment> = {}): Appointment => ({
  id: ID(100 + n), organization_id: ID(900), customer_id: ID(1), staff_id: ID(500), service_id: ID(600), service_name_snapshot: '관리 60분', duration_minutes: 60, buffer_minutes: 0,
  start_at: new Date(`${startKst}+09:00`).toISOString(), end_at: new Date(`${startKst}+09:00`).toISOString(), status: 'reserved', source: 'phone', cancellation_reason: null, version: 1, resource_ids: [], ...patch,
});
const task = (n: number, dueKst: string | null, patch: Partial<Task> = {}): Task => ({
  id: ID(200 + n), organization_id: ID(900), created_by: ID(700), title: `할 일${n}`, description: '', due_at: dueKst ? new Date(`${dueKst}+09:00`).toISOString() : null, status: 'open', priority: 'normal', ...patch,
});
const source = (patch: Partial<{ appointments: Appointment[]; tasks: Task[]; customers: Customer[]; wallets: WalletRow[] }> = {}) =>
  ({ appointments: [], tasks: [], customers: [customer(1)], wallets: [], ...patch });
const titles = (items: Array<{ title: string }>) => items.map((item) => item.title);

describe('KST 날짜 도구', () => {
  it('UTC 가 아니라 KST 날짜로 계산한다', () => {
    expect(kstDateKey(new Date('2026-10-13T15:30:00Z'))).toBe('2026-10-14');
    expect(kstTimeLabel('2026-10-13T05:05:00Z')).toBe('14:05');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(daysBetween('2026-10-01', '2026-10-13')).toBe(12);
    expect(kstDateKey('not-a-date')).toBe('');
  });
});

describe('예약 알림', () => {
  it('오늘·내일 예약만, 시각 순으로 만든다', () => {
    const items = buildNotifications(source({
      appointments: [
        appointment(3, '2026-10-14T10:00:00'), appointment(1, '2026-10-13T18:00:00'), appointment(2, '2026-10-15T10:00:00'),
        appointment(4, '2026-10-13T09:00:00'),
      ],
    }), NOW);
    expect(titles(items)).toEqual(['오늘 18:00 고객1', '내일 10:00 고객1']);
  });

  it('시작까지 1시간 이내이면 임박으로 강조한다', () => {
    const items = buildNotifications(source({ appointments: [appointment(1, '2026-10-13T14:40:00'), appointment(2, '2026-10-13T15:30:00'), appointment(3, '2026-10-13T15:00:00')] }), NOW);
    expect(items.map((item) => [item.title.slice(0, 8), item.urgent])).toEqual([['오늘 14:40', true], ['오늘 15:00', true], ['오늘 15:30', false]]);
    expect(items[0].detail).toBe('40분 후 · 관리 60분');
  });

  it('취소·노쇼·완료·방문 예약은 알리지 않는다', () => {
    const items = buildNotifications(source({
      appointments: ['canceled', 'no_show', 'completed', 'checked_in'].map((status, index) => appointment(index, '2026-10-13T18:00:00', { status })),
    }), NOW);
    expect(items).toEqual([]);
  });

  it('KST 자정 경계: UTC 로는 같은 날이어도 KST 모레 새벽은 제외한다', () => {
    const items = buildNotifications(source({ appointments: [appointment(1, '2026-10-15T00:30:00'), appointment(2, '2026-10-14T23:30:00')] }), NOW);
    expect(titles(items)).toEqual(['내일 23:30 고객1']);
  });
});

describe('할 일 알림', () => {
  it('기한이 지난 것과 오늘 마감만, 완료·취소·기한 없음은 제외한다', () => {
    const items = buildNotifications(source({
      tasks: [
        task(1, '2026-10-10T12:00:00'), task(2, '2026-10-13T20:00:00'), task(3, '2026-10-14T09:00:00'), task(4, null),
        task(5, '2026-10-01T12:00:00', { status: 'done' }), task(6, '2026-10-01T12:00:00', { status: 'canceled' }), task(7, '2026-10-12T12:00:00', { status: 'in_progress' }),
      ],
    }), NOW);
    expect(titles(items)).toEqual(['할 일1', '할 일7', '할 일2']);
    expect(items[0]).toMatchObject({ urgent: true, detail: '기한 3일 지남 (2026-10-10)', menu: 'tasks' });
    expect(items[2]).toMatchObject({ urgent: false, detail: '오늘 마감 20:00' });
  });
});

describe('생일 알림', () => {
  it('오늘부터 7일 안의 생일만(연도 무관)', () => {
    const items = buildNotifications(source({
      customers: [
        customer(1, { birth_date: '1990-10-13' }), customer(2, { birth_date: '1985-10-19' }), customer(3, { birth_date: '1985-10-20' }),
        customer(4, { birth_date: null }), customer(5, { birth_date: '1980-10-14', status: 'archived' }),
      ],
    }), NOW);
    expect(items.map((item) => [item.title, item.detail, item.urgent])).toEqual([
      ['고객1 고객 생일', '오늘', true], ['고객2 고객 생일', '10월 19일 (6일 후)', false],
    ]);
  });

  it('연말을 넘기고 2/29 생일은 평년 2/28 에 알린다', () => {
    const december = buildNotifications(source({ customers: [customer(1, { birth_date: '1992-01-02' })] }), new Date('2026-12-30T05:00:00Z'));
    expect(titles(december)).toEqual(['고객1 고객 생일']);
    const leap = buildNotifications(source({ customers: [customer(1, { birth_date: '2000-02-29' })] }), new Date('2027-02-26T05:00:00Z'));
    expect(leap[0].detail).toBe('2월 28일 (2일 후)');
    const leapYear = buildNotifications(source({ customers: [customer(1, { birth_date: '2000-02-29' })] }), new Date('2028-02-26T05:00:00Z'));
    expect(leapYear[0].detail).toBe('2월 29일 (3일 후)');
  });
});

describe('만료 회원권 알림', () => {
  const wallet = (n: number, patch: Partial<WalletRow>): WalletRow => ({ id: ID(300 + n), customer_id: ID(1), name_snapshot: '10회권', count_balance: 3, money_balance: 0, ...patch });

  it('30일 안 만료·잔액 있음만, 임박순으로', () => {
    const items = buildNotifications(source({
      wallets: [
        wallet(1, { expires_on: '2026-11-12' }), wallet(2, { expires_on: '2026-11-13' }), wallet(3, { expires_on: '2026-10-12' }), wallet(4, { expires_on: '2026-10-20' }),
        wallet(5, { expires_on: '2026-10-20', count_balance: 0, money_balance: 0 }), wallet(6, { expires_on: null }), wallet(7, { expires_on: '2026-10-13' }),
      ],
    }), NOW);
    expect(items.map((item) => item.detail)).toEqual(['오늘 만료 (2026-10-13)', '7일 후 만료 (2026-10-20)', '30일 후 만료 (2026-11-12)']);
    expect(items.map((item) => item.urgent)).toEqual([true, true, false]);
    expect(items[0]).toMatchObject({ title: '고객1 · 10회권', menu: 'memberships' });
  });

  it('운영 기록에서 형식이 맞는 행만 읽는다', () => {
    const rows = walletRowsFrom([{ id: 'w1', expires_on: '2026-10-20', count_balance: '2' }, { name: '이상한 행' }, { id: 5 }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('w1');
  });
});

describe('전체 정렬과 ID', () => {
  it('예약, 할 일, 생일, 회원권 순으로 모으고 ID 는 같은 입력에서 같다', () => {
    const input = source({
      appointments: [appointment(1, '2026-10-13T18:00:00')], tasks: [task(1, '2026-10-13T20:00:00')],
      customers: [customer(1, { birth_date: '1990-10-14' })], wallets: [{ id: ID(300), expires_on: '2026-10-20', count_balance: 1 }],
    });
    const first = buildNotifications(input, NOW);
    expect(first.map((item) => item.kind)).toEqual(['appointment', 'task', 'birthday', 'wallet']);
    expect(buildNotifications(input, NOW).map((item) => item.id)).toEqual(first.map((item) => item.id));
    expect(new Set(first.map((item) => item.id)).size).toBe(4);
  });
});
