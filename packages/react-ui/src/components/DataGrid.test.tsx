import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DataGrid, type Column } from './DataGrid';
import { loadWidths, saveWidths } from './gridWidths';

interface Row { id: string; name: string; visits: number }
const rows: Row[] = [
  { id: '2', name: '이진은', visits: 2 },
  { id: '1', name: '김민지', visits: 8 },
];
const columns: Column<Row>[] = [
  { key: 'name', header: '이름', width: 140, value: (row) => row.name },
  { key: 'visits', header: '방문', width: 80, value: (row) => row.visits },
];

describe('DataGrid', () => {
  beforeEach(() => localStorage.clear());

  it('sorts rows from a column header', async () => {
    const user = userEvent.setup();
    render(<DataGrid ariaLabel="고객 목록" rows={rows} columns={columns} rowKey={(row) => row.id} />);

    await user.click(screen.getByRole('button', { name: '이름 정렬' }));
    const dataRows = screen.getAllByRole('row').slice(1);
    expect(within(dataRows[0]).getByText('김민지')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '이름 정렬' }));
    expect(within(screen.getAllByRole('row')[1]).getByText('이진은')).toBeInTheDocument();
  });

  it('selects with pointer and keyboard and activates with Enter or double click', async () => {
    const user = userEvent.setup();
    const select = vi.fn();
    const activate = vi.fn();
    render(<DataGrid ariaLabel="고객 목록" rows={rows} columns={columns} rowKey={(row) => row.id} selectedKey="2" onSelect={select} onActivate={activate} />);

    const first = screen.getAllByRole('row')[1];
    first.focus();
    await user.keyboard('{ArrowDown}');
    expect(select).toHaveBeenLastCalledWith(rows[1]);
    await waitFor(() => expect(screen.getAllByRole('row')[2]).toHaveFocus());
    await user.keyboard('{Enter}');
    expect(activate).toHaveBeenCalledWith(rows[1]);
    await user.dblClick(screen.getAllByRole('row')[2]);
    expect(activate).toHaveBeenLastCalledWith(rows[1]);
  });

  it('copies a focused cell with Ctrl+C', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<DataGrid ariaLabel="고객 목록" rows={rows} columns={columns} rowKey={(row) => row.id} />);

    const cell = screen.getByRole('gridcell', { name: '이진은' });
    fireEvent.keyDown(cell, { key: 'c', ctrlKey: true });
    expect(writeText).toHaveBeenCalledWith('이진은');
  });

  it('stores resized widths and recovers from corrupt storage', () => {
    saveWidths('customers', { name: 220 });
    expect(loadWidths('customers')).toEqual({ name: 220 });
    localStorage.setItem('ba-grid:broken', '{');
    expect(loadWidths('broken')).toEqual({});

    render(<DataGrid ariaLabel="고객 목록" rows={rows} columns={columns} rowKey={(row) => row.id} storageKey="customers" />);
    const handle = screen.getByLabelText('이름 열 너비 조절');
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 140, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(loadWidths('customers').name).toBe(260);
  });

  it('shows explicit loading and empty states', () => {
    const { rerender } = render(<DataGrid ariaLabel="고객 목록" rows={[]} columns={columns} rowKey={(row) => row.id} loading emptyText="고객이 없습니다." />);
    expect(screen.getByRole('status')).toHaveTextContent('불러오는 중');
    rerender(<DataGrid ariaLabel="고객 목록" rows={[]} columns={columns} rowKey={(row) => row.id} emptyText="고객이 없습니다." />);
    expect(screen.getByText('고객이 없습니다.')).toBeInTheDocument();
  });
});
