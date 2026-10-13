import { describe, expect, it } from 'vitest';
import { consultationReady, emptyForm, eventChanges, isCalendarDate, sameCautions, validateForm } from './logic';
import type { Treatment } from './schemas';

const customer = { id: 'c', organization_id: 'o', name: '김', email: null, phone: null, notes: '', birth_date: null, skin_type: '건성', concerns: ['건조', '홍조'], allergies: '향료', last_visit_date: null, next_visit_date: null, tags: [], status: 'active' };
const filled = { ...emptyForm('2026-09-18'), treatment_name: '관리' };

describe('validateForm', () => {
  it('trims text and maps empty optional fields to null', () => {
    expect(validateForm({ ...filled, treatment_name: ' 관리 ', category: ' 피부 ' })).toEqual({ values: { treatment_date: '2026-09-18', treatment_name: '관리', category: '피부', practitioner: '', notes: '', amount: null, next_visit_date: null } });
  });
  it.each([
    [{ treatment_name: '  ' }], [{ treatment_date: '2026-02-30' }], [{ next_visit_date: '2026-09-17' }], [{ amount: '-1' }], [{ amount: '1e3' }],
    [{ amount: '1000000000000' }], [{ amount: '1.001' }], [{ notes: 'a'.repeat(10_001) }], [{ treatment_name: 'a'.repeat(201) }],
  ])('rejects %j', (patch) => {
    expect(validateForm({ ...filled, ...patch })).toHaveProperty('error');
  });
  it('accepts boundary amounts', () => {
    for (const amount of ['0', '0.5', '999999999999.99']) expect(validateForm({ ...filled, amount })).toHaveProperty('values.amount', amount);
  });
});

describe('dates', () => {
  it.each([['2026-09-18', true], ['2024-02-29', true], ['2026-02-29', false], ['2026-13-01', false], ['26-09-18', false], ['0000-01-01', false]])('%s -> %s', (value, expected) => {
    expect(isCalendarDate(value)).toBe(expected);
  });
});

describe('consultation readiness', () => {
  const record = { consultation_goal: '목표', cautions_snapshot: { allergies: '향료', skin_type: '건성', concerns: ['건조', '홍조'] }, cautions_acknowledged_by: 'u', cautions_acknowledged_at: '2026-09-20T00:00:00Z' } as unknown as Treatment;
  it('requires goal, acknowledgement and an unchanged caution snapshot regardless of key order', () => {
    expect(consultationReady(record, customer)).toBe(true);
    expect(sameCautions({ concerns: ['건조', '홍조'], skin_type: '건성', allergies: '향료' }, customer)).toBe(true);
    expect(consultationReady({ ...record, consultation_goal: '  ' }, customer)).toBe(false);
    expect(consultationReady({ ...record, cautions_acknowledged_by: null }, customer)).toBe(false);
    expect(consultationReady(record, { ...customer, allergies: '' })).toBe(false);
    expect(consultationReady(record, { ...customer, concerns: ['홍조', '건조'] })).toBe(false);
    expect(consultationReady({ ...record, cautions_snapshot: {} }, customer)).toBe(false);
  });
});

describe('eventChanges', () => {
  it('lists only labelled fields that changed', () => {
    const lines = eventChanges({ id: '1', actor_id: 'a', action: 'edit', reason: '', occurred_at: '', before_data: { notes: 'a', amount: null, id: 'x' }, after_data: { notes: 'b', amount: '10.00', id: 'y' } });
    expect(lines).toEqual(['시술 내용: a → b', '예정 금액: — → 10.00']);
  });
});
