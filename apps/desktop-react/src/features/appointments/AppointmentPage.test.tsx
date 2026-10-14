import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConfirmDialog } from '@business-assistant/react-ui';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../api/client';
import { AppointmentPage } from './AppointmentPage';
import { addDays, todayKstKey } from './appointmentTime';

const ids = { org: '22222222-2222-4222-8222-222222222222', customer: '11111111-1111-4111-8111-111111111111', staff: '33333333-3333-4333-8333-333333333333', service: '44444444-4444-4444-8444-444444444444', appointment: '55555555-5555-4555-8555-555555555555' };
const today = todayKstKey();
const appointment = { id: ids.appointment, organization_id: ids.org, customer_id: ids.customer, staff_id: ids.staff, service_id: ids.service, service_name_snapshot: '피부관리', duration_minutes: 60, buffer_minutes: 10, start_at: `${today}T10:00:00+09:00`, end_at: `${today}T11:00:00+09:00`, status: 'reserved', source: 'manual', cancellation_reason: null, version: 2, memo: '', resource_ids: [] };

type Handler = (method: string, path: string, schema: unknown, body?: unknown) => Promise<unknown>;

function client(overrides: Record<string, unknown> = {}, rows: unknown[] = [appointment], handler?: Handler) {
  return {
    listAppointments: vi.fn(async () => rows),
    listAppointmentStaff: vi.fn(async () => [{ id: ids.staff, organization_id: ids.org, name: '김담당', is_active: true, schedule_version: 1 }]),
    listAppointmentServices: vi.fn(async () => [{ id: ids.service, organization_id: ids.org, name: '피부관리', duration_minutes: 60, buffer_minutes: 10, is_active: true, resource_version: 1 }]),
    listCustomers: vi.fn(async () => [{ id: ids.customer, organization_id: ids.org, name: '김고객', status: 'active', tags: [], concerns: [], email: null, phone: null, notes: '', birth_date: null, skin_type: null, allergies: '', last_visit_date: null, next_visit_date: null }]),
    transitionAppointment: vi.fn(async (_o: string, _id: string, input: { target_status: string }) => ({ ...appointment, status: input.target_status, version: 3 })),
    createAppointment: vi.fn(),
    call: vi.fn(async (method: string, path: string, schema: unknown, body?: unknown) => (handler ? handler(method, path, schema, body) : [])),
    ...overrides,
  } as unknown as ApiClient;
}

const renderPage = (api: ApiClient, props: { readOnly?: boolean; canManageResources?: boolean } = {}) =>
  render(<><AppointmentPage api={api} organizationId={ids.org} readOnly={props.readOnly ?? false} canManageResources={props.canManageResources} /><ConfirmDialog /></>);

