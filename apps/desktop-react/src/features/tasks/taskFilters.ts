import type { Task } from '../../api/schemas';
import { dueDateKey, type DateKey, type DateRangeValue } from './taskDates';
import { priorityOf, statusOf, type TaskPriority, type TaskStatus } from './taskMeta';

export interface TaskFilters {
  query: string;
  status: 'all' | TaskStatus;
  priority: 'all' | TaskPriority;
  range: DateRangeValue;
  /** 담당자: 전체 / 내 담당 / 담당자 없음 */
  assignee: 'all' | 'mine' | 'unassigned';
}

export const EMPTY_FILTERS: TaskFilters = { query: '', status: 'all', priority: 'all', range: { from: null, to: null }, assignee: 'all' };

export function inRange(key: DateKey | null, range: DateRangeValue): boolean {
  if (!range.from && !range.to) return true;
  if (!key) return false;
  const swapped = Boolean(range.from && range.to && range.from > range.to);
  const lower = swapped ? range.to : range.from;
  const upper = swapped ? range.from : range.to;
  if (lower && key < lower) return false;
  if (upper && key > upper) return false;
  return true;
}

export function filterTasks(tasks: Task[], filters: TaskFilters, currentUserId = ''): Task[] {
  const query = filters.query.trim().toLowerCase();
  return tasks.filter((task) => {
    if (query && !`${task.title} ${task.description}`.toLowerCase().includes(query)) return false;
    if (filters.status !== 'all' && statusOf(task) !== filters.status) return false;
    if (filters.priority !== 'all' && priorityOf(task) !== filters.priority) return false;
    if (filters.assignee === 'mine' && (!currentUserId || task.assignee_id !== currentUserId)) return false;
    if (filters.assignee === 'unassigned' && task.assignee_id) return false;
    return inRange(dueDateKey(task.due_at), filters.range);
  });
}

/** 기한 빠른 순, 기한 없음은 마지막. */
export function sortByDue(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.due_at && b.due_at) return new Date(a.due_at).getTime() - new Date(b.due_at).getTime();
    if (a.due_at) return -1;
    if (b.due_at) return 1;
    return a.title.localeCompare(b.title, 'ko');
  });
}

export function groupByDate(tasks: Task[]): { byDate: Map<DateKey, Task[]>; undated: Task[] } {
  const byDate = new Map<DateKey, Task[]>();
  const undated: Task[] = [];
  for (const task of sortByDue(tasks)) {
    const key = dueDateKey(task.due_at);
    if (!key) {
      undated.push(task);
      continue;
    }
    byDate.set(key, [...(byDate.get(key) ?? []), task]);
  }
  return { byDate, undated };
}
