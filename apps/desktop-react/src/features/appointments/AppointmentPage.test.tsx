import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConfirmDialog } from '@business-assistant/react-ui';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../api/client';
import { AppointmentPage } from './AppointmentPage';
import { addDays, todayKstKey } from './appointmentTime';

const ids = { org: '22222222-2222-4222-8222-222222222222', customer: '11111111-1111-4111-8111-111111111111', staff: '33333333-3333-4333-8333-333333333333', service: '44444444-4444-4444-8444-444444444444', appointment: '55555555-5555-4555-8555-555555555555' };
const branches = [{ id: '66666666-6666-4666-8666-666666666666', organization_id: ids.org, code: 'MAIN', name: '본점', timezone_name: 'Asia/Seoul', is_primary: true, is_active: true, version: 1 }, { id: '77777777-7777-4777-8777-777777777777', organization_id: ids.org, code: 'BR-2', name: '2호점', timezone_name: 'Asia/Seoul', is_primary: false, is_active: true, version: 1 }];
const today = todayKstKey();
const appointment = { id: ids.appointment, organization_id: ids.org, customer_id: ids.customer, staff_id: ids.staff, service_id: ids.service, service_name_snapshot: '피부관리', duration_minutes: 60, buffer_minutes: 10, start_at: `${today}T10:00:00+09:00`, end_at: `${today}T11:00:00+09:00`, status: 'reserved', source: 'manual', cancellation_reason: null, version: 2, memo: '', resource_ids: [] };

type Handler = (method: string, path: string, schema: unknown, body?: unknown) => Promise<unknown>;

