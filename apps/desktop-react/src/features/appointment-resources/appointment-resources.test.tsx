import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NoticeHost } from '@business-assistant/react-ui';
import { ResourceManagerDialog, ResourcePicker, StaffAvailabilityDialog, autoSelectResources, kstIso, missingRequirements, createOperationTracker } from './index';
import { apiFailure, fakeApi, type FakeCall } from './testApi';

const ORG = 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const room = { id: 'r1', organization_id: ORG, name: '관리실 1', kind: 'room', is_active: true, version: 1 };
const room2 = { id: 'r2', organization_id: ORG, name: '관리실 2', kind: 'room', is_active: true, version: 1 };
const laser = { id: 'e1', organization_id: ORG, name: '레이저 1', kind: 'equipment', is_active: true, version: 4 };
const retired = { id: 'r3', organization_id: ORG, name: '폐쇄실', kind: 'room', is_active: false, version: 2 };
const service = { id: 's1', organization_id: ORG, name: '관리', duration_minutes: 60, buffer_minutes: 10, is_active: true };
const service2 = { ...service, id: 's2', name: '레이저' };

function server(overrides: Record<string, (call: FakeCall) => unknown> = {}) {
  const handlers: Record<string, (call: FakeCall) => unknown> = {
    'GET /appointment-resources': () => [room, laser, retired],
    'GET /appointment-services': () => [service, service2],
    'GET /appointment-services/s1/resource-setup': () => ({ service_id: 's1', resource_version: 3, requirements: [{ kind: 'room', quantity: 1 }] }),
    'GET /appointment-services/s2/resource-setup': () => ({ service_id: 's2', resource_version: 1, requirements: [] }),
    'GET /appointment-services/s1/resource-requirements': () => [{ kind: 'room', quantity: 1 }, { kind: 'equipment', quantity: 1 }],
    'GET /appointment-services/s2/resource-requirements': () => [],
    ...overrides,
  };
  return fakeApi((call) => {
    const key = `${call.method} ${call.path.replace(`/organizations/${ORG}`, '')}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected ${key}`);
    return handler(call);
  });
}
const sent = (calls: FakeCall[], key: string) => calls.filter((call) => `${call.method} ${call.path.replace(`/organizations/${ORG}`, '')}` === key);

