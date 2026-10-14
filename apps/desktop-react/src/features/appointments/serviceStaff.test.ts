import { describe, expect, it } from 'vitest';
import { buildServiceStaffMap, canStaffDoService, staffSummary } from './serviceStaff';

const rows = [
  { service_id: 's1', staff_id: 'a' }, { service_id: 's1', staff_id: 'b' }, { service_id: 's1', staff_id: 'c' }, { service_id: 's2', staff_id: 'a' },
];
const names: Record<string, string> = { a: '김원장', b: '이실장', c: '박직원' };

describe('서비스별 담당 가능 직원 규칙', () => {
  it('행을 서비스별 직원 목록으로 묶는다', () => {
    expect(buildServiceStaffMap(rows)).toEqual({ s1: ['a', 'b', 'c'], s2: ['a'] });
    expect(buildServiceStaffMap([])).toEqual({});
  });

  it('지정이 없는 서비스와 서비스를 고르기 전에는 누구나 가능하다', () => {
    const map = buildServiceStaffMap(rows);
    expect(canStaffDoService(map, 's3', 'z')).toBe(true);
    expect(canStaffDoService(map, '', 'z')).toBe(true);
    expect(canStaffDoService({ s9: [] }, 's9', 'z')).toBe(true);
  });

  it('지정이 있으면 지정된 직원만 가능하다', () => {
    const map = buildServiceStaffMap(rows);
    expect(canStaffDoService(map, 's2', 'a')).toBe(true);
    expect(canStaffDoService(map, 's2', 'b')).toBe(false);
  });

  it('표 요약: 제한 없음, 이름(2명 이하), 인원수', () => {
    const map = buildServiceStaffMap(rows);
    expect(staffSummary(map, 's3', (id) => names[id])).toBe('모든 직원');
    expect(staffSummary(map, 's2', (id) => names[id])).toBe('김원장');
    expect(staffSummary({ s4: ['a', 'b'] }, 's4', (id) => names[id])).toBe('김원장, 이실장');
    expect(staffSummary(map, 's1', (id) => names[id])).toBe('3명');
  });
});
