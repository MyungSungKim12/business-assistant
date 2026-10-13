import { describe, expect, it } from 'vitest';
import { addDays, formatDateLabel, formatKstTime, intervalOnDay, isDateKey, kstDateKey, kstDayStartMs, kstIso, kstParts, todayKstKey, toKstLocalInput, weekDaysOf, weekStartOf } from './appointmentTime';

describe('KST 날짜 계산', () => {
  it('UTC 순간을 한국 날짜·분으로 바꾼다(날짜 경계 포함)', () => {
    expect(kstParts('2026-10-13T14:59:00Z')).toEqual({ date: '2026-10-13', minutes: 23 * 60 + 59 });
    expect(kstParts('2026-10-13T15:00:00Z')).toEqual({ date: '2026-10-14', minutes: 0 });
    expect(kstParts('2026-12-31T15:30:00Z')).toEqual({ date: '2027-01-01', minutes: 30 });
    expect(kstDateKey(Date.UTC(2026, 9, 13, 0, 0))).toBe('2026-10-13');
  });

  it('todayKstKey는 주어진 순간의 한국 날짜다', () => {
    expect(todayKstKey(Date.parse('2026-03-01T14:59:59Z'))).toBe('2026-03-01');
    expect(todayKstKey(Date.parse('2026-03-01T15:00:00Z'))).toBe('2026-03-02');
  });

  it('날짜 더하기는 월·연·윤년 경계를 넘는다', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('주는 월요일에 시작한다', () => {
    expect(weekStartOf('2026-10-13')).toBe('2026-10-12'); // 화요일
    expect(weekStartOf('2026-10-18')).toBe('2026-10-12'); // 일요일은 그 주의 마지막
    expect(weekStartOf('2026-10-12')).toBe('2026-10-12');
    expect(weekDaysOf('2026-10-13')).toEqual(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']);
  });

  it('입력·표시 형식', () => {
    expect(kstIso('2026-10-13T09:05')).toBe('2026-10-13T09:05:00+09:00');
    expect(toKstLocalInput('2026-10-13T00:30:00Z')).toBe('2026-10-13T09:30');
    expect(toKstLocalInput('2026-10-13T15:00:00Z')).toBe('2026-10-14T00:00');
    expect(formatKstTime('2026-10-13T01:00:00+09:00')).toBe('01:00');
    expect(formatDateLabel('2026-10-13')).toBe('10월 13일 (화)');
    expect(isDateKey('2026-02-30')).toBe(false);
    expect(isDateKey('2026-02-28')).toBe(true);
  });

  it('하루의 시작은 한국 자정이다', () => {
    expect(kstDayStartMs('2026-10-13')).toBe(Date.parse('2026-10-12T15:00:00Z'));
  });
});

describe('intervalOnDay', () => {
  it('그날 0시 기준 분과 여유 시간 끝을 돌려준다', () => {
    expect(intervalOnDay('2026-10-13T10:00:00+09:00', '2026-10-13T11:00:00+09:00', 10, '2026-10-13'))
      .toEqual({ startMin: 600, endMin: 660, bufferEndMin: 670, clippedStart: false, clippedEnd: false });
  });

  it('다른 날 예약은 null이다(자정 경계 포함)', () => {
    expect(intervalOnDay('2026-10-13T10:00:00+09:00', '2026-10-13T11:00:00+09:00', 0, '2026-10-14')).toBeNull();
    expect(intervalOnDay('2026-10-13T10:00:00+09:00', '2026-10-13T11:00:00+09:00', 0, '2026-10-12')).toBeNull();
    // 24:00에 끝나는 예약은 다음 날에 걸치지 않는다.
    expect(intervalOnDay('2026-10-13T23:00:00+09:00', '2026-10-14T00:00:00+09:00', 0, '2026-10-14')).toBeNull();
    // 00:00에 시작하는 예약은 그날에 속한다.
    expect(intervalOnDay('2026-10-14T00:00:00+09:00', '2026-10-14T01:00:00+09:00', 0, '2026-10-14')?.startMin).toBe(0);
  });

  it('자정을 넘는 예약은 양쪽 날짜에서 잘라 그린다', () => {
    const start = '2026-10-13T23:30:00+09:00';
    const end = '2026-10-14T00:30:00+09:00';
    expect(intervalOnDay(start, end, 0, '2026-10-13')).toMatchObject({ startMin: 1410, endMin: 1440, clippedEnd: true, clippedStart: false });
    expect(intervalOnDay(start, end, 0, '2026-10-14')).toMatchObject({ startMin: 0, endMin: 30, clippedStart: true, clippedEnd: false });
  });

  it('시간대와 무관하게 UTC 표기로 들어온 값도 한국 시간으로 해석한다', () => {
    expect(intervalOnDay('2026-10-13T15:30:00Z', '2026-10-13T16:30:00Z', 0, '2026-10-14')).toMatchObject({ startMin: 30, endMin: 90 });
  });
});