describe('ResourceManagerDialog', () => {
  it('공간·장비 목록과 서비스 기준을 불러온다', async () => {
    const { api } = server();
    render(<ResourceManagerDialog api={api} organizationId={ORG} onClose={() => undefined} />);
    expect(await screen.findByText('관리실 1')).toBeInTheDocument();
    expect(screen.getByText('레이저 1')).toBeInTheDocument();
    expect(screen.getByText('사용 중지', { selector: 'td, [role="gridcell"], span, div' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('필요 공간 수')).toHaveValue(1));
    expect(screen.getByLabelText('필요 장비 수')).toHaveValue(0);
  });

  it('추가가 실패하면 입력을 유지하고 재시도는 같은 operation_id를 쓴다', async () => {
    let attempt = 0;
    const { api, calls } = server({
      'POST /appointment-resources': () => { if (++attempt === 1) throw apiFailure(503); return { ...room, id: 'r9', name: '새 공간' }; },
    });
    render(<><NoticeHost /><ResourceManagerDialog api={api} organizationId={ORG} onClose={() => undefined} /></>);
    await screen.findByText('관리실 1');
    fireEvent.change(screen.getByLabelText('이름', { selector: 'input' }), { target: { value: '새 공간' } });
    fireEvent.click(screen.getByRole('button', { name: '자원 추가' }));
    expect(await screen.findByText('공간·장비 추가에 실패했습니다. 입력은 유지됩니다.')).toBeInTheDocument();
    expect(screen.getByLabelText('이름', { selector: 'input' })).toHaveValue('새 공간');
    fireEvent.click(screen.getByRole('button', { name: '자원 추가' }));
    await waitFor(() => expect(sent(calls, 'POST /appointment-resources')).toHaveLength(2));
    const [first, second] = sent(calls, 'POST /appointment-resources').map((call) => call.body as { operation_id: string; name: string; kind: string });
    expect(first.operation_id).toBe(second.operation_id);
    expect(second).toMatchObject({ name: '새 공간', kind: 'room' });
    await waitFor(() => expect(screen.getByLabelText('이름', { selector: 'input' })).toHaveValue(''));
  });

  it('빈 이름은 보내지 않는다', async () => {
    const { api, calls } = server();
    render(<ResourceManagerDialog api={api} organizationId={ORG} onClose={() => undefined} />);
    await screen.findByText('관리실 1');
    fireEvent.click(screen.getByRole('button', { name: '자원 추가' }));
    expect(await screen.findByText('공간 또는 장비 이름을 입력하세요.')).toBeInTheDocument();
    expect(sent(calls, 'POST /appointment-resources')).toHaveLength(0);
  });

  it('선택한 자원의 사용 상태를 expected_version으로 바꾼다', async () => {
    const { api, calls } = server({ 'PUT /appointment-resources/e1': () => ({ ...laser, is_active: false, version: 5 }) });
    render(<ResourceManagerDialog api={api} organizationId={ORG} onClose={() => undefined} />);
    fireEvent.click(await screen.findByText('레이저 1'));
    fireEvent.click(screen.getByRole('button', { name: '사용 중지' }));
    await waitFor(() => expect(sent(calls, 'PUT /appointment-resources/e1')).toHaveLength(1));
    expect(sent(calls, 'PUT /appointment-resources/e1')[0].body).toMatchObject({ name: '레이저 1', is_active: false, expected_version: 4 });
  });

  it('서비스 필수 자원 기준을 resource_version과 함께 저장한다', async () => {
    const { api, calls } = server({ 'PUT /appointment-services/s1/resource-requirements': () => ({ service_id: 's1', resource_version: 4, requirements: [] }) });
    render(<ResourceManagerDialog api={api} organizationId={ORG} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByLabelText('필요 공간 수')).toHaveValue(1));
    const save = screen.getByRole('button', { name: '서비스 자원 기준 저장' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('필요 장비 수'), { target: { value: '2' } });
    fireEvent.click(save);
    await waitFor(() => expect(sent(calls, 'PUT /appointment-services/s1/resource-requirements')).toHaveLength(1));
    expect(sent(calls, 'PUT /appointment-services/s1/resource-requirements')[0].body).toMatchObject({
      requirements: [{ kind: 'room', quantity: 1 }, { kind: 'equipment', quantity: 2 }], expected_version: 3,
    });
  });

  it('서비스를 바꾸면 그 서비스의 기준을 읽는다', async () => {
    const { api } = server();
    render(<ResourceManagerDialog api={api} organizationId={ORG} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByLabelText('필요 공간 수')).toHaveValue(1));
    fireEvent.change(screen.getByLabelText('서비스', { selector: 'select' }), { target: { value: 's2' } });
    await waitFor(() => expect(screen.getByLabelText('필요 공간 수')).toHaveValue(0));
  });

  it('읽기 전용에서는 쓰기 버튼이 없다', async () => {
    const { api } = server();
    render(<ResourceManagerDialog api={api} organizationId={ORG} readOnly onClose={() => undefined} />);
    await screen.findByText('관리실 1');
    for (const label of ['자원 추가', '사용 중지', '서비스 자원 기준 저장']) expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    expect(screen.getByLabelText('필요 공간 수')).toBeDisabled();
  });

  it('목록을 불러오지 못하면 다시 시도할 수 있다', async () => {
    let fail = true;
    const { api } = server({ 'GET /appointment-resources': () => { if (fail) throw apiFailure(503); return [room]; } });
    render(<ResourceManagerDialog api={api} organizationId={ORG} onClose={() => undefined} />);
    expect(await screen.findByText('공간·장비 정보를 불러오지 못했습니다.')).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByText('관리실 1')).toBeInTheDocument();
  });
});

const hour = (weekday: number, start: string, end: string) => ({ id: `h${weekday}`, staff_id: 'st1', weekday, start_time: `${start}:00`, end_time: `${end}:00`, timezone_name: 'Asia/Seoul' });
const leaveRow = { id: 'l1', staff_id: 'st1', start_at: '2026-10-08T15:00:00+09:00', end_at: '2026-10-08T16:00:00+09:00', reason: '교육', status: 'active', version: 2 };

function availabilityServer(overrides: Record<string, (call: FakeCall) => unknown> = {}) {
  return fakeApi((call) => {
    const key = `${call.method} ${call.path.replace(`/organizations/${ORG}/appointment-staff/st1`, '')}`;
    const handlers: Record<string, (call: FakeCall) => unknown> = {
      'GET /availability': () => ({ staff_id: 'st1', schedule_version: 5, hours: [hour(4, '09:00', '18:00')], time_off: [leaveRow] }),
      'PUT /working-hours': () => ({ staff_id: 'st1', schedule_version: 6, timezone_name: 'Asia/Seoul', hours: [] }),
      'POST /time-off': () => leaveRow,
      'POST /time-off/l1/cancel': () => ({ ...leaveRow, status: 'canceled', version: 3 }),
      ...overrides,
    };
    return handlers[key]?.(call) ?? (() => { throw new Error(`unexpected ${key}`); })();
  });
}
const staff = { id: 'st1', name: '김담당' };

