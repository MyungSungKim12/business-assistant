import { useEffect, useRef, useState, type FormEvent } from 'react';
import { DateTimeField, Select } from '@business-assistant/react-ui';
import type { Task } from '../../api/schemas';
import { isoToLocalInput } from './taskDates';
import { PRIORITY_LABELS, priorityOf, type TaskPriority } from './taskMeta';

export interface TaskFormValues {
  title: string;
  description: string;
  /** datetime-local 형식(로컬 시간). 비어 있으면 기한 없음. */
  due: string;
  priority: TaskPriority;
}

const PRIORITY_OPTIONS = (Object.keys(PRIORITY_LABELS) as TaskPriority[]).map((value) => ({ value, label: PRIORITY_LABELS[value] }));

export function valuesFromTask(task: Task | null, defaultDue: string): TaskFormValues {
  if (!task) return { title: '', description: '', due: defaultDue, priority: 'normal' };
  return { title: task.title, description: task.description, due: isoToLocalInput(task.due_at), priority: priorityOf(task) };
}

const same = (a: TaskFormValues, b: TaskFormValues) => a.title === b.title && a.description === b.description && a.due === b.due && a.priority === b.priority;

export interface TaskFormProps {
  /** 편집할 할 일. null이면 신규 등록. */
  task: Task | null;
  /** 신규 등록 때 기한 초기값(datetime-local). */
  defaultDue: string;
  readOnly: boolean;
  onSubmit: (values: TaskFormValues) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}

export function TaskForm({ task, defaultDue, readOnly, onSubmit, onDirtyChange }: TaskFormProps) {
  const base = valuesFromTask(task, defaultDue);
  const [values, setValues] = useState<TaskFormValues>(base);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const baseRef = useRef(base);
  const savingRef = useRef(false);

  // 서버 값이 바뀌면(저장·달력 이동) 사용자가 고치는 중이 아닐 때만 입력칸을 새 값으로 맞춘다.
  useEffect(() => {
    const previous = baseRef.current;
    baseRef.current = base;
    if (same(previous, base)) return;
    setValues((current) => (same(current, previous) ? base : current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base.title, base.description, base.due, base.priority]);

  const dirty = !same(values, base);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const patch = (next: Partial<TaskFormValues>) => { setValues((current) => ({ ...current, ...next })); setError(''); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (readOnly || savingRef.current || !values.title.trim()) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await onSubmit({ ...values, title: values.title.trim() });
      if (!task) setValues(valuesFromTask(null, defaultDue));
      setError('');
    } catch {
      setError(task ? '할 일을 저장하지 못했습니다. 입력한 내용은 그대로 두었으니 다시 시도하세요.' : '할 일을 등록하지 못했습니다. 입력한 내용은 그대로 두었으니 다시 시도하세요.');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const canSave = !readOnly && !saving && values.title.trim() !== '' && (task === null || dirty);
  return (
    <form className="tasks-form" onSubmit={(event) => void submit(event)} noValidate>
      <label>제목<input value={values.title} disabled={readOnly} maxLength={200} onChange={(event) => patch({ title: event.currentTarget.value })} /></label>
      <label>설명<textarea value={values.description} disabled={readOnly} onChange={(event) => patch({ description: event.currentTarget.value })} /></label>
      <div className="tasks-form__row">
        <label>기한<DateTimeField value={values.due || null} disabled={readOnly} onChange={(due) => patch({ due: due ?? '' })} /></label>
        <label>우선순위<Select options={PRIORITY_OPTIONS} value={values.priority} disabled={readOnly} onChange={(priority) => patch({ priority })} /></label>
      </div>
      {error && <p role="alert" className="tasks-error">{error}</p>}
      {!readOnly && (
        <div className="tasks-form__actions">
          <button type="submit" className="ba-primary" disabled={!canSave}>{saving ? '저장 중…' : task ? '저장' : '할 일 등록'}</button>
        </div>
      )}
    </form>
  );
}
