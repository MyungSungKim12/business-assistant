import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfirmDialog } from '@business-assistant/react-ui';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../api/client';
import { AppointmentPage } from './AppointmentPage';

const ids = { org: '22222222-2222-4222-8222-222222222222', customer: '11111111-1111-4111-8111-111111111111', staff: '33333333-3333-4333-8333-333333333333', service: '44444444-4444-4444-8444-444444444444', appointment: '55555555-5555-4555-8555-555555555555' };
const today = new Date().toLocaleDateString('sv-SE');
const appointment = { id: ids.appointment, organization_id: ids.org, customer_id: ids.customer, staff_id: ids.staff, service_id: ids.service, service_name_snapshot: '피부관리', duration_minutes: 60, buffer_minutes: 10, start_at: `${today}T10:00:00+09:00`, end_at: `${today}T11:00:00+09:00`, status: 'reserved', source: 'manual', cancellation_reason: null, version: 2, resource_ids: [] };

function client(overrides: Record<string, unknown> = {}) {
  return {
    listAppointments: vi.fn(async () => [appointment]),
    listAppointmentStaff: vi.fn(async () => [{ id: ids.staff, organization_id: ids.org, name: '김담당', is_active: true, schedule_version: 1 }]),
    listAppointmentServices: vi.fn(async () => [{ id: ids.service, organization_id: ids.org, name: '피부관리', duration_minutes: 60, buffer_minutes: 10, is_active: true, resource_version: 1 }]),
    listCustomers: vi.fn(async () => [{ id: ids.customer, organization_id: ids.org, name: '김고객', status: 'active', tags: [], concerns: [], email: null, phone: null, notes: '', birth_date: null, skin_type: null, allergies: '', last_visit_date: null, next_visit_date: null }]),
    transitionAppointment: vi.fn(async (_o: string, _id: string, input: { target_status: string }) => ({ ...appointment, status: input.target_status, version: 3 })),
    createAppointment: vi.fn(),
    call: vi.fn(async () => []),
    ...overrides,
  } as unknown as ApiClient;
}

describe('AppointmentPage', () => {
  it('lists the day, confirms a reservation and requires a reason to cancel', async () => {
    const api = client();
    render(<><AppointmentPage api={api} organizationId={ids.org} readOnly={false} /><ConfirmDialog /></>);
    expect(await screen.findByText('피부관리')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '확정' }));
    await waitFor(() => expect(api.transitionAppointment).toHaveBeenCalledWith(ids.org, ids.appointment, expect.objectContaining({ target_status: 'confirmed', expected_version: 2 })));
    fireEvent.click(await screen.findByRole('button', { name: '취소' }));
    const submit = screen.getByRole('button', { name: '예약 취소' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('취소 사유 (필수)'), { target: { value: '고객 요청' } });
    fireEvent.click(submit);
    await waitFor(() => expect(api.transitionAppointment).toHaveBeenLastCalledWith(ids.org, ids.appointment, expect.objectContaining({ target_status: 'canceled', reason: '고객 요청' })));
  });

  it('shows resource management only to managers and hides the form when read only', async () => {
    const view = render(<AppointmentPage api={client()} organizationId={ids.org} readOnly={false} canManageResources />);
    expect(await screen.findByRole('button', { name: '공간·장비 관리' })).toBeInTheDocument();
    view.unmount();
    render(<AppointmentPage api={client()} organizationId={ids.org} readOnly canManageResources={false} />);
    await screen.findByText('피부관리');
    expect(screen.queryByRole('button', { name: '공간·장비 관리' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '예약 저장' })).not.toBeInTheDocument();
  });

  it('explains a scheduling conflict and keeps the input', async () => {
    const createAppointment = vi.fn(async () => { throw Object.assign(new Error('conflict'), { status: 409 }); });
    render(<AppointmentPage api={client({ createAppointment })} organizationId={ids.org} readOnly={false} />);
    await screen.findByText('피부관리');
    fireEvent.change(screen.getByLabelText('고객'), { target: { value: ids.customer } });
    fireEvent.change(screen.getByLabelText('담당자'), { target: { value: ids.staff } });
    fireEvent.change(screen.getByLabelText('서비스'), { target: { value: ids.service } });
    fireEvent.change(screen.getByLabelText('시작 시각'), { target: { value: `${today}T14:00` } });
    fireEvent.click(screen.getByRole('button', { name: '예약 저장' }));
    expect(await screen.findByText(/이미 사용 중이거나 근무 시간이 아닙니다/)).toBeInTheDocument();
    expect(screen.getByLabelText('시작 시각')).toHaveValue(`${today}T14:00`);
    expect(createAppointment).toHaveBeenCalledWith(ids.org, expect.objectContaining({ resource_ids: [], expected_version: null }));
  });
});