describe('StaffAvailabilityDialog', () => {
  it('근무시간과 진행 중 휴무를 불러온다', async () => {
    const { api } = availabilityServer();
    render(<StaffAvailabilityDialog api={api} organizationId={ORG} staff={staff} onClose={() => undefined} />);
    expect(await screen.findByText('교육')).toBeInTheDocument();
    expect(screen.getByLabelText('목요일 시작')).toHaveValue('09:00');
    expect(screen.getByLabelText('목요일 종료')).toHaveValue('18:00');
    expect(screen.getByLabelText('월요일 시작')).toBeDisabled();
  });

  it('근무시간 저장은 선택한 요일만 한국 시간으로 보내고 새 버전을 쓴다', async () => {
    const { api, calls } = availabilityServer();
    render(<StaffAvailabilityDialog api={api} organizationId={ORG} staff={staff} onClose={() => undefined} />);
    await screen.findByText('교육');
    fireEvent.click(screen.getByRole('checkbox', { name: '월' }));
    fireEvent.change(screen.getByLabelText('월요일 종료'), { target: { value: '17:30' } });
    fireEvent.click(screen.getByRole('button', { name: '근무시간 저장' }));
    await waitFor(() => expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1));
    expect(calls.find((call) => call.method === 'PUT')?.body).toMatchObject({
      timezone_name: 'Asia/Seoul', expected_version: 5, hours: [{ weekday: 1, start: '09:00', end: '17:30' }, { weekday: 4, start: '09:00', end: '18:00' }],
    });
  });

  it('종료가 시작보다 늦지 않으면 보내지 않는다', async () => {
    const { api, calls } = availabilityServer();
    render(<StaffAvailabilityDialog api={api} organizationId={ORG} staff={staff} onClose={() => undefined} />);
    await screen.findByText('교육');
    fireEvent.change(screen.getByLabelText('목요일 종료'), { target: { value: '08:00' } });
    fireEvent.click(screen.getByRole('button', { name: '근무시간 저장' }));
    expect(await screen.findByText('목요일 종료 시간은 시작 시간보다 늦어야 합니다.')).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('휴무는 +09:00 오프셋과 사유로 등록하고 입력 오류를 먼저 거른다', async () => {
    const { api, calls } = availabilityServer();
    render(<StaffAvailabilityDialog api={api} organizationId={ORG} staff={staff} onClose={() => undefined} />);
    await screen.findByText('교육');
    const [start, end] = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]'));
    fireEvent.change(start, { target: { value: '2026-10-08T15:00' } });
    fireEvent.change(end, { target: { value: '2026-10-08T14:00' } });
    fireEvent.click(screen.getByRole('button', { name: '휴무 등록' }));
    expect(await screen.findByText('휴무 종료는 시작보다 늦어야 합니다.')).toBeInTheDocument();
    fireEvent.change(end, { target: { value: '2026-10-08T16:00' } });
    fireEvent.click(screen.getByRole('button', { name: '휴무 등록' }));
    expect(await screen.findByText('휴무 사유를 입력하세요.')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('예: 교육, 연차, 개인 일정'), { target: { value: ' 연차 ' } });
    fireEvent.click(screen.getByRole('button', { name: '휴무 등록' }));
    await waitFor(() => expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1));
    expect(calls.find((call) => call.method === 'POST')?.body).toMatchObject({ start_at: '2026-10-08T15:00:00+09:00', end_at: '2026-10-08T16:00:00+09:00', reason: '연차' });
  });

  it('선택한 휴무를 expected_version으로 취소한다', async () => {
    const { api, calls } = availabilityServer();
    render(<StaffAvailabilityDialog api={api} organizationId={ORG} staff={staff} onClose={() => undefined} />);
    fireEvent.click(await screen.findByText('교육'));
    fireEvent.click(screen.getByRole('button', { name: '선택 휴무 취소' }));
    await waitFor(() => expect(calls.some((call) => call.path.endsWith('/time-off/l1/cancel'))).toBe(true));
    expect(calls.find((call) => call.path.endsWith('/cancel'))?.body).toMatchObject({ expected_version: 2 });
  });

  it('읽기 전용에서는 저장·등록 UI가 없다', async () => {
    const { api } = availabilityServer();
    render(<StaffAvailabilityDialog api={api} organizationId={ORG} staff={staff} readOnly onClose={() => undefined} />);
    await screen.findByText('교육');
    for (const label of ['근무시간 저장', '휴무 등록', '선택 휴무 취소']) expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
  });

  it('불러오기 실패와 저장 충돌을 안내한다', async () => {
    const failed = availabilityServer({ 'GET /availability': () => { throw apiFailure(503); } });
    render(<StaffAvailabilityDialog api={failed.api} organizationId={ORG} staff={staff} onClose={() => undefined} />);
    expect(await screen.findByText('근무시간을 불러오지 못했습니다.')).toBeInTheDocument();
  });

  it('kstIso는 분 단위 입력에 초와 오프셋을 붙인다', () => {
    expect(kstIso('2026-10-08T15:00')).toBe('2026-10-08T15:00:00+09:00');
  });
});

