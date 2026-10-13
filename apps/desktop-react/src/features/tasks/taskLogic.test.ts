import { describe, expect, it } from 'vitest';
import type { Task } from '../../api/schemas';
import { addDays, addMonths, buildMonthGrid, buildWeek, dueDateKey, isoToLocalInput, localInputToIso, moveDueToDate, rangeForPreset, startOfWeek } from './taskDates';
import { EMPTY_FILTERS, filterTasks, groupByDate, inRange, sortByDue } from './taskFilters';
import { statusActions } from './taskMeta';

const base = { organization_id: 'o', created_by: 'u', description: '' };
function task(id: string, patch: Partial<Task>): Task {
  return { ...base, id, title: id, due_at: null, status: 'open', priority: 'normal', ...patch };
}
/** 시간대와 무관하게 로컬 시각으로 ISO를 만든다. */
const local = (y: number, m: number, d: number, h = 10, mi = 0) => new Date(y, m - 1, d, h, mi).toISOString();

describe('달력 격자', () => {
  it('항상 6주 42칸이고 일요일에 시작한다', () => {
    for (const anchor of ['2026-10-15', '2026-02-01', '2024-02-29', '2026-03-31']) {
      const grid = buildMonthGrid(anchor);
      expect(grid).toHaveLength(42);
      expect(new Date(`${grid[0].key}T00:00:00Z`).getUTCDay()).toBe(0);
    }
  });
  it('월 경계: 앞뒤 달 날짜를 inMonth=false로 채운다', () => {
    const grid = buildMonthGrid('2026-10-15'); // 2026-10-01은 목요일
    expect(grid[0].key).toBe('2026-09-27');
    expect(grid[0].inMonth).toBe(false);
    expect(grid[4].key).toBe('2026-10-01');
    expect(grid[4].inMonth).toBe(true);
    expect(grid.filter((cell) => cell.inMonth)).toHaveLength(31);
    expect(grid[41].key).toBe('2026-11-07');
  });
  it('윤달(2024-02)은 29일이고 평년(2026-02)은 28일', () => {
    expect(buildMonthGrid('2024-02-10').filter((cell) => cell.inMonth)).toHaveLength(29);
    expect(buildMonthGrid('2026-02-10').filter((cell) => cell.inMonth)).toHaveLength(28);
  });
  it('주 보기는 일~토 7칸', () => {
    const week = buildWeek('2026-10-15');
    expect(week.map((cell) => cell.key)).toEqual(['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17']);
  });
  it('월 이동은 말일로 맞춘다', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('기간 프리셋', () => {
  it('오늘/이번 주/이번 달/전체', () => {
    expect(rangeForPreset('today', '2026-10-15')).toEqual({ from: '2026-10-15', to: '2026-10-15' });
    expect(rangeForPreset('week', '2026-10-15')).toEqual({ from: '2026-10-11', to: '2026-10-17' });
    expect(rangeForPreset('month', '2024-02-10')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(rangeForPreset('all', '2026-10-15')).toEqual({ from: null, to: null });
    expect(startOfWeek('2026-10-11')).toBe('2026-10-11');
  });
});

describe('기한 변환', () => {
  it('로컬 날짜 키와 입력값 변환', () => {
    const iso = local(2026, 10, 15, 23, 30);
    expect(dueDateKey(iso)).toBe('2026-10-15');
    expect(isoToLocalInput(iso)).toBe('2026-10-15T23:30');
    expect(localInputToIso('2026-10-15T23:30')).toBe(iso);
    expect(dueDateKey(null)).toBeNull();
    expect(dueDateKey('잘못된 값')).toBeNull();
    expect(localInputToIso('')).toBeNull();
  });
  it('날짜 이동은 시각을 유지하고 기한이 없으면 09:00', () => {
    expect(moveDueToDate(local(2026, 10, 15, 14, 5), '2026-10-20')).toBe(local(2026, 10, 20, 14, 5));
    expect(moveDueToDate(null, '2026-10-20')).toBe(local(2026, 10, 20, 9, 0));
  });
});

describe('필터', () => {
  const tasks = [
    task('a', { title: '재고 확인', due_at: local(2026, 10, 15), priority: 'high', status: 'open' }),
    task('b', { title: '고객 연락', description: '재방문 안내', due_at: local(2026, 10, 20), status: 'done' }),
    task('c', { title: '청소', due_at: null, priority: 'low', status: 'in_progress' }),
  ];
  it('제목·설명 검색, 상태, 우선순위', () => {
    expect(filterTasks(tasks, { ...EMPTY_FILTERS, query: '재고' }).map((t) => t.id)).toEqual(['a']);
    expect(filterTasks(tasks, { ...EMPTY_FILTERS, query: '재방문' }).map((t) => t.id)).toEqual(['b']);
    expect(filterTasks(tasks, { ...EMPTY_FILTERS, status: 'done' }).map((t) => t.id)).toEqual(['b']);
    expect(filterTasks(tasks, { ...EMPTY_FILTERS, priority: 'low' }).map((t) => t.id)).toEqual(['c']);
  });
  it('특정일·기간 필터는 기한 없는 항목을 제외한다', () => {
    expect(filterTasks(tasks, { ...EMPTY_FILTERS, range: { from: '2026-10-15', to: '2026-10-15' } }).map((t) => t.id)).toEqual(['a']);
    expect(filterTasks(tasks, { ...EMPTY_FILTERS, range: { from: '2026-10-01', to: '2026-10-31' } }).map((t) => t.id)).toEqual(['a', 'b']);
    expect(filterTasks(tasks, { ...EMPTY_FILTERS, range: { from: '2026-10-16', to: null } }).map((t) => t.id)).toEqual(['b']);
    expect(filterTasks(tasks, EMPTY_FILTERS)).toHaveLength(3);
  });
  it('시작이 종료보다 늦어도 뒤집어 처리', () => {
    expect(inRange('2026-10-15', { from: '2026-10-20', to: '2026-10-10' })).toBe(true);
  });
  it('기한순 정렬과 날짜별 묶음', () => {
    expect(sortByDue(tasks).map((t) => t.id)).toEqual(['a', 'b', 'c']);
    const { byDate, undated } = groupByDate(tasks);
    expect(byDate.get('2026-10-15')?.map((t) => t.id)).toEqual(['a']);
    expect(undated.map((t) => t.id)).toEqual(['c']);
  });
  it('상태별 변경 버튼', () => {
    expect(statusActions('open').map((a) => a.label)).toEqual(['시작', '완료', '취소']);
    expect(statusActions('done').map((a) => a.label)).toEqual(['다시 열기']);
  });
});
