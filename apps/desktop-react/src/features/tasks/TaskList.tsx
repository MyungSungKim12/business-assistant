import { useMemo } from 'react';
import { DataGrid, DateRangeField, Select, type Column } from '@business-assistant/react-ui';
import type { Task } from '../../api/schemas';
import { formatDue, rangeForPreset, type DateKey, type RangePreset } from './taskDates';
import { PRIORITY_LABELS, STATUS_LABELS, priorityOf, statusOf } from './taskMeta';
import type { TaskFilters } from './taskFilters';

const STATUS_OPTIONS = [{ value: 'all' as const, label: '상태 전체' }, ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value: value as keyof typeof STATUS_LABELS, label }))];
const PRIORITY_OPTIONS = [{ value: 'all' as const, label: '우선순위 전체' }, ...Object.entries(PRIORITY_LABELS).map(([value, label]) => ({ value: value as keyof typeof PRIORITY_LABELS, label }))];
const PRESETS: { id: RangePreset; label: string }[] = [
  { id: 'today', label: '오늘' },
  { id: 'week', label: '이번 주' },
  { id: 'month', label: '이번 달' },
  { id: 'all', label: '전체' },
];

export interface TaskListProps {
  rows: Task[];
  totalCount: number;
  loading: boolean;
  error: string;
  filters: TaskFilters;
  todayKey: DateKey;
  selectedId: string | null;
  readOnly: boolean;
  onFiltersChange: (filters: TaskFilters) => void;
  onSelect: (task: Task) => void;
  onNew: () => void;
  onRetry: () => void;
}

const columns: Column<Task>[] = [
  { key: 'title', header: '제목', width: 220, minWidth: 100, value: (task) => task.title },
  { key: 'due_at', header: '기한', width: 130, minWidth: 90, value: (task) => task.due_at ?? '', render: (task) => formatDue(task.due_at), title: (task) => formatDue(task.due_at) },
  { key: 'priority', header: '우선순위', width: 80, minWidth: 60, value: (task) => PRIORITY_LABELS[priorityOf(task)], render: (task) => <span className={`tasks-priority tasks-priority--${priorityOf(task)}`}>{PRIORITY_LABELS[priorityOf(task)]}</span> },
  { key: 'status', header: '상태', width: 70, minWidth: 60, value: (task) => STATUS_LABELS[statusOf(task)], render: (task) => <span className={`tasks-status tasks-status--${statusOf(task)}`}>{STATUS_LABELS[statusOf(task)]}</span> },
];

export function TaskList({ rows, totalCount, loading, error, filters, todayKey, selectedId, readOnly, onFiltersChange, onSelect, onNew, onRetry }: TaskListProps) {
  const patch = (next: Partial<TaskFilters>) => onFiltersChange({ ...filters, ...next });
  const filtered = useMemo(() => filters.query !== '' || filters.status !== 'all' || filters.priority !== 'all' || filters.range.from !== null || filters.range.to !== null, [filters]);
  return (
    <section className="tasks-panel tasks-list" aria-label="할 일 목록">
      <header className="tasks-panel__head">
        <h2>할 일 목록</h2>
        {!readOnly && <button type="button" className="ba-primary" onClick={onNew}>새 할 일</button>}
      </header>
      <div className="tasks-filters">
        <input type="search" aria-label="할 일 검색" placeholder="제목·설명 검색" value={filters.query} onChange={(event) => patch({ query: event.currentTarget.value })} />
        <Select aria-label="상태 필터" options={STATUS_OPTIONS} value={filters.status} onChange={(status) => patch({ status })} />
        <Select aria-label="우선순위 필터" options={PRIORITY_OPTIONS} value={filters.priority} onChange={(priority) => patch({ priority })} />
      </div>
      <div className="tasks-filters">
        <span className="tasks-filters__label">기한</span>
        <DateRangeField value={filters.range} onChange={(range) => patch({ range })} />
        <div className="tasks-presets" role="group" aria-label="기한 빠른 선택">
          {PRESETS.map((preset) => <button key={preset.id} type="button" onClick={() => patch({ range: rangeForPreset(preset.id, todayKey) })}>{preset.label}</button>)}
        </div>
      </div>
      <div className="tasks-grid-slot">
        <div className="tasks-grid-slot__inner">
          <DataGrid
            ariaLabel="할 일 목록"
            rows={rows}
            columns={columns}
            rowKey={(task) => task.id}
            selectedKey={selectedId}
            onSelect={onSelect}
            loading={loading}
            emptyText={error ? '목록을 불러오지 못했습니다.' : filtered && totalCount > 0 ? '조건에 맞는 할 일이 없습니다.' : '등록된 할 일이 없습니다.'}
            storageKey="tasks-grid"
          />
        </div>
      </div>
      <footer className="tasks-panel__foot">
        {error ? <span role="alert" className="tasks-error">{error} <button type="button" onClick={onRetry}>다시 시도</button></span> : <span>{filtered ? `${rows.length} / ${totalCount}건` : `${totalCount}건`}</span>}
      </footer>
    </section>
  );
}
