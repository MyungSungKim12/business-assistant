import type { Task } from '../../api/schemas';

export type TaskStatus = 'open' | 'in_progress' | 'done' | 'canceled';
export type TaskPriority = 'low' | 'normal' | 'high';

export const STATUS_LABELS: Record<TaskStatus, string> = { open: '대기', in_progress: '진행', done: '완료', canceled: '취소' };
export const PRIORITY_LABELS: Record<TaskPriority, string> = { low: '낮음', normal: '보통', high: '높음' };

export function statusOf(task: Task): TaskStatus {
  return task.status in STATUS_LABELS ? (task.status as TaskStatus) : 'open';
}

export function priorityOf(task: Task): TaskPriority {
  return task.priority in PRIORITY_LABELS ? (task.priority as TaskPriority) : 'normal';
}

export interface StatusAction { label: string; next: TaskStatus }

/** 상태별로 상세 패널에 보여 줄 상태 변경 버튼. */
export function statusActions(status: TaskStatus): StatusAction[] {
  if (status === 'open') return [{ label: '시작', next: 'in_progress' }, { label: '완료', next: 'done' }, { label: '취소', next: 'canceled' }];
  if (status === 'in_progress') return [{ label: '완료', next: 'done' }, { label: '취소', next: 'canceled' }];
  return [{ label: '다시 열기', next: 'open' }];
}