function client(overrides: Record<string, unknown> = {}, rows: unknown[] = [appointment], handler?: Handler) {
  return {
    listAppointmentBranches: vi.fn(async () => []),
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

it('중지된 담당자의 기존 예약 상세에서도 이름을 보존한다',async()=>{
 const api=client({listAppointmentStaff:vi.fn(async()=>[{id:ids.staff,organization_id:ids.org,name:'중지 담당자',is_active:false,schedule_version:1}])},[{...appointment,status:'completed'}]);
 renderPage(api,{readOnly:true});
 fireEvent.click(await block());
 expect(within(await screen.findByRole('region',{name:'예약 상세'})).getByText('중지 담당자')).toBeInTheDocument();
});

describe('AppointmentPage 보기 전환', () => {
  it('방문 처리된 예약에서 같은 예약을 수납 화면으로 전달한다',async()=>{
    const open=vi.fn(async()=>true);
    render(<><AppointmentPage api={client({},[{...appointment,status:'checked_in'}])} organizationId={ids.org} readOnly={false} onOpenCheckout={open}/><ConfirmDialog/></>);
    fireEvent.click(await block());
    fireEvent.click(within(await screen.findByRole('region',{name:'예약 상세'})).getByRole('button',{name:'수납 장바구니'}));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({id:ids.appointment,customer_id:ids.customer}));
  });
  it('방문 전 예약에는 수납 진입 버튼을 표시하지 않는다',async()=>{
    render(<><AppointmentPage api={client()} organizationId={ids.org} readOnly={false} onOpenCheckout={vi.fn(async()=>true)}/><ConfirmDialog/></>);
    fireEvent.click(await block());
    expect(within(await screen.findByRole('region',{name:'예약 상세'})).queryByRole('button',{name:'수납 장바구니'})).not.toBeInTheDocument();
  });
  it.each(['edit','memo'])('서버에서 선택 예약이 다른 날짜로 이동해도 %s 입력이 사라지지 않는다',async(kind)=>{
    const api=client({},[appointment]);
    renderPage(api);
    fireEvent.click(await block());
    const detail=await screen.findByRole('region',{name:'예약 상세'});
    if(kind==='edit'){
      fireEvent.click(within(detail).getByRole('button',{name:'예약 수정'}));
      fireEvent.change(await screen.findByLabelText('시작 시각'),{target:{value:`${today}T15:00`}});
    }else fireEvent.change(within(detail).getByPlaceholderText('알레르기·요청 사항 등을 적어 두세요'),{target:{value:'지켜야 하는 메모'}});
    fireEvent.click(screen.getByRole('button',{name:'예약 새로고침'}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'예약 새로고침'})).toBeEnabled());
    if(kind==='edit')expect(screen.getByLabelText('시작 시각')).toHaveValue(`${today}T15:00`);
    else expect(screen.getByPlaceholderText('알레르기·요청 사항 등을 적어 두세요')).toHaveValue('지켜야 하는 메모');
  });

  it('대기 예약 전환의 담당자 선택에도 서비스 지정 직원을 적용한다', async () => {
    const otherStaff='99999999-9999-4999-8999-999999999999';
    const entry={id:'66666666-6666-4666-8666-666666666666',organization_id:ids.org,customer_id:ids.customer,service_id:ids.service,staff_id:null,preferred_date:today,note:'',status:'waiting',version:1,created_at:new Date().toISOString()};
    const api=client({listAppointmentStaff:vi.fn(async()=>[{id:ids.staff,name:'김담당',is_active:true},{id:otherStaff,name:'이지정',is_active:true}])},[appointment],async(_method,path)=>{
      if(path.endsWith('/appointment-waitlist'))return [entry];
      if(path.endsWith('/appointment-service-staff'))return [{service_id:ids.service,staff_id:otherStaff}];
      return [];
    });
    renderPage(api);
    await block();
    fireEvent.click(screen.getByRole('button',{name:'대기 목록'}));
    fireEvent.click(await screen.findByRole('button',{name:'예약 만들기'}));
    const picker=screen.getByLabelText('예약 담당자');
    expect(within(picker).queryByRole('option',{name:'김담당'})).not.toBeInTheDocument();
    expect(picker).toHaveValue(otherStaff);
  });

  it('편집 중 자동 갱신이 와도 편집 시작 버전으로 충돌을 검사한다', async () => {
    const api = client({}, [appointment], async (method, path) => {
      if (method === 'PUT') throw Object.assign(new Error('conflict'), { status: 409 });
      return path.includes('/appointments?') ? [{ ...appointment, version: 3, status: 'confirmed' }] : [];
    });
    renderPage(api);
    fireEvent.click(await block());
    fireEvent.click(within(await screen.findByRole('region', { name: '예약 상세' })).getByRole('button', { name: '예약 수정' }));
    const form = await screen.findByRole('form', { name: '예약 수정' });
    fireEvent.change(within(form).getByLabelText('시작 시각'), { target: { value: `${today}T15:00` } });
    fireEvent.click(screen.getByRole('button', { name: '예약 새로고침' }));
    await screen.findByText(/다른 곳에서 예약이 변경되었습니다/);
    expect(within(form).getByLabelText('시작 시각')).toHaveValue(`${today}T15:00`);
    fireEvent.click(within(form).getByRole('button', { name: '변경 저장' }));
    await waitFor(() => expect(putCalls(api)).toHaveLength(1));
    expect(putCalls(api)[0][3]).toMatchObject({ expected_version: 2 });
    await screen.findByText(/다른 곳에서 먼저 변경되었거나, 같은 시간에/);
  });

  it('상태 저장 전에 시작한 갱신 응답이 늦게 와도 저장된 상태를 되돌리지 않는다', async () => {
    let resolve!: (rows: unknown[]) => void;
    const api = client({}, [appointment], async (_method,path) => path.includes('/appointments?') ? new Promise(done => { resolve=done; }) : []);
    renderPage(api);
    await block();
    fireEvent.click(screen.getByRole('button', { name: '예약 새로고침' }));
    fireEvent.click(await block());
    fireEvent.click(within(await screen.findByRole('region', { name: '예약 상세' })).getByRole('button', { name: '확정' }));
    await waitFor(async () => expect(await block()).toHaveAttribute('data-status', 'confirmed'));
    resolve([appointment]);
    await waitFor(() => expect(screen.getByRole('button', { name: '예약 새로고침' })).toBeEnabled());
    expect(await block()).toHaveAttribute('data-status','confirmed');
  });

  it('날짜를 변경하면 이전 갱신이 완료되지 않아도 새 날짜를 갱신할 수 있다', async () => {
    let resolve!: (rows: unknown[]) => void;
    const api = client({}, [appointment], async (_method,path) => path.includes('/appointments?') ? new Promise(done => { resolve=done; }) : []);
    renderPage(api);
    await block();
    fireEvent.click(screen.getByRole('button', { name: '예약 새로고침' }));
    fireEvent.click(screen.getByRole('button', { name: '다음 일' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '예약 새로고침' })).toBeEnabled());
    resolve([appointment]);
  });

  it('대기 입력 후 팝업 닫기를 취소하면 입력을 유지한다', async () => {
    renderPage(client());
    await block();
    fireEvent.click(screen.getByRole('button', { name: '대기 목록' }));
    const dialog = await screen.findByRole('dialog', { name: '예약 대기 목록' });
    fireEvent.change(within(dialog).getByLabelText('대기 메모'), { target: { value: '오후 시간 희망' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '닫기' }));
    const guard = await screen.findByRole('dialog', { name: '작성 중인 대기 예약' });
    fireEvent.click(within(guard).getByRole('button', { name: '계속 작성' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '작성 중인 대기 예약' })).not.toBeInTheDocument());
    expect(screen.getByLabelText('대기 메모')).toHaveValue('오후 시간 희망');
  });

  it('현재 기간을 새로고침하면 변경된 상태를 반영하고 작성 중 입력은 보존한다', async () => {
    const api = client({}, [appointment], async (_method, path) => path.includes('/appointments?') ? [{ ...appointment, status: 'confirmed', version: 3 }] : []);
    renderPage(api);
    await block();
    fireEvent.change(screen.getByLabelText('시작 시각'), { target: { value: `${today}T13:00` } });
    fireEvent.click(screen.getByRole('button', { name: '예약 새로고침' }));
    await waitFor(async () => expect(await block()).toHaveAttribute('data-status', 'confirmed'));
    expect(screen.getByLabelText('시작 시각')).toHaveValue(`${today}T13:00`);
    expect(screen.getByLabelText('예약 동기화 상태')).toHaveTextContent('최근 갱신');
  });

  it('상태 필터는 일 보기와 목록에 동일하게 적용된다', async () => {
    renderPage(client({}, [appointment, { ...appointment, id: '88888888-8888-4888-8888-888888888888', status: 'canceled' }]));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^10:00 김고객/ })).toHaveLength(2));
    fireEvent.change(screen.getByLabelText('예약 상태 필터'), { target: { value: 'confirmed' } });
    expect(screen.queryByRole('button', { name: /^10:00 김고객/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('예약 상태 필터'), { target: { value: 'reserved' } });
    expect(screen.getAllByRole('button', { name: /^10:00 김고객/ })).toHaveLength(1);
  });

  it('메모를 작성하다 다른 예약을 고르면 입력을 버릴지 확인한다', async () => {
    renderPage(client({}, [appointment, { ...appointment, id: '88888888-8888-4888-8888-888888888888', start_at: `${today}T12:00:00+09:00`, end_at: `${today}T13:00:00+09:00` }]));
    fireEvent.click(await block());
    fireEvent.change(await screen.findByPlaceholderText('알레르기·요청 사항 등을 적어 두세요'), { target: { value: '작성 중 메모' } });
    fireEvent.click(screen.getByRole('button', { name: /^12:00 김고객/ }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('알레르기·요청 사항 등을 적어 두세요')).toHaveValue('작성 중 메모');
    fireEvent.click(screen.getByRole('button', { name: '계속 작성' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('내부 예약 대기 목록을 열고 대기 상태를 표시한다', async () => {
    const waitlist = { id: '66666666-6666-4666-8666-666666666666', organization_id: ids.org, customer_id: ids.customer, service_id: ids.service, staff_id: null, preferred_date: null, note: '', status: 'waiting', version: 1, created_at: new Date().toISOString() };
    const api = client({}, [appointment], async (_method, path) => path.endsWith('/appointment-waitlist') ? [waitlist] : []);
    renderPage(api);
    fireEvent.click(await screen.findByRole('button', { name: '대기 목록' }));
    expect(await screen.findByRole('dialog', { name: '예약 대기 목록' })).toBeInTheDocument();
    const dialog = screen.getByRole('dialog', { name: '예약 대기 목록' });
    expect(within(within(dialog).getByRole('table', { name: '대기 고객 목록' })).getByRole('cell', { name: '김고객' })).toBeInTheDocument();
    expect(within(dialog).getByText('대기 중')).toBeInTheDocument();
  });

  it('대기 고객을 선택한 시간으로 예약하고 예약 목록에 반영한다', async () => {
    const waitlist = { id: '66666666-6666-4666-8666-666666666666', organization_id: ids.org, customer_id: ids.customer, service_id: ids.service, staff_id: null, preferred_date: today, note: '', status: 'waiting', version: 1, created_at: new Date().toISOString() };
    const api = client({}, [appointment], async (method, path, _schema, body) => {
      if (method === 'GET' && path.endsWith('/appointment-waitlist')) return [waitlist];
      if (method === 'POST' && path.endsWith('/book')) {
        expect(body).toMatchObject({ staff_id: ids.staff, expected_version: 1 });
        expect((body as { operation_id: string }).operation_id).toMatch(/^[0-9a-f-]{36}$/i);
        return { appointment: { ...appointment, id: '77777777-7777-4777-8777-777777777777', start_at: `${today}T10:00:00+09:00` }, waitlist: { ...waitlist, status: 'booked', version: 2 }, replayed: false };
      }
      return [];
    });
    renderPage(api);
    fireEvent.click(await screen.findByRole('button', { name: '대기 목록' }));
    fireEvent.click(await screen.findByRole('button', { name: '예약 만들기' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '예약 대기 목록' })).getByRole('button', { name: '예약 저장' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '예약 대기 목록' })).not.toBeInTheDocument());
    await waitFor(() => expect(within(screen.getByRole('region', { name: '일 보기 달력' })).getAllByRole('button', { name: /^10:00 김고객/ })).toHaveLength(2));
  });

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
    expect(await within(screen.getByRole('region', { name: '예약 상세' })).findByText('노쇼')).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole('button', { name: '버리고 이동' }));
    await waitFor(() => expect(api.listAppointments).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('region', { name: '예약 상세' })).toBeInTheDocument();
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

  it('반복 예약 목록에서 시리즈 회차를 조회한다', async () => {
    const api=client({},[appointment]);renderPage(api);
    fireEvent.click(await screen.findByRole('button',{name:'반복 예약'}));
    expect(await screen.findByRole('dialog',{name:'반복 예약 회차'})).toBeInTheDocument();
    expect(await screen.findByText('등록된 반복 예약이 없습니다.')).toBeInTheDocument();
    expect(api.call).toHaveBeenCalledWith('GET',`/organizations/${ids.org}/appointment-series?limit=100`,expect.anything());
  });

  it('관리자는 시작 날짜 이후의 반복 예약 회차만 일괄 취소할 수 있다', async()=>{
    const seriesId='88888888-8888-4888-8888-888888888888';
    const series={series:{id:seriesId,organization_id:ids.org,customer_id:ids.customer,staff_id:ids.staff,service_id:ids.service,frequency:'weekly',interval_count:1,occurrence_count:2,created_at:appointment.start_at,result_snapshot:{skipped:[]}},occurrences:[{occurrence_number:1,scheduled_start_at:appointment.start_at,is_exception:false,appointment}],exceptions:[]};
    const api=client({},[appointment],async(_method,path)=>path.includes('cancel-future')?{series_id:seriesId,from_date:today,reason:'정기 시술 일정 종료',canceled:[{...appointment,status:'canceled',version:3}],replayed:false}:path.endsWith('appointment-series?limit=100')?[series]:[]);
    renderPage(api,{canManageResources:true});fireEvent.click(await screen.findByRole('button',{name:'반복 예약'}));
    await screen.findByRole('table',{name:'반복 예약 회차 목록'});
    expect(screen.getByRole('button',{name:'이후 회차 1건 취소'})).toBeEnabled();
    fireEvent.click(screen.getByRole('button',{name:'이후 회차 1건 취소'}));
    fireEvent.click(await screen.findByRole('button',{name:'1건 취소'}));
    await waitFor(()=>expect(api.call).toHaveBeenCalledWith('POST',`/organizations/${ids.org}/appointment-series/${seriesId}/cancel-future`,expect.anything(),expect.objectContaining({from_date:today,reason:'정기 예약 일정 종료',operation_id:expect.any(String)})));
  });

  it('관리자는 반복 예약의 미래 기본 회차에 담당자와 시술을 일괄 적용한다',async()=>{
    const seriesId='88888888-8888-4888-8888-888888888888',otherStaff='99999999-9999-4999-8999-999999999999',otherService='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const series={series:{id:seriesId,organization_id:ids.org,customer_id:ids.customer,staff_id:ids.staff,service_id:ids.service,frequency:'weekly',interval_count:1,occurrence_count:2,created_at:appointment.start_at,result_snapshot:{skipped:[]}},occurrences:[{occurrence_number:1,scheduled_start_at:appointment.start_at,is_exception:false,appointment}],exceptions:[]};
    const api=client({listAppointmentStaff:vi.fn(async()=>[{id:ids.staff,organization_id:ids.org,name:'김담당',is_active:true,schedule_version:1},{id:otherStaff,organization_id:ids.org,name:'이담당',is_active:true,schedule_version:1}]),listAppointmentServices:vi.fn(async()=>[{id:ids.service,organization_id:ids.org,name:'피부관리',duration_minutes:60,buffer_minutes:10,is_active:true,resource_version:1},{id:otherService,organization_id:ids.org,name:'진정관리',duration_minutes:45,buffer_minutes:5,is_active:true,resource_version:1}])},[appointment],async(_method,path)=>path.includes('update-future')?{series_id:seriesId,staff_id:otherStaff,service_id:otherService,updated:[{...appointment,staff_id:otherStaff,service_id:otherService,service_name_snapshot:'진정관리',duration_minutes:45}],replayed:false}:path.endsWith('appointment-series?limit=100')?[{...series,series:{...series.series,staff_id:otherStaff,service_id:otherService},occurrences:[{...series.occurrences[0],appointment:{...appointment,staff_id:otherStaff,service_id:otherService,service_name_snapshot:'진정관리',duration_minutes:45}}]}]:[]);
    renderPage(api,{canManageResources:true});fireEvent.click(await screen.findByRole('button',{name:'반복 예약'}));await screen.findByRole('table',{name:'반복 예약 회차 목록'});
    fireEvent.change(screen.getByLabelText('시리즈 담당자'),{target:{value:otherStaff}});fireEvent.change(screen.getByLabelText('시리즈 시술'),{target:{value:otherService}});await waitFor(()=>expect(screen.getByRole('button',{name:'미래 회차 담당자·시술 변경'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'미래 회차 담당자·시술 변경'}));
    fireEvent.click(await screen.findByRole('button',{name:'1건 적용'}));
    await waitFor(()=>expect(api.call).toHaveBeenCalledWith('POST',`/organizations/${ids.org}/appointment-series/${seriesId}/update-future`,expect.anything(),expect.objectContaining({staff_id:otherStaff,service_id:otherService,operation_id:expect.any(String)})));
  });

  it('관리자는 반복 예약의 남은 일정 주기와 공간·장비를 함께 변경한다',async()=>{
    const seriesId='88888888-8888-4888-8888-888888888888',resourceId='99999999-9999-4999-8999-999999999999';
    const first={...appointment,id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',start_at:`${addDays(today,7)}T10:00:00+09:00`,end_at:`${addDays(today,7)}T11:00:00+09:00`};
    const second={...appointment,id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',start_at:`${addDays(today,14)}T10:00:00+09:00`,end_at:`${addDays(today,14)}T11:00:00+09:00`};
    const series={series:{id:seriesId,organization_id:ids.org,customer_id:ids.customer,staff_id:ids.staff,service_id:ids.service,frequency:'weekly',interval_count:1,occurrence_count:2,resource_ids:[],created_at:first.start_at,result_snapshot:{skipped:[]}},occurrences:[{occurrence_number:1,scheduled_start_at:first.start_at,is_exception:false,appointment:first},{occurrence_number:2,scheduled_start_at:second.start_at,is_exception:false,appointment:second}],exceptions:[]};
    const resource={id:resourceId,organization_id:ids.org,name:'관리실',kind:'room',is_active:true,version:1};
    const api=client({},[first,second],async(method,path)=>{
      if(path.endsWith('/appointment-resources'))return[resource];
      if(path.endsWith('/appointment-series?limit=100'))return[series];
      if(path.endsWith('/reschedule-future'))return{series_id:seriesId,from_occurrence_number:1,start_at:first.start_at,frequency:'monthly',interval_count:1,resource_ids:[resourceId],updated:[first,second],replayed:false};
      return[];
    });
    renderPage(api,{canManageResources:true});fireEvent.click(await screen.findByRole('button',{name:'반복 예약'}));await screen.findByRole('table',{name:'반복 예약 회차 목록'});
    fireEvent.change(screen.getByLabelText('반복 예약 주기'),{target:{value:'monthly'}});
    fireEvent.click(screen.getByLabelText('관리실 사용'));
    fireEvent.click(screen.getByRole('button',{name:'미래 일정 2건 재배치'}));fireEvent.click(await screen.findByRole('button',{name:'2건 적용'}));
    await waitFor(()=>{const calls=(api.call as unknown as ReturnType<typeof vi.fn>).mock.calls;expect(calls.some(call=>call[0]==='POST'&&call[1]===`/organizations/${ids.org}/appointment-series/${seriesId}/reschedule-future`&&call[3]?.frequency==='monthly'&&call[3]?.resource_ids?.includes(resourceId)),JSON.stringify({post:calls.filter(call=>call[0]==='POST').map(call=>[call[1],call[3]]),alert:screen.queryByRole('alert')?.textContent,date:screen.queryByLabelText('새 반복 예약 시작 일시')?.getAttribute('value')}).slice(0,2000)).toBe(true)});
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

  it('일·주 보기에서 담당자를 고르면 해당 담당자 예약만 보인다', async () => {
    renderPage(twoStaff());
    await screen.findAllByRole('button', { name: /^10:00 김고객/ });
    fireEvent.change(screen.getByRole('combobox', { name: '담당자 필터' }), { target: { value: otherStaff } });
    expect(screen.getAllByRole('button', { name: /^10:00 김고객/ })).toHaveLength(1);
    fireEvent.change(screen.getByRole('combobox', { name: '담당자 필터' }), { target: { value: '' } });
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

describe('AppointmentPage 지점(APT-20)', () => {
  it('선택 지점에 속한 담당자만 필터 선택지로 노출한다', async () => {
    const api = client({
      listAppointmentBranches: vi.fn(async () => branches),
      listAppointmentStaff: vi.fn(async () => [
        { id: ids.staff, organization_id: ids.org, branch_id: branches[0].id, name: '본점 담당', is_active: true, schedule_version: 1 },
        { id: '99999999-9999-4999-8999-999999999999', organization_id: ids.org, branch_id: branches[1].id, name: '2호점 담당', is_active: true, schedule_version: 1 },
      ]),
    });
    renderPage(api);
    const staffFilter = await screen.findByLabelText('담당자 필터') as HTMLSelectElement;
    expect(Array.from(staffFilter.options).map(option => option.textContent)).toContain('본점 담당');
    fireEvent.change(screen.getByLabelText('지점 선택'), { target: { value: branches[1].id } });
    await waitFor(() => expect(Array.from(staffFilter.options).map(option => option.textContent)).toContain('2호점 담당'));
    expect(Array.from(staffFilter.options).map(option => option.textContent)).not.toContain('본점 담당');
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
    await waitFor(() => expect(screen.getByRole('button', { name: '메모 저장' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '메모 저장' }));
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

describe('AppointmentPage 끌어서 옮기기(APT-14)', () => {
  const otherStaff = '66666666-6666-4666-8666-666666666666';
  const staffList = [
    { id: ids.staff, organization_id: ids.org, name: '김담당', is_active: true, schedule_version: 1 },
    { id: otherStaff, organization_id: ids.org, name: '이담당', is_active: true, schedule_version: 1 },
  ];
  const withStaff = (put?: () => Promise<unknown>, rows: unknown[] = [appointment]) => client({ listAppointmentStaff: vi.fn(async () => staffList) }, rows, put ? async (method) => (method === 'PUT' ? put() : []) : undefined);
  const firstSlotMinutes = (region: HTMLElement) => {
    const label = within(region).getAllByRole('button', { name: /빈 시간$/ })[0].getAttribute('aria-label')!;
    const [h, m] = /(\d{2}):(\d{2}) 빈 시간$/.exec(label)!.slice(1).map(Number);
    return h * 60 + m;
  };
  const SLOT = 28;
  /** jsdom은 DragEvent 좌표를 복사하지 않으므로 clientY를 직접 지정한다. */
  const drag = (type: 'dragStart' | 'dragOver' | 'drop', element: Element, clientY: number) => {
    const event = createEvent[type](element);
    Object.defineProperty(event, 'clientY', { value: clientY });
    fireEvent(element, event);
  };

  it('주 보기에서 다른 날짜 칸에 놓으면 확인 후 시간만 바꿔 PUT으로 저장한다', async () => {
    const saved = { ...appointment, start_at: `${addDays(today, 0)}T10:00:00+09:00`, version: 3 };
    const api = withStaff(async () => saved);
    renderPage(api);
    await screen.findAllByRole('button', { name: /^10:00 김고객/ });
    fireEvent.click(screen.getByRole('button', { name: '주' }));
    const week = screen.getByRole('region', { name: '주 보기 달력' });
    const days = within(week).getAllByRole('group');
    const todayIndex = days.findIndex((group) => group.className.includes('is-today'));
    const target = days[(todayIndex + 1) % 7];
    const startMin = firstSlotMinutes(week);
    const block = within(week).getByRole('button', { name: /^10:00 김고객/ });
    drag('dragStart', block, 0);
    drag('dragOver', target, SLOT * 4);
    drag('drop', target, SLOT * 4);
    fireEvent.click(await screen.findByRole('button', { name: '이동' }));
    await waitFor(() => expect(putCalls(api)).toHaveLength(1));
    const body = putCalls(api)[0][3] as Record<string, unknown>;
    const expectedMinutes = startMin + 4 * 30;
    const hh = String(Math.floor(expectedMinutes / 60)).padStart(2, '0');
    const mm = String(expectedMinutes % 60).padStart(2, '0');
    expect(String(body.start_at).endsWith(`T${hh}:${mm}:00+09:00`)).toBe(true);
    expect(String(body.start_at).slice(0, 10)).not.toBe(today);
    expect(body).toMatchObject({ staff_id: ids.staff, service_id: ids.service, customer_id: ids.customer, expected_version: 2, resource_ids: [] });
    expect(body.operation_id).toEqual(expect.any(String));
  });

  it('일 보기에서 다른 담당자 열에 놓으면 담당자도 바뀐다', async () => {
    const api = withStaff(async () => ({ ...appointment, staff_id: otherStaff, version: 3 }));
    renderPage(api);
    await block();
    const day = screen.getByRole('region', { name: '일 보기 달력' });
    const startMin = firstSlotMinutes(day);
    const target = within(day).getByRole('group', { name: '이담당 일정' });
    const sourceTop = (10 * 60 - startMin) / 30 * SLOT;
    drag('dragStart', within(day).getByRole('button', { name: /^10:00 김고객/ }), 0);
    drag('drop', target, sourceTop);
    fireEvent.click(await screen.findByRole('button', { name: '이동' }));
    await waitFor(() => expect(putCalls(api)).toHaveLength(1));
    const body = putCalls(api)[0][3] as Record<string, unknown>;
    expect(body.staff_id).toBe(otherStaff);
    expect(String(body.start_at)).toContain('T10:00:00+09:00');
  });

  it('확인에서 취소하면 저장하지 않는다', async () => {
    const api = withStaff(async () => appointment);
    renderPage(api);
    await block();
    const day = screen.getByRole('region', { name: '일 보기 달력' });
    drag('dragStart', within(day).getByRole('button', { name: /^10:00 김고객/ }), 0);
    drag('drop', within(day).getByRole('group', { name: '이담당 일정' }), SLOT * 2);
    fireEvent.click(await screen.findByRole('button', { name: '취소' }));
    expect(putCalls(api)).toHaveLength(0);
  });

  it('같은 자리에 놓으면 아무 일도 하지 않는다', async () => {
    const api = withStaff(async () => appointment);
    renderPage(api);
    await block();
    const day = screen.getByRole('region', { name: '일 보기 달력' });
    const startMin = firstSlotMinutes(day);
    drag('dragStart', within(day).getByRole('button', { name: /^10:00 김고객/ }), 0);
    drag('drop', within(day).getByRole('group', { name: '김담당 일정' }), (10 * 60 - startMin) / 30 * SLOT);
    await Promise.resolve();
    expect(screen.queryByRole('button', { name: '이동' })).not.toBeInTheDocument();
    expect(putCalls(api)).toHaveLength(0);
  });

  it('서버가 409로 거절하면 안내하고 화면 예약은 그대로 둔다', async () => {
    const api = withStaff(async () => { throw Object.assign(new Error('conflict'), { status: 409 }); });
    renderPage(api);
    await block();
    const day = screen.getByRole('region', { name: '일 보기 달력' });
    drag('dragStart', within(day).getByRole('button', { name: /^10:00 김고객/ }), 0);
    drag('drop', within(day).getByRole('group', { name: '이담당 일정' }), SLOT * 2);
    fireEvent.click(await screen.findByRole('button', { name: '이동' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('옮기지 못했습니다');
    expect(await screen.findAllByRole('button', { name: /^10:00 김고객/ })).not.toHaveLength(0);
  });

  it('완료된 예약과 조회 전용 화면에서는 끌 수 없다', async () => {
    const done = { ...appointment, status: 'completed' };
    const { unmount } = renderPage(withStaff(undefined, [done]));
    expect(await screen.findByRole('button', { name: /^10:00 김고객/ })).toHaveAttribute('draggable', 'false');
    unmount();
    renderPage(withStaff(), { readOnly: true });
    expect(await screen.findByRole('button', { name: /^10:00 김고객/ })).toHaveAttribute('draggable', 'false');
  });
});

describe('AppointmentPage 담당 가능 직원 규칙(SVC-11)', () => {
  const otherStaff = '66666666-6666-4666-8666-666666666666';
  const staffList = [
    { id: ids.staff, organization_id: ids.org, name: '김담당', is_active: true, schedule_version: 1 },
    { id: otherStaff, organization_id: ids.org, name: '이담당', is_active: true, schedule_version: 1 },
  ];
  const withRules = () => client({ listAppointmentStaff: vi.fn(async () => staffList) }, [appointment], async (method, path) => {
    if (method === 'GET' && path.endsWith('/appointment-service-staff')) return [{ service_id: ids.service, staff_id: ids.staff }];
    return method === 'PUT' ? appointment : [];
  });

  it('지정되지 않은 직원 열로 끌어 놓으면 서버에 보내지 않고 이유를 알린다', async () => {
    const api = withRules();
    renderPage(api);
    await block();
    const day = screen.getByRole('region', { name: '일 보기 달력' });
    const event = createEvent.dragStart(within(day).getByRole('button', { name: /^10:00 김고객/ }));
    Object.defineProperty(event, 'clientY', { value: 0 });
    fireEvent(within(day).getByRole('button', { name: /^10:00 김고객/ }), event);
    const drop = createEvent.drop(within(day).getByRole('group', { name: '이담당 일정' }));
    Object.defineProperty(drop, 'clientY', { value: 56 });
    fireEvent(within(day).getByRole('group', { name: '이담당 일정' }), drop);
    expect(await screen.findByRole('alert')).toHaveTextContent("이담당 직원은 '피부관리' 서비스를 맡을 수 없어 옮길 수 없습니다.");
    expect(screen.queryByRole('button', { name: '이동' })).not.toBeInTheDocument();
    expect(putCalls(api)).toHaveLength(0);
  });

  it('새 예약 폼의 담당자 목록이 서비스 규칙을 따른다', async () => {
    renderPage(withRules());
    await block();
    fireEvent.click(screen.getByRole('button', { name: '김담당 14:30 빈 시간' }));
    // 빈 칸을 누르면 폼이 새 값으로 다시 만들어지므로 채워진 뒤에 서비스를 고른다.
    await waitFor(() => expect(screen.getByLabelText('시작 시각')).toHaveValue(`${today}T14:30`));
    fireEvent.change(screen.getByLabelText('서비스'), { target: { value: ids.service } });
    const options = within(screen.getByLabelText('담당자')).getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['선택', '김담당']);
  });
});
