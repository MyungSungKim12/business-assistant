import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../api/client';
import { availabilityPath, dateOfLocalInput, describeBlock, describeSlot, fetchAvailability, slotAt, timeOfLocalInput, visibleSlots, type AvailabilitySlot } from './availability';

const slot = (start: string, available: boolean, blocked: AvailabilitySlot['blocked'] = [], staff_ids: string[] = []): AvailabilitySlot => ({
  start, start_at: `2026-12-14T${start}:00+09:00`, end_at: `2026-12-14T${start}:00+09:00`, available, staff_ids, blocked,
});
const names = (id: string) => (id === 's1' ? '김담당' : undefined);

describe('availabilityPath', () => {
  it('omits empty options and sorts resource ids', () => {
    expect(availabilityPath('org', { serviceId: 'svc', date: '2026-12-14' })).toBe('/organizations/org/appointment-availability?service_id=svc&date=2026-12-14');
    const path = availabilityPath('org', { serviceId: 'svc', date: '2026-12-14', staffId: 's1', resourceIds: ['b', 'a'], excludeAppointmentId: 'x' });
    expect(path).toContain('staff_id=s1');
    expect(decodeURIComponent(path)).toContain('resource_ids=a,b');
    expect(path).toContain('exclude_appointment_id=x');
  });
});

describe('local input helpers', () => {
  it('reads the date and time parts of a datetime-local value', () => {
    expect(dateOfLocalInput('2026-12-14T10:30')).toBe('2026-12-14');
    expect(dateOfLocalInput('')).toBeNull();
    expect(dateOfLocalInput('2026-13-40T10:30')).toBeNull();
    expect(timeOfLocalInput('2026-12-14T10:30')).toBe('10:30');
    expect(timeOfLocalInput('')).toBeNull();
  });
});

describe('visibleSlots', () => {
  it('keeps available slots and slots blocked by leave, other bookings or resources, and hides hours/past noise', () => {
    const slots = [
      slot('08:00', false, [{ code: 'outside_hours', staff_id: 's1' }]),
      slot('09:00', true),
      slot('09:30', false, [{ code: 'past', staff_id: null }, { code: 'staff_busy', staff_id: 's1' }]),
      slot('12:00', false, [{ code: 'time_off', staff_id: 's1' }]),
      slot('13:00', false, [{ code: 'resource_unavailable', staff_id: null, kind: 'room', needed: 1, free: 0 }]),
      slot('23:30', false, [{ code: 'outside_default_window', staff_id: 's1' }]),
    ];
    expect(visibleSlots(slots).map((item) => item.start)).toEqual(['09:00', '09:30', '12:00', '13:00']);
    expect(slotAt(slots, '12:00')?.start).toBe('12:00');
    expect(slotAt(slots, null)).toBeUndefined();
    expect(slotAt(slots, '11:00')).toBeUndefined();
  });
});

describe('reason text', () => {
  it('describes each block code in Korean with the staff name', () => {
    expect(describeBlock({ code: 'time_off', staff_id: 's1' }, names)).toBe('김담당: 휴무입니다');
    expect(describeBlock({ code: 'staff_busy', staff_id: 'zz' }, names)).toBe('담당자: 다른 예약이 있습니다');
    expect(describeBlock({ code: 'outside_hours', staff_id: 's1' }, names)).toContain('근무시간이 아닙니다');
    expect(describeBlock({ code: 'past', staff_id: null }, names)).toBe('이미 지난 시각입니다');
    expect(describeBlock({ code: 'resource_unavailable', staff_id: null, kind: 'equipment', needed: 2, free: 1 }, names)).toBe('장비이 부족합니다 (필요 2, 가능 1)');
    expect(describeBlock({ code: 'resource_unavailable', staff_id: null, resource_id: 'r1' }, names)).toContain('선택한 공간·장비');
  });

  it('joins reasons for the tooltip and marks available slots', () => {
    expect(describeSlot(slot('09:00', true), names)).toBe('예약 가능');
    expect(describeSlot(slot('09:00', true, [{ code: 'staff_busy', staff_id: 's1' }]), names)).toBe('예약 가능 · 참고: 김담당: 다른 예약이 있습니다');
    expect(describeSlot(slot('12:00', false, [{ code: 'time_off', staff_id: 's1' }, { code: 'resource_unavailable', staff_id: null, kind: 'room', needed: 1, free: 0 }]), names))
      .toBe('김담당: 휴무입니다, 공간이 부족합니다 (필요 1, 가능 0)');
  });
});

describe('fetchAvailability', () => {
  const api = (result: unknown) => ({ call: vi.fn(async () => result) }) as unknown as ApiClient;
  it('returns parsed data for a valid response and null for anything else', async () => {
    const valid = { date: '2026-12-14', service_id: 'svc', duration_minutes: 60, buffer_minutes: 0, step_minutes: 30, staff: [], required_resources: [], slots: [slot('09:00', true)], advisory: '안내' };
    expect((await fetchAvailability(api(valid), 'org', { serviceId: 'svc', date: '2026-12-14' }))?.slots).toHaveLength(1);
    expect(await fetchAvailability(api([]), 'org', { serviceId: 'svc', date: '2026-12-14' })).toBeNull();
  });
});
