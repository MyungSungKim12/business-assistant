import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../api/client';
import { AppointmentForm } from './AppointmentForm';

const ids = { org: '22222222-2222-4222-8222-222222222222', customer: '11111111-1111-4111-8111-111111111111', staff: '33333333-3333-4333-8333-333333333333', service: '44444444-4444-4444-8444-444444444444' };
const slot = (start: string, available: boolean, staff_ids: string[], blocked: unknown[] = []) => ({ start, start_at: `2026-12-14T${start}:00+09:00`, end_at: `2026-12-14T${start}:00+09:00`, available, staff_ids, blocked });
const availability = {
  date: '2026-12-14', service_id: ids.service, duration_minutes: 60, buffer_minutes: 10, step_minutes: 30,
  staff: [{ id: ids.staff, name: '김담당' }], required_resources: [], advisory: '안내',
  slots: [slot('09:00', true, [ids.staff]), slot('09:30', false, [], [{ code: 'staff_busy', staff_id: ids.staff }]), slot('10:00', true, [ids.staff])],
};

function renderForm(seed: Record<string, unknown> = {}) {
  const call = vi.fn(async (_method: string, path: string) => (path.includes('appointment-availability') ? availability : []));
  const api = { call, createAppointment: vi.fn() } as unknown as ApiClient;
  render(
    <AppointmentForm
      api={api} organizationId={ids.org} seed={seed}
      customers={[{ id: ids.customer, organization_id: ids.org, name: '김고객', status: 'active', tags: [], concerns: [], email: null, phone: null, notes: '', birth_date: null, skin_type: null, allergies: '', last_visit_date: null, next_visit_date: null }]}
      staff={[{ id: ids.staff, organization_id: ids.org, name: '김담당', is_active: true, schedule_version: 1 }]}
      services={[{ id: ids.service, organization_id: ids.org, name: '피부관리', duration_minutes: 60, buffer_minutes: 10, is_active: true, resource_version: 1 }]}
      customerName={() => '김고객'} staffName={() => '김담당'} onSaved={() => undefined} onDirtyChange={() => undefined}
    />,
  );
  return { call };
}

describe('AppointmentForm 가능 시간 칩', () => {
  it('서비스를 고르기 전에는 안내만 보이고 고른 뒤 가능 시간을 읽는다', async () => {
    const { call } = renderForm({ start_at: '2026-12-14T09:00' });
    expect(screen.getByText(/서비스를 고르면/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('서비스'), { target: { value: ids.service } });
    const group = await screen.findByRole('group', { name: '시작 시각 선택' });
    expect(within(group).getAllByRole('button')).toHaveLength(3);
    const path = call.mock.calls.map((entry) => entry[1]).find((value) => value.includes('appointment-availability'))!;
    expect(path).toContain(`service_id=${ids.service}`);
    expect(path).toContain('date=2026-12-14');
  });

  it('칩을 누르면 시작 시각이 채워지고 담당자가 비어 있으면 가능한 담당자로 채운다', async () => {
    renderForm({ start_at: '2026-12-14T09:00' });
    fireEvent.change(screen.getByLabelText('서비스'), { target: { value: ids.service } });
    const group = await screen.findByRole('group', { name: '시작 시각 선택' });
    fireEvent.click(within(group).getByRole('button', { name: '10:00 예약 가능' }));
    expect(screen.getByLabelText('시작 시각')).toHaveValue('2026-12-14T10:00');
    await waitFor(() => expect(screen.getByLabelText('담당자')).toHaveValue(ids.staff));
  });

  it('달력 빈 칸에서 들어온 시각(seed)이 불가이면 사유를 알려 준다', async () => {
    renderForm({ staff_id: ids.staff, start_at: '2026-12-14T09:30', service_id: ids.service });
    expect(await screen.findByRole('status')).toHaveTextContent('09:30 예약이 어려운 시각입니다: 김담당: 다른 예약이 있습니다');
  });
});