const block = () => screen.findByRole('button', { name: /^10:00 김고객/ });
const putCalls = (api: ApiClient) => (api.call as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((call) => call[0] === 'PUT');

describe('AppointmentPage 보기 전환', () => {
  it('기본은 일 보기이고 담당자 열에 예약 블록을 그린다', async () => {
    renderPage(client());
    const region = screen.getByRole('region', { name: '일 보기 달력' });
    expect(await within(region).findByText('피부관리')).toBeInTheDocument();
    expect(within(region).getByText('김담당')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '일' })).toHaveAttribute('aria-pressed', 'true');
    expect(await block()).toHaveAttribute('data-status', 'reserved');
  });

  it('일·주·목록으로 전환한다', async () => {
    renderPage(client());
    await block();
    fireEvent.click(screen.getByRole('button', { name: '주' }));
    const week = screen.getByRole('region', { name: '주 보기 달력' });
    expect(within(week).getAllByRole('group').length).toBe(7);
    expect(within(week).getByText('김고객 · 김담')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '목록' }));
    expect(screen.queryByRole('region', { name: '주 보기 달력' })).not.toBeInTheDocument();
    expect(screen.getByText('피부관리')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '일' }));
    expect(screen.getByRole('region', { name: '일 보기 달력' })).toBeInTheDocument();
  });

  it('이전·다음으로 날짜를 옮기고 기본 범위 밖이면 기간을 지정해 읽는다', async () => {
    const api = client();
    renderPage(api);
    fireEvent.click(screen.getByRole('button', { name: '다음 일' }));
    expect(screen.getByLabelText('예약 날짜')).toHaveValue(addDays(today, 1));
    fireEvent.click(screen.getByRole('button', { name: '이전 일' }));
    fireEvent.click(screen.getByRole('button', { name: '이전 일' }));
    expect(screen.getByLabelText('예약 날짜')).toHaveValue(addDays(today, -1));
    fireEvent.click(screen.getByRole('button', { name: '오늘' }));
    expect(screen.getByLabelText('예약 날짜')).toHaveValue(today);
    fireEvent.click(screen.getByRole('button', { name: '주' }));
    fireEvent.click(screen.getByRole('button', { name: '다음 주' }));
    expect(screen.getByLabelText('예약 날짜')).toHaveValue(addDays(today, 7));
    fireEvent.click(screen.getByRole('button', { name: '일' }));
    fireEvent.change(screen.getByLabelText('예약 날짜'), { target: { value: '2031-01-15' } });
    await waitFor(() => expect(api.call).toHaveBeenCalledWith('GET', `/organizations/${ids.org}/appointments?from_date=2031-01-15&to_date=2031-01-15`, expect.anything()));
  });

  it('예약이 0건이어도 달력 틀과 안내를 유지한다', async () => {
    const api = client({}, []);
    renderPage(api);
    expect(await screen.findByRole('region', { name: '일 보기 달력' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '일 보기 달력' })).getByText('김담당')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '김담당 09:00 빈 시간' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '목록' }));
    expect(screen.getByText('이 날짜에 예약이 없습니다.')).toBeInTheDocument();
  });
});

describe('AppointmentPage 목록 보기', () => {
  it('날짜 예약을 보여 주고 확정하며 취소에는 사유가 필요하다', async () => {
    const api = client();
    renderPage(api);
    fireEvent.click(screen.getByRole('button', { name: '목록' }));
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
});

describe('AppointmentPage 상세·상태 처리', () => {
  it('블록을 누르면 상세가 열리고 예약 상태에서는 확정·노쇼·취소·수정 버튼이 있다', async () => {
    renderPage(client());
    fireEvent.click(await block());
    const detail = await screen.findByRole('region', { name: '예약 상세' });
    expect(within(detail).getByText('김고객')).toBeInTheDocument();
    expect(within(detail).getByText('김담당')).toBeInTheDocument();
    expect(within(detail).getByText(/소요 60분 \+ 여유 10분/)).toBeInTheDocument();
    for (const name of ['확정', '노쇼', '취소', '예약 수정']) expect(within(detail).getByRole('button', { name })).toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: '완료' })).not.toBeInTheDocument();
  });

  it('완료·노쇼 예약은 상태 버튼과 수정 버튼을 숨긴다', async () => {
    const rows = [{ ...appointment, status: 'completed' }];
    renderPage(client({}, rows));
    fireEvent.click(await block());
    const detail = await screen.findByRole('region', { name: '예약 상세' });
    expect(within(detail).queryByRole('button', { name: '예약 수정' })).not.toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: '취소' })).not.toBeInTheDocument();
    expect(within(detail).getByText('완료')).toBeInTheDocument();
  });

  it('방문 상태에서는 완료만 있고 완료 처리는 확인을 거친다', async () => {
    const api = client({}, [{ ...appointment, status: 'checked_in' }]);
    renderPage(api);
    fireEvent.click(await block());
    const detail = await screen.findByRole('region', { name: '예약 상세' });
    expect(within(detail).queryByRole('button', { name: '노쇼' })).not.toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: '예약 수정' })).not.toBeInTheDocument();
    fireEvent.click(within(detail).getByRole('button', { name: '완료' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '완료' }));
    await waitFor(() => expect(api.transitionAppointment).toHaveBeenCalledWith(ids.org, ids.appointment, expect.objectContaining({ target_status: 'completed' })));
  });

  it('노쇼 처리에는 사유가 필수다', async () => {
    const api = client();
    renderPage(api);
    fireEvent.click(await block());
    fireEvent.click(within(await screen.findByRole('region', { name: '예약 상세' })).getByRole('button', { name: '노쇼' }));
    const submit = screen.getByRole('button', { name: '노쇼 처리' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('노쇼 사유 (필수)'), { target: { value: '연락 두절' } });
    fireEvent.click(submit);
    await waitFor(() => expect(api.transitionAppointment).toHaveBeenCalledWith(ids.org, ids.appointment, expect.objectContaining({ target_status: 'no_show', reason: '연락 두절', expected_version: 2 })));
    expect(await screen.findByText('노쇼')).toBeInTheDocument();
  });

  it('상태 변경이 409로 거절되면 한국어로 알리고 다시 불러온다', async () => {
    const transitionAppointment = vi.fn(async () => { throw Object.assign(new Error('conflict'), { status: 409 }); });
    const api = client({ transitionAppointment });
    renderPage(api);
    fireEvent.click(await block());
    fireEvent.click(within(await screen.findByRole('region', { name: '예약 상세' })).getByRole('button', { name: '확정' }));
    expect(await screen.findByText(/다른 곳에서 먼저 변경되었거나/)).toBeInTheDocument();
    await waitFor(() => expect(api.listAppointments).toHaveBeenCalledTimes(2));
  });
});

