import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { confirm, notify } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import type { Customer, Task } from '../../api/schemas';
import { TaskCalendar } from './TaskCalendar';
import { TaskDetail } from './TaskDetail';
import type { TaskFormValues } from './TaskForm';
import { TaskList } from './TaskList';
import { parseLabels, type Checklist } from './checklistLogic';
import { dateKeyToLocalInput, dueDateKey, localInputToIso, moveDueToDate, toDateKey, type DateKey } from './taskDates';
import { EMPTY_FILTERS, filterTasks, sortByDue, type TaskFilters } from './taskFilters';
import type { TaskStatus } from './taskMeta';
import './tasks.css';

export interface TaskPageProps {
  api: ApiClient;
  organizationId: string;
  /** member 등 조회 전용 계정. */
  readOnly?: boolean;
  /** 오늘로 취급할 날짜(테스트용). 기본은 실행 환경의 오늘. */
  todayKey?: DateKey;
}

function mergeTask(items: Task[], next: Task): Task[] {
  return items.map((item) => (item.id === next.id ? { ...item, ...next } : item));
}

export function TaskPage({ api, organizationId, readOnly = false, todayKey: todayOverride }: TaskPageProps) {
  const todayKey = useMemo(() => todayOverride ?? toDateKey(new Date()), [todayOverride]);
  const [items, setItems] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState<TaskFilters>(EMPTY_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createKey, setCreateKey] = useState(0);
  const [createDue, setCreateDue] = useState('');
  const [completing, setCompleting] = useState(false);
  const [customers, setCustomers] = useState<Customer[]>([]);
  // 고객 연결 선택지. 불러오지 못해도 할 일 화면은 그대로 쓴다.
  useEffect(() => { let live = true; Promise.resolve().then(() => api.listCustomers(organizationId)).then((rows) => { if (live) setCustomers(rows.filter((row) => row.status !== 'archived')); }, () => undefined); return () => { live = false; }; }, [api, organizationId]);
  const customerOptions = useMemo(() => [...customers].sort((a, b) => a.name.localeCompare(b.name, 'ko')).map((row) => ({ id: row.id, name: row.name })), [customers]);
  const dirtyRef = useRef(false);
  const itemsRef = useRef<Task[]>([]);
  itemsRef.current = items;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await api.listTasks(organizationId));
      setError('');
    } catch {
      setError('할 일 목록을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [api, organizationId]);
  useEffect(() => { void load(); }, [load]);

  const onDirtyChange = useCallback((dirty: boolean) => { dirtyRef.current = dirty; }, []);
  const confirmLeave = async () => {
    if (!dirtyRef.current) return true;
    const ok = await confirm({ title: '작성 중인 내용', message: '저장하지 않은 내용이 있습니다. 버리고 이동할까요?', confirmLabel: '버리기', tone: 'danger' });
    if (ok) dirtyRef.current = false;
    return ok;
  };

  const selected = useMemo(() => items.find((item) => item.id === selectedId) ?? null, [items, selectedId]);
  const rows = useMemo(() => sortByDue(filterTasks(items, filters)), [items, filters]);

  const selectTask = async (task: Task) => {
    if (task.id === selectedId) return;
    if (!dirtyRef.current) { setSelectedId(task.id); return; }
    if (!(await confirmLeave())) return;
    setSelectedId(task.id);
  };
  const startNew = async () => {
    if (selected === null && !dirtyRef.current) { setCreateKey((value) => value + 1); setCreateDue(''); return; }
    if (!(await confirmLeave())) return;
    setSelectedId(null);
    setCreateDue('');
    setCreateKey((value) => value + 1);
  };
  const selectDate = (key: DateKey) => {
    setFilters((current) => ({ ...current, range: { from: key, to: key } }));
    setCreateDue(dateKeyToLocalInput(key));
  };

  const createTask = async (values: TaskFormValues) => {
    const created = await api.createTask(organizationId, { title: values.title, description: values.description, due_at: localInputToIso(values.due), priority: values.priority, labels: parseLabels(values.labels), recurrence: values.recurrence || null, customer_id: values.customerId || null });
    setItems((current) => [...current, created]);
    setCreateDue('');
    setSelectedId(created.id);
  };
  const updateTask = async (task: Task, values: TaskFormValues) => {
    const saved = await api.updateTask(organizationId, task.id, { title: values.title, description: values.description, due_at: localInputToIso(values.due), priority: values.priority, labels: parseLabels(values.labels), recurrence: values.recurrence || null, customer_id: values.customerId || null });
    setItems((current) => mergeTask(current, saved));
  };
  const changeStatus = async (task: Task, status: TaskStatus) => {
    const saved = await api.updateTask(organizationId, task.id, { status });
    setItems((current) => mergeTask(current, saved));
    // 반복 할 일을 완료하면 서버가 다음 할 일을 만든다. 목록을 다시 읽어 보여 준다.
    if (status === 'done' && task.recurrence) { void load(); notify.info('다음 반복 할 일이 만들어졌습니다.'); }
  };
  /** 화면에 보이는(필터 결과) 미완료 할 일을 하나씩 완료 처리한다. 일부가 실패해도 성공한 것은 유지하고 건수를 알린다. */
  const completeVisible = async (tasks: Task[]) => {
    if (readOnly || completing || tasks.length === 0) return;
    const ok = await confirm({ title: '일괄 완료', message: `보이는 할 일 ${tasks.length}건을 모두 완료 처리할까요? 완료한 항목은 상세에서 다시 열 수 있습니다.`, confirmLabel: '모두 완료' });
    if (!ok) return;
    setCompleting(true);
    let failed = 0;
    let spawned = false;
    for (const task of tasks) {
      try {
        const saved = await api.updateTask(organizationId, task.id, { status: 'done' });
        setItems((current) => mergeTask(current, saved));
        if (task.recurrence) spawned = true;
      } catch { failed += 1; }
    }
    if (spawned) void load();
    setCompleting(false);
    if (failed === 0) notify.success(`${tasks.length}건을 완료했습니다.`);
    else notify.error(`${tasks.length - failed}건을 완료했고 ${failed}건은 처리하지 못했습니다. 다시 시도해 주세요.`);
  };
  const changeChecklist = async (task: Task, checklist: Checklist) => {
    const saved = await api.updateTask(organizationId, task.id, { checklist });
    setItems((current) => mergeTask(current, saved));
  };
  const deleteTask = async (task: Task) => {
    await api.deleteTask(organizationId, task.id);
    setItems((current) => current.filter((item) => item.id !== task.id));
    setSelectedId((current) => (current === task.id ? null : current));
  };

  /** 달력 드래그 이동. 화면에는 먼저 반영하고, 실패하면 원래 기한으로 되돌린다. */
  const moveTask = async (task: Task, key: DateKey | null) => {
    if (readOnly || dueDateKey(task.due_at) === key) return;
    const original = itemsRef.current.find((item) => item.id === task.id) ?? task;
    const nextDue = key ? moveDueToDate(original.due_at, key) : null;
    setItems((current) => mergeTask(current, { ...original, due_at: nextDue }));
    setError('');
    try {
      const saved = await api.updateTask(organizationId, task.id, { due_at: nextDue });
      setItems((current) => mergeTask(current, saved));
    } catch (failure) {
      setItems((current) => mergeTask(current, original));
      setError('기한을 변경하지 못해 원래 날짜로 되돌렸습니다.');
      throw failure;
    }
  };

  const filterDay = filters.range.from && filters.range.from === filters.range.to ? filters.range.from : null;
  return (
    <div className="tasks-page">
      <TaskList
        rows={rows}
        totalCount={items.length}
        loading={loading}
        error={error}
        filters={filters}
        todayKey={todayKey}
        selectedId={selectedId}
        readOnly={readOnly}
        onFiltersChange={setFilters}
        onSelect={(task) => void selectTask(task)}
        onNew={() => void startNew()}
        onRetry={() => void load()}
        onCompleteVisible={(tasks) => void completeVisible(tasks)}
        completing={completing}
      />
      <TaskDetail
        customers={customerOptions}
        task={selected}
        createKey={createKey}
        createDue={createDue}
        readOnly={readOnly}
        onCreate={createTask}
        onUpdate={updateTask}
        onStatus={changeStatus}
        onChecklist={changeChecklist}
        onDelete={deleteTask}
        onDirtyChange={onDirtyChange}
      />
      <TaskCalendar
        tasks={items}
        todayKey={todayKey}
        selectedId={selectedId}
        selectedDate={filterDay}
        readOnly={readOnly}
        onSelectTask={(task) => void selectTask(task)}
        onSelectDate={selectDate}
        onMove={moveTask}
      />
    </div>
  );
}