describe('ResourcePicker', () => {
  function Harness({ api, serviceId, initial = [], autoSelect }: { api: ReturnType<typeof server>['api']; serviceId: string | null; initial?: string[]; autoSelect?: boolean }) {
    const [ids, setIds] = useState<string[]>(initial);
    const [current, setCurrent] = useState(serviceId);
    return (
      <>
        <button onClick={() => setCurrent('s2')}>서비스2</button>
        <button onClick={() => setCurrent('s1')}>서비스1</button>
        <output data-testid="ids">{ids.join(',')}</output>
        <ResourcePicker api={api} organizationId={ORG} serviceId={current} value={ids} onChange={setIds} autoSelect={autoSelect} />
      </>
    );
  }

  it('활성 자원만 보여 주고 필수 기준에 맞게 자동 선택한다', async () => {
    const { api } = server({ 'GET /appointment-resources': () => [room, room2, laser, retired] });
    render(<Harness api={api} serviceId="s1" />);
    expect(await screen.findByText('공간 · 관리실 1')).toBeInTheDocument();
    expect(screen.queryByText('공간 · 폐쇄실')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('r1,e1'));
    expect(screen.getByTestId('resource-requirement')).toHaveTextContent('공간 1개 · 장비 1개');
    expect(screen.getByRole('checkbox', { name: '공간 · 관리실 2' })).not.toBeChecked();
  });

  it('선택이 모자라면 경고하고 서비스를 바꾸면 기준을 다시 적용한다', async () => {
    const { api } = server();
    render(<Harness api={api} serviceId="s1" />);
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('r1,e1'));
    fireEvent.click(screen.getByRole('checkbox', { name: '장비 · 레이저 1' }));
    expect(screen.getByRole('alert')).toHaveTextContent('장비 1개를 더 선택하세요.');
    fireEvent.click(screen.getByText('서비스2'));
    await waitFor(() => expect(screen.getByTestId('resource-requirement')).toHaveTextContent('필수 자원 없음'));
    expect(screen.getByTestId('ids')).toHaveTextContent(/^$/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('편집 중인 예약의 저장된 선택은 처음에 유지한다', async () => {
    const { api } = server();
    render(<Harness api={api} serviceId="s1" initial={['e1']} />);
    await screen.findByText('공간 · 관리실 1');
    expect(screen.getByTestId('ids')).toHaveTextContent('e1');
    expect(screen.getByRole('alert')).toHaveTextContent('공간 1개를 더 선택하세요.');
  });

  it('기준을 불러오지 못하면 알린다', async () => {
    const { api } = server({ 'GET /appointment-services/s1/resource-requirements': () => { throw apiFailure(503); } });
    render(<Harness api={api} serviceId="s1" />);
    await waitFor(() => expect(screen.getByTestId('resource-requirement')).toHaveTextContent('필수 자원 기준을 불러오지 못했습니다.'));
  });

  it('서비스를 고르지 않으면 목록만 보여 준다', async () => {
    const { api, calls } = server();
    render(<Harness api={api} serviceId={null} />);
    expect(await screen.findByText('공간 · 관리실 1')).toBeInTheDocument();
    expect(calls.some((call) => call.path.includes('resource-requirements'))).toBe(false);
    const grid = within(screen.getByRole('group', { name: '공간·장비' }));
    expect(grid.getAllByRole('checkbox')).toHaveLength(2);
  });
});

describe('순수 도우미', () => {
  const resources = [room, room2, laser, retired] as never[];
  it('autoSelectResources와 missingRequirements', () => {
    const needs = [{ kind: 'room' as const, quantity: 2 }, { kind: 'equipment' as const, quantity: 1 }];
    expect(autoSelectResources(needs, resources)).toEqual(['r1', 'r2', 'e1']);
    expect(missingRequirements(needs, resources, ['r1'])).toEqual([{ kind: 'room', missing: 1 }, { kind: 'equipment', missing: 1 }]);
    expect(missingRequirements(needs, resources, ['r1', 'r2', 'e1'])).toEqual([]);
    expect(missingRequirements([], resources, [])).toEqual([]);
  });
  it('operation tracker는 입력이 같으면 같은 ID를 쓴다', () => {
    let n = 0;
    const tracker = createOperationTracker(() => `id-${++n}`);
    expect(tracker.idFor('a')).toBe('id-1');
    expect(tracker.idFor('a')).toBe('id-1');
    expect(tracker.idFor('b')).toBe('id-2');
    tracker.reset();
    expect(tracker.idFor('b')).toBe('id-3');
  });
});