describe('AppointmentPage 새 예약', () => {
  it('빈 칸을 누르면 그 담당자와 시각이 폼에 채워진다', async () => {
    renderPage(client());
    await block();
    fireEvent.click(screen.getByRole('button', { name: '김담당 14:30 빈 시간' }));
    await waitFor(() => expect(screen.getByLabelText('시작 시각')).toHaveValue(`${today}T14:30`));
    expect(screen.getByLabelText('담당자')).toHaveValue(ids.staff);
  });

  it('주 보기의 빈 칸은 그 날짜와 시각을 채운다', async () => {
    renderPage(client());
    await block();
    fireEvent.click(screen.getByRole('button', { name: '주' }));
    const week = screen.getByRole('region', { name: '주 보기 달력' });
    const column = within(week).getAllByRole('group').find((group) => group.classList.contains('is-today'));
    fireEvent.click(within(column as HTMLElement).getByRole('button', { name: /09:00 빈 시간/ }));
    await waitFor(() => expect(screen.getByLabelText('시작 시각')).toHaveValue(`${today}T09:00`));
  });

  it('충돌을 설명하고 입력을 유지한다', async () => {
    const createAppointment = vi.fn(async () => { throw Object.assign(new Error('conflict'), { status: 409 }); });
    renderPage(client({ createAppointment }));
    await block();
    fireEvent.change(screen.getByLabelText('고객'), { target: { value: ids.customer } });
    fireEvent.change(screen.getByLabelText('담당자'), { target: { value: ids.staff } });
    fireEvent.change(screen.getByLabelText('서비스'), { target: { value: ids.service } });
    fireEvent.change(screen.getByLabelText('시작 시각'), { target: { value: `${today}T14:00` } });
    fireEvent.click(screen.getByRole('button', { name: '예약 저장' }));
    expect(await screen.findByText(/이미 사용 중이거나 근무 시간이 아닙니다/)).toBeInTheDocument();
    expect(screen.getByLabelText('시작 시각')).toHaveValue(`${today}T14:00`);
    expect(createAppointment).toHaveBeenCalledWith(ids.org, expect.objectContaining({ resource_ids: [], expected_version: null, start_at: `${today}T14:00:00+09:00` }));
  });

  it('작성 중에 다른 예약을 고르면 확인을 받고 취소하면 입력을 지키지 않고 이동하지 않는다', async () => {
    renderPage(client());
    fireEvent.change(await screen.findByLabelText('시작 시각'), { target: { value: `${today}T15:00` } });
    fireEvent.click(await block());
    expect(await screen.findByText('저장하지 않은 입력이 있습니다. 버리고 이동할까요?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '계속 작성' }));
    await waitFor(() => expect(screen.queryByText('저장하지 않은 입력이 있습니다. 버리고 이동할까요?')).not.toBeInTheDocument());
    expect(screen.getByLabelText('시작 시각')).toHaveValue(`${today}T15:00`);
    fireEvent.click(screen.getByRole('button', { name: /^10:00 김고객/ }));
    fireEvent.click(await screen.findByRole('button', { name: '버리고 이동' }));
    expect(await screen.findByRole('region', { name: '예약 상세' })).toBeInTheDocument();
  });
});

describe('AppointmentPage 예약 수정', () => {
  const edited = { ...appointment, start_at: `${today}T13:00:00+09:00`, end_at: `${today}T14:00:00+09:00`, version: 3 };

  async function openEdit(api: ApiClient) {
    renderPage(api);
    fireEvent.click(await block());
    fireEvent.click(within(await screen.findByRole('region', { name: '예약 상세' })).getByRole('button', { name: '예약 수정' }));
    return screen.findByRole('form', { name: '예약 수정' });
  }

  it('현재 값이 채워진 폼에서 expected_version을 넣어 PUT으로 저장한다', async () => {
    const api = client({}, [appointment], async (method) => (method === 'PUT' ? edited : []));
    const form = await openEdit(api);
    expect(within(form).getByLabelText('고객')).toBeDisabled();
    expect(within(form).getByLabelText('시작 시각')).toHaveValue(`${today}T10:00`);
    fireEvent.change(within(form).getByLabelText('시작 시각'), { target: { value: `${today}T13:00` } });
    fireEvent.click(within(form).getByRole('button', { name: '변경 저장' }));
    await waitFor(() => expect(putCalls(api)).toHaveLength(1));
    const [, path, , body] = putCalls(api)[0];
    expect(path).toBe(`/organizations/${ids.org}/appointments/${ids.appointment}`);
    expect(body).toEqual({
      customer_id: ids.customer, staff_id: ids.staff, service_id: ids.service, start_at: `${today}T13:00:00+09:00`, source: 'manual',
      expected_version: 2, resource_ids: [], operation_id: expect.any(String),
    });
    expect(await screen.findByRole('region', { name: '예약 상세' })).toBeInTheDocument();
    expect(screen.getByText(/13:00 ~ 14:00/)).toBeInTheDocument();
  });

  it('결과를 알 수 없는 실패 뒤 같은 입력의 재시도는 같은 operation_id를 쓴다', async () => {
    let attempts = 0;
    const api = client({}, [appointment], async (method) => {
      if (method !== 'PUT') return [];
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('server'), { status: 500 });
      return edited;
    });
    const form = await openEdit(api);
    fireEvent.change(within(form).getByLabelText('시작 시각'), { target: { value: `${today}T13:00` } });
    fireEvent.click(within(form).getByRole('button', { name: '변경 저장' }));
    expect(await screen.findByText(/예약을 저장하지 못했습니다/)).toBeInTheDocument();
    expect(within(form).getByLabelText('시작 시각')).toHaveValue(`${today}T13:00`);
    fireEvent.click(within(form).getByRole('button', { name: '변경 저장' }));
    await waitFor(() => expect(putCalls(api)).toHaveLength(2));
    expect(putCalls(api)[1][3].operation_id).toBe(putCalls(api)[0][3].operation_id);
  });

  it('입력을 바꾸면 새 operation_id를 쓴다', async () => {
    const api = client({}, [appointment], async (method) => {
      if (method !== 'PUT') return [];
      throw Object.assign(new Error('server'), { status: 500 });
    });
    const form = await openEdit(api);
    fireEvent.change(within(form).getByLabelText('시작 시각'), { target: { value: `${today}T13:00` } });
    fireEvent.click(within(form).getByRole('button', { name: '변경 저장' }));
    await waitFor(() => expect(putCalls(api)).toHaveLength(1));
    await screen.findByText(/예약을 저장하지 못했습니다/);
    fireEvent.change(within(form).getByLabelText('시작 시각'), { target: { value: `${today}T15:00` } });
    fireEvent.click(within(form).getByRole('button', { name: '변경 저장' }));
    await waitFor(() => expect(putCalls(api)).toHaveLength(2));
    expect(putCalls(api)[1][3].operation_id).not.toBe(putCalls(api)[0][3].operation_id);
  });

  it('409는 한국어로 안내하고 입력을 유지하며 최신 상태를 다시 불러올 수 있다', async () => {
    const api = client({}, [appointment], async (method) => {
      if (method !== 'PUT') return [];
      throw Object.assign(new Error('conflict'), { status: 409 });
    });
    const form = await openEdit(api);
    fireEvent.change(within(form).getByLabelText('시작 시각'), { target: { value: `${today}T13:00` } });
    fireEvent.click(within(form).getByRole('button', { name: '변경 저장' }));
    expect(await screen.findByText(/다른 곳에서 먼저 변경되었거나, 같은 시간에/)).toBeInTheDocument();
    expect(within(form).getByLabelText('시작 시각')).toHaveValue(`${today}T13:00`);
    fireEvent.click(within(form).getByRole('button', { name: '최신 상태 불러오기' }));
    await waitFor(() => expect(api.listAppointments).toHaveBeenCalledTimes(2));
  });

  it('422는 입력 확인을 안내한다', async () => {
    const api = client({}, [appointment], async (method) => {
      if (method !== 'PUT') return [];
      throw Object.assign(new Error('invalid'), { status: 422 });
    });
    const form = await openEdit(api);
    fireEvent.change(within(form).getByLabelText('시작 시각'), { target: { value: `${today}T13:00` } });
    fireEvent.click(within(form).getByRole('button', { name: '변경 저장' }));
    expect(await screen.findByText(/입력 내용이 올바르지 않습니다/)).toBeInTheDocument();
  });

  it('수정 취소는 변경이 있으면 확인을 받는다', async () => {
    const api = client();
    const form = await openEdit(api);
    fireEvent.change(within(form).getByLabelText('시작 시각'), { target: { value: `${today}T13:00` } });
    fireEvent.click(within(form).getByRole('button', { name: '수정 취소' }));
    fireEvent.click(await screen.findByRole('button', { name: '버리고 이동' }));
    expect(await screen.findByRole('region', { name: '예약 상세' })).toBeInTheDocument();
  });
});

describe('AppointmentPage 권한', () => {
  it('공간·장비 관리는 관리자에게만 보인다', async () => {
    const view = renderPage(client(), { canManageResources: true });
    expect(await screen.findByRole('button', { name: '공간·장비 관리' })).toBeInTheDocument();
    view.unmount();
    renderPage(client(), { readOnly: true, canManageResources: false });
    await block();
    expect(screen.queryByRole('button', { name: '공간·장비 관리' })).not.toBeInTheDocument();
  });

  it('보기 전용이면 폼·빈 칸 누르기·상태 버튼이 없고 상세만 본다', async () => {
    renderPage(client(), { readOnly: true });
    fireEvent.click(await block());
    expect(screen.queryByRole('button', { name: '예약 저장' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /빈 시간/ })).not.toBeInTheDocument();
    const detail = await screen.findByRole('region', { name: '예약 상세' });
    for (const name of ['확정', '노쇼', '취소', '예약 수정']) expect(within(detail).queryByRole('button', { name })).not.toBeInTheDocument();
    expect(within(detail).getByText('보기 전용 권한입니다.')).toBeInTheDocument();
  });
});

describe('AppointmentPage 담당자 필터(APT-14)', () => {
  const otherStaff = '66666666-6666-4666-8666-666666666666';
  const other = { ...appointment, id: '77777777-7777-4777-8777-777777777777', staff_id: otherStaff, customer_id: ids.customer };
  const twoStaff = () => client({
    listAppointmentStaff: vi.fn(async () => [
      { id: ids.staff, organization_id: ids.org, name: '김담당', is_active: true, schedule_version: 1 },
      { id: otherStaff, organization_id: ids.org, name: '이담당', is_active: true, schedule_version: 1 },
    ]),
  }, [appointment, other]);

  it('일 보기에서는 필터를 숨기고, 주 보기에서 담당자를 고르면 그 담당자 예약만 보인다', async () => {
    renderPage(twoStaff());
    await screen.findAllByRole('button', { name: /^10:00 김고객/ });
    expect(screen.queryByRole('combobox', { name: '담당자 필터' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '주' }));
    const week = screen.getByRole('region', { name: '주 보기 달력' });
    expect(within(week).getByText('김고객 · 김담')).toBeInTheDocument();
    expect(within(week).getByText('김고객 · 이담')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: '담당자 필터' }), { target: { value: otherStaff } });
    expect(within(week).queryByText('김고객 · 김담')).not.toBeInTheDocument();
    expect(within(week).getByText('김고객 · 이담')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: '담당자 필터' }), { target: { value: '' } });
    expect(within(week).getByText('김고객 · 김담')).toBeInTheDocument();
  });

  it('목록 보기에도 같은 필터가 적용된다', async () => {
    renderPage(twoStaff());
    await screen.findAllByRole('button', { name: /^10:00 김고객/ });
    fireEvent.click(screen.getByRole('button', { name: '목록' }));
    fireEvent.change(screen.getByRole('combobox', { name: '담당자 필터' }), { target: { value: ids.staff } });
    expect(screen.getAllByRole('button', { name: /^10:00 김고객 상세/ })).toHaveLength(1);
    fireEvent.change(screen.getByRole('combobox', { name: '담당자 필터' }), { target: { value: '' } });
    expect(screen.getAllByRole('button', { name: /^10:00 김고객 상세/ })).toHaveLength(2);
  });
});

