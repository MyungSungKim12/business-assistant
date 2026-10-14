import { useState } from 'react';
import { confirm } from '@business-assistant/react-ui';
import type { Task } from '../../api/schemas';
import { formatDue } from './taskDates';
import { TaskChecklist } from './TaskChecklist';
import type { Checklist } from './checklistLogic';
import { TaskForm, type TaskFormValues } from './TaskForm';
import { STATUS_LABELS, statusActions, statusOf, type TaskStatus } from './taskMeta';

export interface TaskDetailProps {
  /** 선택된 할 일. null이면 신규 등록 양식을 보여 준다. */
  task: Task | null;
  /** 신규 등록 양식을 다시 만들 때 바뀌는 값(달력 날짜 클릭으로 기한을 채울 때 사용). */
  createKey: number;
  /** 신규 등록 기한 초기값(datetime-local). */
  createDue: string;
  readOnly: boolean;
  customers?: Array<{ id: string; name: string }>;
  people?: Array<{ id: string; name: string }>;
  /** 이 할 일의 상태·체크리스트를 바꿀 수 있는지(관리자이거나 담당자). 내용 수정은 readOnly가 따로 막는다. */
  canWork?: (task: Task) => boolean;
  onCreate: (values: TaskFormValues) => Promise<void>;
  onUpdate: (task: Task, values: TaskFormValues) => Promise<void>;
  onStatus: (task: Task, status: TaskStatus) => Promise<void>;
  onChecklist: (task: Task, checklist: Checklist) => Promise<void>;
  onDelete: (task: Task) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}

function createdAtOf(task: Task): string | null {
  const value = (task as Task & { created_at?: unknown }).created_at;
  return typeof value === 'string' ? formatDue(value) : null;
}

export function TaskDetail({ task, createKey, createDue, readOnly, customers, people, canWork, onCreate, onUpdate, onStatus, onChecklist, onDelete, onDirtyChange }: TaskDetailProps) {
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>, message: string) => {
    if (busy) return;
    setBusy(true);
    setActionError('');
    try {
      await action();
    } catch {
      setActionError(message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (target: Task) => {
    const ok = await confirm({ title: '할 일 삭제', message: `'${target.title}' 할 일을 삭제할까요? 삭제하면 되돌릴 수 없습니다.`, confirmLabel: '삭제', tone: 'danger' });
    if (ok) await run(() => onDelete(target), '할 일을 삭제하지 못했습니다.');
  };

  if (!task) {
    return (
      <aside className="tasks-panel tasks-detail" aria-label="할 일 상세">
        <header className="tasks-panel__head"><h2>새 할 일 등록</h2></header>
        <div className="tasks-detail__body">
          {readOnly && <p className="tasks-muted">조회 전용 계정입니다. 목록에서 할 일을 선택해 내용을 확인하세요.</p>}
          {!readOnly && <TaskForm key={`new-${createKey}`} task={null} defaultDue={createDue} readOnly={false} customers={customers} people={people} onSubmit={onCreate} onDirtyChange={onDirtyChange} />}
        </div>
      </aside>
    );
  }

  const status = statusOf(task);
  const created = createdAtOf(task);
  const work = canWork ? canWork(task) : !readOnly;
  const completedAt = task.completed_at ? formatDue(task.completed_at) : null;
  return (
    <aside className="tasks-panel tasks-detail" aria-label="할 일 상세">
      <header className="tasks-panel__head">
        <h2>할 일 상세</h2>
        <span className={`tasks-status tasks-status--${status}`}>{STATUS_LABELS[status]}</span>
      </header>
      <div className="tasks-detail__body">
        {(created || (status === 'done' && task.completed_by_name)) && (
          <dl className="tasks-meta">
            {created && <><dt>생성일</dt><dd>{created}</dd></>}
            {status === 'done' && task.completed_by_name && <><dt>완료한 사람</dt><dd data-testid="completed-by">{task.completed_by_name}{completedAt ? ` · ${completedAt}` : ''}</dd></>}
          </dl>
        )}
        <TaskForm key={task.id} task={task} defaultDue="" readOnly={readOnly} customers={customers} people={people} onSubmit={(values) => onUpdate(task, values)} onDirtyChange={onDirtyChange} />
        <TaskChecklist key={`check-${task.id}`} task={task} readOnly={!work} onChange={(checklist) => onChecklist(task, checklist)} />
        {actionError && <p role="alert" className="tasks-error">{actionError}</p>}
        {work && (
          <div className="tasks-detail__actions">
            <div role="group" aria-label="상태 변경">
              {statusActions(status).map((action) => (
                <button key={action.next} type="button" disabled={busy} onClick={() => void run(() => onStatus(task, action.next), '할 일 상태를 변경하지 못했습니다.')}>{action.label}</button>
              ))}
            </div>
            {!readOnly && <button type="button" className="tasks-danger" disabled={busy} onClick={() => void remove(task)}>삭제</button>}
          </div>
        )}
      </div>
    </aside>
  );
}
