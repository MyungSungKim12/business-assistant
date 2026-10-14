import { describe, expect, it } from 'vitest';
import { blankRecurring, dueDay, monthTooFar, pendingCount, recurringStatus, recurringToForm, validateRecurring, type RecurringExpense } from './recurring';

const item = (over: Partial<RecurringExpense> = {}): RecurringExpense => ({
  id: 'r1', organization_id: 'o', name: '월세', amount: '1200000.00', category: '임대료', counterparty: '건물주', memo: '', day_of_month: 25, is_active: true, version: 1, updated_at: 'x', ...over,
});
const form = (over: Record<string, string | boolean> = {}) => ({ ...blankRecurring(), name: '월세', amount: '1200000', category: '임대료', day_of_month: '25', ...over });

describe('validateRecurring', () => {
  it('정상 입력은 정리해서 돌려준다(쉼표·공백 제거)', () => {
    expect(validateRecurring(form({ name: '  월세  ', amount: ' 1,200,000 ', category: ' 임대료 ' }))).toEqual({
      value: { name: '월세', amount: '1200000', category: '임대료', day_of_month: 25, counterparty: '', memo: '', is_active: true },
    });
  });
  it.each([
    [{ name: '  ' }, '이름을 입력하세요.'],
    [{ amount: '0' }, '금액은 0보다 큰'],
    [{ amount: '-5' }, '금액은 0보다 큰'],
    [{ amount: '1.234' }, '금액은 0보다 큰'],
    [{ amount: 'abc' }, '금액은 0보다 큰'],
    [{ category: ' ' }, '분류를 입력하세요.'],
    [{ day_of_month: '0' }, '날짜는 1~31'],
    [{ day_of_month: '32' }, '날짜는 1~31'],
    [{ day_of_month: '1.5' }, '날짜는 1~31'],
    [{ name: '가'.repeat(121) }, '이름은 120자'],
  ])('잘못된 입력 %j 는 안내한다', (over, message) => {
    const result = validateRecurring(form(over));
    expect('error' in result && result.error).toContain(message);
  });
});

describe('dueDay', () => {
  it('31일 같은 값은 그 달의 마지막 날로 맞춘다', () => {
    expect(dueDay('2026-10', 25)).toBe('2026-10-25');
    expect(dueDay('2026-02', 31)).toBe('2026-02-28');
    expect(dueDay('2028-02', 31)).toBe('2028-02-29');
    expect(dueDay('2026-04', 31)).toBe('2026-04-30');
    expect(dueDay('2026-10', 1)).toBe('2026-10-01');
  });
});

describe('상태와 대기 건수', () => {
  it('등록됨·등록 대기·사용 안 함으로 나눈다', () => {
    const done = new Set(['r1']);
    expect(recurringStatus(item(), done)).toBe('registered');
    expect(recurringStatus(item({ id: 'r2' }), done)).toBe('pending');
    expect(recurringStatus(item({ id: 'r3', is_active: false }), done)).toBe('inactive');
    expect(recurringStatus(item({ is_active: false }), done)).toBe('registered');
    expect(pendingCount([item(), item({ id: 'r2' }), item({ id: 'r3', is_active: false })], done)).toBe(1);
  });
});

describe('monthTooFar', () => {
  it('다음 달까지만 등록할 수 있다', () => {
    expect(monthTooFar('2026-10', '2026-10-14')).toBe(false);
    expect(monthTooFar('2026-11', '2026-10-14')).toBe(false);
    expect(monthTooFar('2026-12', '2026-10-14')).toBe(true);
    expect(monthTooFar('2027-01', '2026-12-20')).toBe(false);
    expect(monthTooFar('2027-02', '2026-12-20')).toBe(true);
    expect(monthTooFar('', '2026-10-14')).toBe(false);
  });
});

describe('recurringToForm', () => {
  it('금액의 .00을 떼고 날짜를 문자열로 바꾼다', () => {
    expect(recurringToForm(item())).toEqual({ name: '월세', amount: '1200000', category: '임대료', day_of_month: '25', counterparty: '건물주', memo: '', is_active: true });
    expect(recurringToForm(item({ amount: '55000.50' })).amount).toBe('55000.50');
  });
});
