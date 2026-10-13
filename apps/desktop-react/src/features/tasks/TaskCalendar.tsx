import { useMemo, useRef, useState, type DragEvent } from 'react';
import type { Task } from '../../api/schemas';
import { WEEKDAY_LABELS, addDays, addMonths, buildMonthGrid, buildWeek, formatMonthTitle, formatWeekTitle, startOfMonth, type CalendarCell, type DateKey } from './taskDates';
import { groupByDate } from './taskFilters';
import { PRIORITY_LABELS, STATUS_LABELS, priorityOf, statusOf } from './taskMeta';

export type CalendarView = 'month' | 'week';

export interface TaskCalendarProps {
  tasks: Task[];
  todayKey: DateKey;
  selectedId: string | null;
  /** 목록 필터가 특정 하루일 때 그 날짜(셀 강조용). */
  selectedDate: DateKey | null;
  readOnly: boolean;
  onSelectTask: (task: Task) => void;
  onSelectDate: (key: DateKey) => void;
  /** key가 null이면 기한 없음으로 옮긴다. 실패하면 reject. */
  onMove: (task: Task, key: DateKey | null) => Promise<void>;
}

const MAX_CHIPS: Record<CalendarView, number> = { month: 2, week: 7 };

interface ChipProps {
  task: Task;
  selected: boolean;
  draggable: boolean;
  onOpen: (task: Task) => void;
  onDragStart: (task: Task, event: DragEvent) => void;
  onDragEnd: () => void;
}

function TaskChip({ task, selected, draggable, onOpen, onDragStart, onDragEnd }: ChipProps) {
  const status = statusOf(task);
  const priority = priorityOf(task);
  return (
    <button
      type="button"
      className={`tasks-chip tasks-chip--${priority} tasks-chip--${status}${selected ? ' is-selected' : ''}`}
      title={`${task.title} · ${PRIORITY_LABELS[priority]} · ${STATUS_LABELS[status]}`}
      draggable={draggable}
      onClick={(event) => { event.stopPropagation(); onOpen(task); }}
      onDragStart={(event) => onDragStart(task, event)}
      onDragEnd={onDragEnd}
    >
      {task.title}
    </button>
  );
}