describe('AppointmentPage 메모(APT-14)', () => {
  it('상세에서 메모를 저장하면 API를 호출하고 화면에 반영하며 자원·버전은 유지한다', async () => {
    const setAppointmentMemo = vi.fn(async (_o: string, _id: string, memo: string) => ({ ...appointment, memo, resource_ids: [] }));
    renderPage(client({ setAppointmentMemo }, [{ ...appointment, resource_ids: ['88888888-8888-4888-8888-888888888888'] }]));
    fireEvent.click(await block());
    const textarea = await screen.findByRole('textbox', { name: /메모/ });
    const save = screen.getByRole('button', { name: '메모 저장' });
    expect(save).toBeDisabled();
    fireEvent.change(textarea, { target: { value: '알레르기 주의' } });
    fireEvent.click(save);
    await waitFor(() => expect(setAppointmentMemo).toHaveBeenCalledWith(ids.org, ids.appointment, '알레르기 주의'));
    await waitFor(() => expect(screen.getByRole('button', { name: '메모 저장' })).toBeDisabled());
    expect(screen.getByRole('textbox', { name: /메모/ })).toHaveValue('알레르기 주의');
    expect(screen.getByText('알 수 없는 자원')).toBeInTheDocument();
  });

  it('저장에 실패하면 입력을 유지하고 오류를 알린다', async () => {
    const setAppointmentMemo = vi.fn(async () => { throw new Error('x'); });
    renderPage(client({ setAppointmentMemo }));
    fireEvent.click(await block());
    fireEvent.change(await screen.findByRole('textbox', { name: /메모/ }), { target: { value: '요청' } });
    fireEvent.click(screen.getByRole('button', { name: '메모 저장' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('메모를 저장하지 못했습니다');
    expect(screen.getByRole('textbox', { name: /메모/ })).toHaveValue('요청');
  });

  it('조회 전용이면 메모를 읽기만 한다', async () => {
    renderPage(client({}, [{ ...appointment, memo: '조용한 방' }]), { readOnly: true });
    fireEvent.click(await block());
    expect(await screen.findByText('조용한 방')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '메모 저장' })).not.toBeInTheDocument();
  });
});
