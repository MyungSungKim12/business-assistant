import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../api/client';
import { AppointmentForm } from './AppointmentForm';

const ids = {
  org: '22222222-2222-4222-8222-222222222222', customer: '11111111-1111-4111-8111-111111111111',
  staffA: '33333333-3333-4333-8333-333333333333', staffB: '55555555-5555-4555-8555-555555555555',
  skin: '44444444-4444-4444-8444-444444444444', nail: '66666666-6666-4666-8666-666666666666',
};
const staff = [
  { id: ids.staffA, organization_id: ids.org, name: '김원장', is_active: true, schedule_version: 1 },
  { id: ids.staffB, organization_id: ids.org, name: '이실장', is_active: true, schedule_version: 1 },
];
const services = [
  { id: ids.skin, organization_id: ids.org, name: '피부관리', duration_minutes: 60, buffer_minutes: 10, is_active: true, resource_version: 1 },
  { id: ids.nail, organization_id: ids.org, name: '네일', duration_minutes: 30, buffer_minutes: 0, is_active: true, resource_version: 1 },
];
const customer = { id: ids.customer, organization_id: ids.org, name: '김고객', status: 'active', tags: [], concerns: [], email: null, phone: null, notes: '', birth_date: null, skin_type: null, allergies: '', last_visit_date: null, next_visit_date: null };
// 피부관리는 김원장만, 네일은 지정이 없어 모두 가능
const serviceStaff = { [ids.skin]: [ids.staffA] };

function renderForm(props: Record<string, unknown> = {}) {
  const createAppointment = vi.fn(async () => ({}));
  const api = { call: vi.fn(async () => []), createAppointment } as unknown as ApiClient;
  render(
    <AppointmentForm
      api={api} organizationId={ids.org} customers={[customer]} staff={staff} services={services} serviceStaff={serviceStaff}
      customerName={() => '김고객'} staffName={(id) => staff.find((row) => row.id === id)?.name ?? '?'} onSaved={() => undefined} onDirtyChange={() => undefined}
      {...props}
    />,
  );
  return { createAppointment };
}
const options = () => within(screen.getByLabelText('담당자')).getAllByRole('option').map((option) => option.textContent);

describe('AppointmentForm 서비스별 담당 가능 직원(SVC-11)', () => {
  it('서비스를 고르기 전에는 모든 직원이 보이고, 제한된 서비스를 고르면 지정된 직원만 보인다', () => {
    renderForm();
    expect(options()).toEqual(['선택', '김원장', '이실장']);
    fireEvent.change(screen.getByLabelText('서비스'), { target: { value: ids.skin } });
    expect(options()).toEqual(['선택', '김원장']);
    expect(screen.getByTestId('service-staff-hint')).toBeInTheDocument();
  });

  it('지정이 없는 서비스로 바꾸면 다시 모든 직원이 보이고 안내가 사라진다', () => {
    renderForm();
    fireEvent.change(screen.getByLabelText('서비스'), { target: { value: ids.skin } });
    fireEvent.change(screen.getByLabelText('서비스'), { target: { value: ids.nail } });
    expect(options()).toEqual(['선택', '김원장', '이실장']);
    expect(screen.queryByTestId('service-staff-hint')).not.toBeInTheDocument();
  });

  it('이미 고른 담당자가 새 서비스를 맡을 수 없으면 경고하고 저장하지 않는다', () => {
    const { createAppointment } = renderForm();
    fireEvent.change(screen.getByLabelText('고객'), { target: { value: ids.customer } });
    fireEvent.change(screen.getByLabelText('서비스'), { target: { value: ids.nail } });
    fireEvent.change(screen.getByLabelText('담당자'), { target: { value: ids.staffB } });
    fireEvent.change(screen.getByLabelText('시작 시각'), { target: { value: '2026-12-14T10:00' } });
    fireEvent.change(screen.getByLabelText('서비스'), { target: { value: ids.skin } });
    expect(screen.getByRole('alert')).toHaveTextContent('선택한 담당자는 이 서비스를 맡을 수 없습니다');
    fireEvent.submit(screen.getByRole('form', { name: '새 예약' }));
    expect(createAppointment).not.toHaveBeenCalled();
  });

  it('수정 중인 예약의 기존 담당자는 서비스·담당자를 바꾸지 않는 동안 그대로 둘 수 있다', () => {
    const appointment = {
      id: '77777777-7777-4777-8777-777777777777', organization_id: ids.org, customer_id: ids.customer, staff_id: ids.staffB, service_id: ids.skin, service_name_snapshot: '피부관리',
      duration_minutes: 60, buffer_minutes: 10, start_at: '2026-12-14T10:00:00+09:00', end_at: '2026-12-14T11:10:00+09:00', status: 'reserved', source: 'phone', cancellation_reason: null, version: 1, resource_ids: [],
    };
    renderForm({ appointment });
    expect(options()).toEqual(['선택', '김원장', '이실장']);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // 서비스를 바꿨다 되돌리지 않고 다른 서비스로 바꾸면 규칙을 따른다.
    fireEvent.change(screen.getByLabelText('서비스'), { target: { value: ids.nail } });
    expect(options()).toEqual(['선택', '김원장', '이실장']);
  });
});
