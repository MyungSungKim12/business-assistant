import { describe, expect, it } from 'vitest';
import { allowedTransitions, canEditAppointment, needsReason, shortName } from './appointmentRules';

describe('예약 상태 규칙', () => {
  it('예약·확정·방문 상태마다 가능한 처리만 허용한다', () => {
    expect(allowedTransitions('reserved')).toEqual(['confirmed', 'no_show', 'canceled']);
    expect(allowedTransitions('confirmed')).toEqual(['checked_in', 'no_show', 'canceled']);
    expect(allowedTransitions('checked_in')).toEqual(['completed']);
  });

  it('끝난 예약은 더 바꿀 수 없다', () => {
    for (const status of ['completed', 'canceled', 'no_show', 'unknown']) expect(allowedTransitions(status)).toEqual([]);
  });

  it('수정은 예약·확정 상태에서만, 사유는 취소·노쇼에만 필요하다', () => {
    expect(canEditAppointment('reserved')).toBe(true);
    expect(canEditAppointment('confirmed')).toBe(true);
    expect(canEditAppointment('checked_in')).toBe(false);
    expect(canEditAppointment('completed')).toBe(false);
    expect(needsReason('canceled')).toBe(true);
    expect(needsReason('no_show')).toBe(true);
    expect(needsReason('confirmed')).toBe(false);
  });

  it('약칭은 두 글자', () => {
    expect(shortName('김담당')).toBe('김담');
    expect(shortName('박')).toBe('박');
  });
});
