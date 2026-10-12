import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';

import { loadWidths, saveWidths } from './gridWidths';

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
}

function compareValues(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left ?? '').localeCompare(String(right ?? ''), 'ko', { numeric: true, sensitivity: 'base' });
}

export function DataGrid<T>({ rows, columns, rowKey, selectedKey, onSelect, onActivate, loading = false, emptyText = '자료가 없습니다.', storageKey, ariaLabel, className }: DataGridProps<T>) {
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
  const rowKeydown = (event: KeyboardEvent<HTMLTableRowElement>, row: T, index: number) => {
    if (event.key === 'Enter') { event.preventDefault(); onActivate?.(row); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const next = sorted[index + (event.key === 'ArrowDown' ? 1 : -1)];
    if (next) onSelect?.(next);
  };

  if (loading) return <div className="ba-grid-state" role="status">불러오는 중…</div>;
  if (rows.length === 0) return <div className="ba-grid-state">{emptyText}</div>;
  return (
    <div className={`ba-grid-wrap ${className ?? ''}`}>
      <table className="ba-grid" role="grid" aria-label={ariaLabel}>
        <thead>
          <tr role="row">
            {columns.map((column) => {
              const width = widths[column.key] ?? column.width ?? 120;
              return (
                <th key={column.key} role="columnheader" aria-sort={sort?.key === column.key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'} style={{ width }}>
                  <button type="button" className="ba-grid__sort" aria-label={`${column.header} 정렬`} onClick={() => chooseSort(column)} disabled={column.sortable === false}>{column.header}</button>
                  <span role="separator" aria-label={`${column.header} 열 너비 조절`} className="ba-grid__resize" onPointerDown={(event) => resize(column, event.clientX)} />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, index) => {
            const key = rowKey(row);
            return (
              <tr key={key} role="row" tabIndex={selectedKey === key || (!selectedKey && index === 0) ? 0 : -1} aria-selected={selectedKey === key} onClick={() => onSelect?.(row)} onDoubleClick={() => onActivate?.(row)} onKeyDown={(event) => rowKeydown(event, row, index)}>
                {columns.map((column) => {
                  const value = column.value(row);
                  const text = value == null ? '' : String(value);
                  return <td key={column.key} role="gridcell" tabIndex={-1} aria-label={text} title={column.title?.(row)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') void navigator.clipboard?.writeText(text); }}>{column.render ? column.render(row) : text}</td>;
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
