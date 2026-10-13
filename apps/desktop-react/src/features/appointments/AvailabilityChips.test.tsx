import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../api/client';
import { AvailabilityChips } from './AvailabilityChips';
import type { Availability, AvailabilitySlot } from './availability';

const slot = (start: string, available: boolean, blocked: AvailabilitySlot['blocked'] = [], staff_ids: string[] = []): AvailabilitySlot => ({
  start, start_at: `2026-12-14T${start}:00+09:00`, end_at: `2026-12-14T${start}:00+09:00`, available, staff_ids, blocked,
});
const data: Availability = {
  date: '2026-12-14', service_id: 'svc', duration_minutes: 60, buffer_minutes: 0, step_minutes: 30,
  staff: [{ id: 's1', name: '김담당' }], required_resources: [], advisory: '안내',
  slots: [slot('08:30', false, [{ code: 'outside_hours', staff_id: 's1' }]), slot('09:00', true, [], ['s1']), slot('09:30', false, [{ code: 'staff_busy', staff_id: 's1' }]), slot('10:00', true, [], ['s1'])],
};
const api = (result: unknown = data) => ({ call: vi.fn(async () => result) }) as unknown as ApiClient;
const query = { serviceId: 'svc', date: '2026-12-14' };

describe('AvailabilityChips', () => {
  it('asks for a service first', () => {
    render(<AvailabilityChips api={api()} organizationId="org" query={null} startAt="" onPick={() => undefined} />);
    expect(screen.getByText(/서비스를 고르면/)).toBeInTheDocument();
  });

  it('shows available chips, dims blocked ones with a reason tooltip, and hides out-of-hours times', async () => {
    render(<AvailabilityChips api={api()} organizationId="org" query={query} startAt="" onPick={() => undefined} />);
    const group = await screen.findByRole('group', { name: '시작 시각 선택' });
    expect(within(group).getAllByRole('button').map((button) => button.textContent)).toEqual(['09:00', '09:30', '10:00']);
    const blocked = within(group).getByRole('button', { name: '09:30 예약 불가' });
    expect(blocked).toHaveAttribute('aria-disabled', 'true');
    expect(blocked).toHaveAttribute('title', '김담당: 다른 예약이 있습니다');
    expect(within(group).getByRole('button', { name: '10:00 예약 가능' })).toHaveAttribute('title', '예약 가능');
  });

  it('reports the picked time with the staff who can take it and ignores blocked chips', async () => {
    const onPick = vi.fn();
    render(<AvailabilityChips api={api()} organizationId="org" query={query} startAt="" onPick={onPick} />);
    const group = await screen.findByRole('group', { name: '시작 시각 선택' });
    fireEvent.click(within(group).getByRole('button', { name: '09:30 예약 불가' }));
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(within(group).getByRole('button', { name: '10:00 예약 가능' }));
    expect(onPick).toHaveBeenCalledWith('10:00', ['s1']);
  });

  it('marks the selected time and tells whether the chosen start (for example from a calendar cell) is possible', async () => {
    const client = api();
    const { rerender } = render(<AvailabilityChips api={client} organizationId="org" query={query} startAt="2026-12-14T10:00" onPick={() => undefined} />);
    expect(await screen.findByRole('status')).toHaveTextContent('10:00 예약 가능한 시각입니다.');
    expect(screen.getByRole('button', { name: '10:00 예약 가능' })).toHaveAttribute('aria-pressed', 'true');
    rerender(<AvailabilityChips api={client} organizationId="org" query={query} startAt="2026-12-14T09:30" onPick={() => undefined} />);
    expect(screen.getByRole('status')).toHaveTextContent('예약이 어려운 시각입니다: 김담당: 다른 예약이 있습니다');
  });

  it('explains an empty day and a failed lookup without blocking the form', async () => {
    const empty = { ...data, slots: [slot('08:30', false, [{ code: 'outside_hours', staff_id: 's1' }])] };
    const { unmount } = render(<AvailabilityChips api={api(empty)} organizationId="org" query={query} startAt="" onPick={() => undefined} />);
    expect(await screen.findByText(/예약 가능한 시간이 없습니다/)).toBeInTheDocument();
    unmount();
    const failing = { call: vi.fn(async () => { throw new Error('boom'); }) } as unknown as ApiClient;
    render(<AvailabilityChips api={failing} organizationId="org" query={query} startAt="" onPick={() => undefined} />);
    await waitFor(() => expect(screen.getByText(/가능 시간을 불러오지 못했습니다/)).toBeInTheDocument());
  });

  it('stays quiet when the server does not support availability yet', async () => {
    render(<AvailabilityChips api={api([])} organizationId="org" query={query} startAt="" onPick={() => undefined} />);
    await waitFor(() => expect(screen.queryByText(/확인하는 중/)).not.toBeInTheDocument());
    expect(screen.queryByRole('group', { name: '시작 시각 선택' })).not.toBeInTheDocument();
  });
});
