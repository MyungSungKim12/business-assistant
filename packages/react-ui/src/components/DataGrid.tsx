import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { loadWidths, saveWidths } from './gridWidths';
import { notify } from './notices';

export interface Column<T> {
  key: string;
  header: string;
  width?: number;
  minWidth?: number;
  sortable?: boolean;
  value: (row: T) => unknown;
  render?: (row: T) => ReactNode;
  title?: (row: T) => string | undefined;
}

export interface SortState { key: string; direction: 'asc' | 'desc' }

export interface DataGridProps<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  selectedKey?: string | null;
  onSelect?: (row: T) => void;
  onActivate?: (row: T) => void;
  loading?: boolean;
  emptyText?: string;
  storageKey?: string;
  ariaLabel: string;
  className?: string;
  /** 첫 열에 순번(No)을 표시한다. */
  numbered?: boolean;
}

function compareValues(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left ?? '').localeCompare(String(right ?? ''), 'ko', { numeric: true, sensitivity: 'base' });
}

export function DataGrid<T>({ rows, columns, rowKey, selectedKey, onSelect, onActivate, loading = false, emptyText = '자료가 없습니다.', storageKey, ariaLabel, className, numbered = false }: DataGridProps<T>) {
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const [activeColumn, setActiveColumn] = useState(0);
  const [sort, setSort] = useState<SortState | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>(() => loadWidths(storageKey));
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((item) => item.key === sort.key);
    if (!column) return rows;
    const factor = sort.direction === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => compareValues(column.value(a), column.value(b)) * factor);
  }, [columns, rows, sort]);

  const chooseSort = (column: Column<T>) => {
    if (column.sortable === false) return;
    setSort((current) => current?.key === column.key ? { key: column.key, direction: current.direction === 'asc' ? 'desc' : 'asc' } : { key: column.key, direction: 'asc' });
  };
  const resize = (column: Column<T>, startX: number) => {
    const startWidth = widths[column.key] ?? column.width ?? 120;
    const move = (event: PointerEvent) => {
      const next = Math.max(column.minWidth ?? 40, startWidth + event.clientX - startX);
      setWidths((current) => ({ ...current, [column.key]: next }));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setWidths((current) => { saveWidths(storageKey, current); return current; });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const focusRow = (index: number) => requestAnimationFrame(() => bodyRef.current?.querySelectorAll<HTMLElement>('tr')[index]?.focus());
  const copyActive = (row: T) => {
    const text = String(columns[activeColumn]?.value(row) ?? '');
    void navigator.clipboard?.writeText(text).then(() => notify.info('셀 값을 복사했습니다.'), () => undefined);
  };
  const rowKeydown = (event: KeyboardEvent<HTMLTableRowElement>, row: T, index: number) => {
    if (event.key === 'Enter') { event.preventDefault(); onActivate?.(row); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') { event.preventDefault(); copyActive(row); return; }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      setActiveColumn((current) => Math.min(columns.length - 1, Math.max(0, current + (event.key === 'ArrowRight' ? 1 : -1))));
      return;
    }
    const jump: Record<string, number> = { ArrowDown: index + 1, ArrowUp: index - 1, PageDown: index + 10, PageUp: index - 10, Home: 0, End: sorted.length - 1 };
    if (!(event.key in jump)) return;
    event.preventDefault();
    const target = Math.min(sorted.length - 1, Math.max(0, jump[event.key]));
    const next = sorted[target];
    if (next) { onSelect?.(next); focusRow(target); }
  };

  if (loading) return <div className="ba-grid-state" role="status">불러오는 중…</div>;
  if (rows.length === 0) return <div className="ba-grid-state">{emptyText}</div>;
  return (
    <div className={`ba-grid-wrap ${className ?? ''}`}>
      <table className="ba-grid" role="grid" aria-label={ariaLabel}>
        <thead>
          <tr role="row">
            {numbered && <th role="columnheader" className="ba-grid__no" style={{ width: 40 }}>No</th>}
            {columns.map((column) => {
              const width = widths[column.key] ?? column.width ?? 120;
              return (
                <th key={column.key} role="columnheader" aria-sort={sort?.key === column.key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'} style={{ width }}>
                  <button type="button" className="ba-grid__sort" aria-label={`${column.header} 정렬`} onClick={() => chooseSort(column)} disabled={column.sortable === false}>{column.header}</button>
                  <span role="separator" aria-label={`${column.header} 열 너비 조절`} className="ba-grid__resize" onPointerDown={(event) => resize(column, event.clientX)} onDoubleClick={() => setWidths((current) => { const { [column.key]: _removed, ...rest } = current; saveWidths(storageKey, rest); return rest; })} />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody ref={bodyRef}>
          {sorted.map((row, index) => {
            const key = rowKey(row);
            return (
              <tr key={key} role="row" tabIndex={selectedKey === key || (!selectedKey && index === 0) ? 0 : -1} aria-selected={selectedKey === key} onClick={() => onSelect?.(row)} onDoubleClick={() => onActivate?.(row)} onKeyDown={(event) => rowKeydown(event, row, index)}>
                {numbered && <td role="gridcell" className="ba-grid__no">{index + 1}</td>}
                {columns.map((column) => {
                  const value = column.value(row);
                  const text = value == null ? '' : String(value);
                  return <td key={column.key} role="gridcell" aria-label={text} className={selectedKey === key && columns[activeColumn]?.key === column.key ? "is-active" : undefined} title={column.title?.(row)} onClick={() => setActiveColumn(columns.indexOf(column))}>{column.render ? column.render(row) : text}</td>;
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
