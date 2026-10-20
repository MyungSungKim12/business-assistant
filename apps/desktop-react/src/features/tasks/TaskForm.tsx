import { useEffect, useRef, useState, type FormEvent } from 'react';
import { DateTimeField, Select } from '@business-assistant/react-ui';
import type { Appointment, Task } from '../../api/schemas';
import { isoToLocalInput } from './taskDates';
import { PRIORITY_LABELS, RECURRENCE_LABELS, priorityOf, recurrenceOf, type TaskPriority, type TaskRecurrence } from './taskMeta';
import { labelsOf, labelsText } from './checklistLogic';

export interface TaskFormValues {
  title: string;
  description: string;
  /** datetime-local 형식(로컬 시간). 비어 있으면 기한 없음. */
  due: string;
  priority: TaskPriority;
  /** 쉼표로 구분한 라벨 입력(최대 10개) */
  labels: string;
  /** 반복 주기. 빈 문자열이면 반복 없음(기한이 있어야 한다). */
  recurrence: '' | TaskRecurrence;
  /** 연결한 고객 ID. 빈 문자열이면 연결 없음. */
  customerId: string;
  appointmentId: string;
  /** 담당자 사용자 ID. 빈 문자열이면 지정 안 함. */
  assigneeId: string;
}

const RECURRENCE_OPTIONS: Array<{ value: '' | TaskRecurrence; label: string }> = [{ value: '', label: '반복 안 함' }, ...(Object.keys(RECURRENCE_LABELS) as TaskRecurrence[]).map((value) => ({ value, label: RECURRENCE_LABELS[value] }))];
const PRIORITY_OPTIONS = (Object.keys(PRIORITY_LABELS) as TaskPriority[]).map((value) => ({ value, label: PRIORITY_LABELS[value] }));

export function valuesFromTask(task: Task | null, defaultDue: string): TaskFormValues {
  if (!task) return { title: '', description: '', due: defaultDue, priority: 'normal', labels: '', recurrence: '', customerId: '', appointmentId: '', assigneeId: '' };
  return { title: task.title, description: task.description, due: isoToLocalInput(task.due_at), priority: priorityOf(task), labels: labelsText(labelsOf(task)), recurrence: recurrenceOf(task) ?? '', customerId: task.customer_id ?? '', appointmentId: task.appointment_id ?? '', assigneeId: task.assignee_id ?? '' };
}

const same = (a: TaskFormValues, b: TaskFormValues) => a.title === b.title && a.description === b.description && a.due === b.due && a.priority === b.priority && a.labels === b.labels && a.recurrence === b.recurrence && a.customerId === b.customerId && a.appointmentId === b.appointmentId && a.assigneeId === b.assigneeId;

export interface TaskFormProps {
  /** 편집할 할 일. null이면 신규 등록. */
  task: Task | null;
  /** 신규 등록 때 기한 초기값(datetime-local). */
  defaultDue: string;
  readOnly: boolean;
  /** 고객 연결 선택지. 비어 있으면 고객 칸을 숨긴다. */
  customers?: Array<{ id: string; name: string }>;
  appointments?: Appointment[];
  /** 담당자 선택지(구성원). 비어 있으면 담당자 칸을 숨긴다. */
  people?: Array<{ id: string; name: string }>;
  onSubmit: (values: TaskFormValues) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}

export function TaskForm({ task, defaultDue, readOnly, customers = [], appointments = [], people = [], onSubmit, onDirtyChange }: TaskFormProps) {
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
  }, [base.title, base.description, base.due, base.priority, base.labels, base.recurrence, base.customerId, base.appointmentId, base.assigneeId]);

  const dirty = !same(values, base);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const patch = (next: Partial<TaskFormValues>) => { setValues((current) => ({ ...current, ...next })); setError(''); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (readOnly || savingRef.current || !values.title.trim()) return;
    if (values.recurrence && !values.due) { setError('반복하려면 기한을 정해 주세요.'); return; }
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

  const customerOptions = [{ value: '', label: '연결 안 함' }, ...customers.map((customer) => ({ value: customer.id, label: customer.name })), ...(values.customerId && !customers.some((customer) => customer.id === values.customerId) ? [{ value: values.customerId, label: '(목록에 없는 고객)' }] : [])];
  const appointmentOptions = [{ value: '', label: '연결 안 함' }, ...appointments.filter((appointment) => appointment.status !== 'canceled').map((appointment) => {
    const customerName = customers.find((customer) => customer.id === appointment.customer_id)?.name ?? '고객';
    const when = new Intl.DateTimeFormat('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(appointment.start_at));
    return { value: appointment.id, label: `${when} · ${customerName} · ${appointment.service_name_snapshot}` };
  }), ...(values.appointmentId && !appointments.some((appointment) => appointment.id === values.appointmentId) ? [{ value: values.appointmentId, label: '(목록에 없는 예약)' }] : [])];
  const assigneeOptions = [{ value: '', label: '지정 안 함' }, ...people.map((person) => ({ value: person.id, label: person.name })), ...(values.assigneeId && !people.some((person) => person.id === values.assigneeId) ? [{ value: values.assigneeId, label: '(구성원 아님)' }] : [])];
  const canSave = !readOnly && !saving && values.title.trim() !== '' && (task === null || dirty);
  return (
    <form className="tasks-form" onSubmit={(event) => void submit(event)} noValidate>
      <label>제목<input value={values.title} disabled={readOnly} maxLength={200} onChange={(event) => patch({ title: event.currentTarget.value })} /></label>
      <label>설명<textarea value={values.description} disabled={readOnly} onChange={(event) => patch({ description: event.currentTarget.value })} /></label>
      <div className="tasks-form__row">
        <label>기한<DateTimeField value={values.due || null} disabled={readOnly} onChange={(due) => patch({ due: due ?? '' })} /></label>
        <label>우선순위<Select options={PRIORITY_OPTIONS} value={values.priority} disabled={readOnly} onChange={(priority) => patch({ priority })} /></label>
      </div>
      <label>반복<Select options={RECURRENCE_OPTIONS} value={values.recurrence} disabled={readOnly} onChange={(recurrence) => patch({ recurrence })} /></label>
      {people.length > 0 || values.assigneeId ? <label>담당자<Select options={assigneeOptions} value={values.assigneeId} disabled={readOnly} onChange={(assigneeId) => patch({ assigneeId })} /></label> : null}
      {customers.length > 0 || values.customerId ? <label>고객<Select options={customerOptions} value={values.customerId} disabled={readOnly || Boolean(values.appointmentId)} onChange={(customerId) => patch({ customerId })} /></label> : null}
      {appointments.length > 0 || values.appointmentId ? <label>예약<Select options={appointmentOptions} value={values.appointmentId} disabled={readOnly} onChange={(appointmentId) => {
        const appointment = appointments.find((row) => row.id === appointmentId);
        patch({ appointmentId, ...(appointment ? { customerId: appointment.customer_id } : {}) });
      }} /></label> : null}
      <label>라벨<input value={values.labels} disabled={readOnly} placeholder="쉼표로 구분(예: 재고, 월말)" onChange={(event) => patch({ labels: event.currentTarget.value })} /></label>
      {error && <p role="alert" className="tasks-error">{error}</p>}
      {!readOnly && (
        <div className="tasks-form__actions">
          <button type="submit" className="ba-primary" disabled={!canSave}>{saving ? '저장 중…' : task ? '저장' : '할 일 등록'}</button>
        </div>
      )}
    </form>
  );
}