export function TaskCalendar({ tasks, todayKey, selectedId, selectedDate, readOnly, onSelectTask, onSelectDate, onMove }: TaskCalendarProps) {
  const [view, setView] = useState<CalendarView>('month');
  const [anchor, setAnchor] = useState<DateKey>(todayKey);
  const [dragOver, setDragOver] = useState<DateKey | 'undated' | null>(null);
  const dragging = useRef<Task | null>(null);
  const { byDate, undated } = useMemo(() => groupByDate(tasks), [tasks]);
  const cells = useMemo(() => (view === 'month' ? buildMonthGrid(anchor) : buildWeek(anchor)), [view, anchor]);
  const rows = useMemo(() => {
    const result: CalendarCell[][] = [];
    for (let index = 0; index < cells.length; index += 7) result.push(cells.slice(index, index + 7));
    return result;
  }, [cells]);
  const limit = MAX_CHIPS[view];

  const step = (direction: -1 | 1) => setAnchor((current) => (view === 'month' ? addMonths(startOfMonth(current), direction) : addDays(current, direction * 7)));
  const goToday = () => setAnchor(todayKey);

  const startDrag = (task: Task, event: DragEvent) => {
    dragging.current = task;
    event.dataTransfer?.setData('text/plain', task.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  };
  const endDrag = () => { dragging.current = null; setDragOver(null); };
  const allowDrop = (target: DateKey | 'undated') => (event: DragEvent) => {
    if (readOnly || !dragging.current) return;
    event.preventDefault();
    setDragOver(target);
  };
  const drop = (target: DateKey | 'undated') => (event: DragEvent) => {
    event.preventDefault();
    const task = dragging.current;
    endDrag();
    if (readOnly || !task) return;
    void onMove(task, target === 'undated' ? null : target).catch(() => undefined);
  };

  const chipFor = (task: Task) => (
    <TaskChip key={task.id} task={task} selected={task.id === selectedId} draggable={!readOnly} onOpen={onSelectTask} onDragStart={startDrag} onDragEnd={endDrag} />
  );

  return (
    <section className="tasks-panel tasks-calendar" aria-label="할 일 달력">
      <header className="tasks-panel__head">
        <h2>달력</h2>
        <div className="tasks-calendar__nav">
          <button type="button" aria-label="이전" onClick={() => step(-1)}>‹</button>
          <button type="button" onClick={goToday}>오늘</button>
          <button type="button" aria-label="다음" onClick={() => step(1)}>›</button>
          <strong className="tasks-calendar__title" aria-live="polite">{view === 'month' ? formatMonthTitle(anchor) : formatWeekTitle(anchor)}</strong>
        </div>
        <div className="tasks-calendar__views" role="group" aria-label="보기 전환">
          <button type="button" aria-pressed={view === 'month'} onClick={() => setView('month')}>월</button>
          <button type="button" aria-pressed={view === 'week'} onClick={() => setView('week')}>주</button>
        </div>
      </header>
      <div className="tasks-calendar__main">
        <div className="tasks-cal" role="grid" aria-label="할 일 달력 격자">
          <div className="tasks-cal__weekdays" role="row">
            {WEEKDAY_LABELS.map((label, index) => <div key={label} role="columnheader" className={index === 0 ? 'is-sunday' : index === 6 ? 'is-saturday' : undefined}>{label}</div>)}
          </div>
          <div className={`tasks-cal__body tasks-cal__body--${view}`}>
            {rows.map((row) => (
              <div key={row[0].key} className="tasks-cal__week" role="row">
                {row.map((cell) => {
                  const dayTasks = byDate.get(cell.key) ?? [];
                  const hidden = dayTasks.length - limit;
                  const classes = ['tasks-cal__cell'];
                  if (!cell.inMonth && view === 'month') classes.push('is-outside');
                  if (cell.key === todayKey) classes.push('is-today');
                  if (cell.key === selectedDate) classes.push('is-selected');
                  if (dragOver === cell.key) classes.push('is-over');
                  return (
                    <div
                      key={cell.key}
                      role="gridcell"
                      tabIndex={0}
                      aria-label={`${cell.key} 할 일 ${dayTasks.length}건`}
                      aria-selected={cell.key === selectedDate}
                      data-date={cell.key}
                      className={classes.join(' ')}
                      onClick={() => onSelectDate(cell.key)}
                      onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onSelectDate(cell.key); } }}
                      onDragOver={allowDrop(cell.key)}
                      onDragLeave={() => setDragOver((current) => (current === cell.key ? null : current))}
                      onDrop={drop(cell.key)}
                    >
                      <span className="tasks-cal__day">{cell.day}</span>
                      <div className="tasks-cal__chips">
                        {dayTasks.slice(0, limit).map(chipFor)}
                        {hidden > 0 && <button type="button" className="tasks-cal__more" onClick={(event) => { event.stopPropagation(); onSelectDate(cell.key); }}>+{hidden}개</button>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        <aside
          className={`tasks-undated${dragOver === 'undated' ? ' is-over' : ''}`}
          aria-label="기한 없음"
          onDragOver={allowDrop('undated')}
          onDragLeave={() => setDragOver((current) => (current === 'undated' ? null : current))}
          onDrop={drop('undated')}
        >
          <h3>기한 없음 <span className="tasks-muted">{undated.length}</span></h3>
          <div className="tasks-undated__chips">
            {undated.map(chipFor)}
            {undated.length === 0 && <p className="tasks-muted">기한 없는 할 일이 없습니다.</p>}
          </div>
        </aside>
      </div>
    </section>
  );
}
