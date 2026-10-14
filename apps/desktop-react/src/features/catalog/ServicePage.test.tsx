import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConfirmDialog, NoticeHost } from '@business-assistant/react-ui';
import { apiFailure } from '../appointment-resources/testApi';
import { ServicePage } from './index';
import { ORG, bodies, product, server, type Handlers } from './testServer';

const service = (over: Record<string, unknown> = {}) => ({
  id: 's1', organization_id: ORG, name: '관리', duration_minutes: 60, buffer_minutes: 10, is_active: true, resource_version: 1, price_krw: 50000, category: '피부', service_version: 2, ...over,
});
const details = 'GET /appointment-service-details';
const grid = () => within(screen.getByRole('grid', { name: '서비스 목록' }));
const renderPage = (handlers: Handlers, readOnly = false) => {
  const kit = server(handlers);
  render(<><NoticeHost /><ConfirmDialog /><ServicePage api={kit.api as never} organizationId={ORG} readOnly={readOnly} /></>);
  return kit;
};

describe('SVC-10 서비스 목록', () => {
  it('가격·카테고리 열을 보여 주고 검색·상태 필터로 좁힌다', async () => {
    renderPage({ [details]: () => [service(), service({ id: 's2', name: '바디 케어', category: '바디', price_krw: 0, is_active: false })] });
    expect(await screen.findByText('관리')).toBeInTheDocument();
    expect(grid().getByText('50,000원')).toBeInTheDocument();
    expect(grid().getByText('피부')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('서비스 상태 필터'), { target: { value: 'inactive' } });
    expect(screen.queryByText('관리')).not.toBeInTheDocument();
    expect(screen.getByText('바디 케어')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('서비스 상태 필터'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('서비스 검색'), { target: { value: '피부' } });
    expect(screen.queryByText('바디 케어')).not.toBeInTheDocument();
  });

  it('확장 경로가 없는 서버(404)에서는 기존 목록으로 대신 불러온다', async () => {
    const legacy = { id: 's1', organization_id: ORG, name: '관리', duration_minutes: 60, buffer_minutes: 10, is_active: true };
    renderPage({ [details]: () => { throw apiFailure(404); }, 'GET /appointment-services': () => [legacy] });
    expect(await screen.findByText('관리')).toBeInTheDocument();
    expect(grid().getByText('0원')).toBeInTheDocument();
  });

  it('불러오기 실패는 재시도할 수 있다', async () => {
    let fail = true;
    renderPage({ [details]: () => { if (fail) throw apiFailure(503); return [service()]; } });
    expect(await screen.findByText('서비스 목록을 불러오지 못했습니다.')).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByText('관리')).toBeInTheDocument();
  });
});

describe('SVC-10 서비스 수정·비활성', () => {
  it('행을 선택하면 편집 양식이 채워지고 저장은 service_version·멱등 키와 함께 PUT 한다', async () => {
    const { calls } = renderPage({ [details]: () => [service()], 'PUT /appointment-services/s1': (call) => ({ ...service(), ...(call.body as object), price_krw: 70000, service_version: 3 }) });
    fireEvent.click(await screen.findByText('관리'));
    expect(screen.getByLabelText('서비스명')).toHaveValue('관리');
    expect(screen.getByLabelText('가격(원)')).toHaveValue('50000');
    expect(screen.getByLabelText('카테고리')).toHaveValue('피부');
    fireEvent.change(screen.getByLabelText('가격(원)'), { target: { value: '70000' } });
    fireEvent.click(screen.getByRole('button', { name: '변경 저장' }));
    await waitFor(() => expect(bodies(calls, 'PUT /appointment-services/s1')).toHaveLength(1));
    const [body] = bodies(calls, 'PUT /appointment-services/s1');
    expect(body).toMatchObject({ name: '관리', price_krw: 70000, category: '피부', duration_minutes: 60, buffer_minutes: 10, is_active: true, expected_version: 2 });
    expect(typeof body.operation_id).toBe('string');
    expect(await grid().findByText('70,000원')).toBeInTheDocument();
  });

  it('잘못된 입력은 요청하지 않고 안내한다', async () => {
    const { calls } = renderPage({ [details]: () => [service()] });
    fireEvent.click(await screen.findByText('관리'));
    fireEvent.change(screen.getByLabelText('가격(원)'), { target: { value: '-5' } });
    fireEvent.click(screen.getByRole('button', { name: '변경 저장' }));
    expect(await screen.findByText('가격은 0원 이상의 정수(원 단위)여야 합니다.')).toBeInTheDocument();
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
  });

  it('비활성화는 확인을 거치고 취소하면 요청하지 않는다', async () => {
    const { calls } = renderPage({ [details]: () => [service()], 'PUT /appointment-services/s1': (call) => ({ ...service(), ...(call.body as object), service_version: 3 }) });
    fireEvent.click(await screen.findByText('관리'));
    fireEvent.click(screen.getByLabelText('예약에 사용 (끄면 새 예약에서 선택할 수 없음)'));
    fireEvent.click(screen.getByRole('button', { name: '변경 저장' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(/이미 잡힌 예약은 그대로 유지됩니다/)).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(bodies(calls, 'PUT /appointment-services/s1')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '변경 저장' }));
    fireEvent.click(await within(await screen.findByRole('dialog')).findByRole('button', { name: '중지' }));
    await waitFor(() => expect(bodies(calls, 'PUT /appointment-services/s1')).toHaveLength(1));
    expect(bodies(calls, 'PUT /appointment-services/s1')[0]).toMatchObject({ is_active: false, expected_version: 2 });
    expect(await grid().findByText('중지')).toBeInTheDocument();
  });

  it('중지된 서비스는 확인 없이 다시 사용으로 켤 수 있다', async () => {
    const { calls } = renderPage({ [details]: () => [service({ is_active: false })], 'PUT /appointment-services/s1': (call) => ({ ...service(), ...(call.body as object), service_version: 3 }) });
    fireEvent.click(await screen.findByText('관리'));
    fireEvent.click(screen.getByLabelText('예약에 사용 (끄면 새 예약에서 선택할 수 없음)'));
    fireEvent.click(screen.getByRole('button', { name: '변경 저장' }));
    await waitFor(() => expect(bodies(calls, 'PUT /appointment-services/s1')).toHaveLength(1));
    expect(bodies(calls, 'PUT /appointment-services/s1')[0]).toMatchObject({ is_active: true });
  });

  it('충돌(409)은 새로고침 안내를 보이고 입력은 유지한다', async () => {
    renderPage({ [details]: () => [service()], 'PUT /appointment-services/s1': () => { throw apiFailure(409); } });
    fireEvent.click(await screen.findByText('관리'));
    fireEvent.change(screen.getByLabelText('서비스명'), { target: { value: '관리 2' } });
    fireEvent.click(screen.getByRole('button', { name: '변경 저장' }));
    expect(await screen.findByText('다른 변경과 충돌했습니다. 목록을 새로고침한 뒤 다시 확인하세요.')).toBeInTheDocument();
    expect(screen.getByLabelText('서비스명')).toHaveValue('관리 2');
  });

  it('결과를 알 수 없는 실패 뒤 같은 내용으로 재시도하면 같은 operation_id를 쓴다', async () => {
    let fail = true;
    const { calls } = renderPage({
      [details]: () => [service()],
      'PUT /appointment-services/s1': (call) => { if (fail) throw apiFailure(503); return { ...service(), ...(call.body as object), service_version: 3 }; },
    });
    fireEvent.click(await screen.findByText('관리'));
    fireEvent.change(screen.getByLabelText('가격(원)'), { target: { value: '60000' } });
    fireEvent.click(screen.getByRole('button', { name: '변경 저장' }));
    expect(await screen.findByText(/결과를 확인하지 못했습니다/)).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '변경 저장' }));
    await waitFor(() => expect(bodies(calls, 'PUT /appointment-services/s1')).toHaveLength(2));
    const [first, second] = bodies(calls, 'PUT /appointment-services/s1');
    expect(second.operation_id).toBe(first.operation_id);
  });

  it('저장하지 않은 변경이 있으면 다른 행을 고를 때 확인한다', async () => {
    renderPage({ [details]: () => [service(), service({ id: 's2', name: '필링' })] });
    fireEvent.click(await screen.findByText('관리'));
    fireEvent.change(screen.getByLabelText('서비스명'), { target: { value: '수정 중' } });
    fireEvent.click(screen.getByText('필링'));
    fireEvent.click(await within(await screen.findByRole('dialog')).findByRole('button', { name: '버리기' }));
    await waitFor(() => expect(screen.getByLabelText('서비스명')).toHaveValue('필링'));
  });

  it('읽기 전용(member)은 편집 양식이 잠기고 저장·새 서비스 버튼이 없다', async () => {
    renderPage({ [details]: () => [service()] }, true);
    fireEvent.click(await screen.findByText('관리'));
    expect(screen.getByLabelText('서비스명')).toBeDisabled();
    expect(screen.getByLabelText('가격(원)')).toBeDisabled();
    expect(screen.queryByRole('button', { name: '변경 저장' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '새 서비스' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '필수 자원 기준' })).toBeEnabled();
  });
});

describe('TRT-11 서비스 소모품 기준', () => {
  it('선택한 서비스의 소모량을 불러와 저장하고 실패해도 입력을 보존한다', async () => {
    let rejectSave = true;
    const kit = renderPage({
      [details]: () => [service()],
      'GET /catalog-products': () => [product()],
      'GET /appointment-services/s1/consumables': () => [],
      'PUT /appointment-services/s1/consumables': (call) => {
        if (rejectSave) throw apiFailure(503);
        return (call.body as { items: unknown[] }).items;
      },
    });
    fireEvent.click(await screen.findByText('관리'));
    fireEvent.click(screen.getByRole('button', { name: '시술 소모품 기준' }));
    const dialog = await screen.findByRole('dialog', { name: '시술 소모품 기준' });
    fireEvent.change(within(dialog).getByLabelText('보습 크림 시술 소모량'), { target: { value: '2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '기준 저장' }));
    expect(await within(dialog).findByText('저장하지 못했습니다. 입력은 유지되며 다시 시도할 수 있습니다.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('보습 크림 시술 소모량')).toHaveValue(2);
    rejectSave = false;
    fireEvent.click(within(dialog).getByRole('button', { name: '기준 저장' }));
    await waitFor(() => expect(bodies(kit.calls, 'PUT /appointment-services/s1/consumables')).toHaveLength(2));
    expect(bodies(kit.calls, 'PUT /appointment-services/s1/consumables')[1]).toEqual({ items: [{ product_id: 'p1', quantity: 2 }] });
  });
});

describe('SVC-10 서비스 추가(가격·카테고리)', () => {
  it('생성 후 가격·카테고리를 이어서 저장하고 새 행을 선택한다', async () => {
    const created = service({ id: 's9', name: '레이저', price_krw: 0, category: '', service_version: 1 });
    const { calls } = renderPage({
      [details]: () => [],
      'POST /appointment-services': () => created,
      'PUT /appointment-services/s9': (call) => ({ ...created, ...(call.body as object), service_version: 2 }),
    });
    await screen.findByText('등록된 서비스가 없습니다.');
    fireEvent.change(screen.getByLabelText('서비스명'), { target: { value: '레이저' } });
    fireEvent.change(screen.getByLabelText('가격(원)'), { target: { value: '90000' } });
    fireEvent.change(screen.getByLabelText('카테고리'), { target: { value: '피부' } });
    fireEvent.click(screen.getByRole('button', { name: '서비스 추가' }));
    await waitFor(() => expect(bodies(calls, 'PUT /appointment-services/s9')).toHaveLength(1));
    expect(bodies(calls, 'POST /appointment-services')[0]).toEqual({ name: '레이저', duration_minutes: 60, buffer_minutes: 10 });
    expect(bodies(calls, 'PUT /appointment-services/s9')[0]).toMatchObject({ price_krw: 90000, category: '피부', expected_version: 1 });
    expect(await screen.findByRole('button', { name: '변경 저장' })).toBeInTheDocument();
  });

  it('생성은 됐지만 가격 저장이 실패하면 그 사실을 알리고 행을 선택해 둔다', async () => {
    const created = service({ id: 's9', name: '레이저', price_krw: 0, category: '', service_version: 1 });
    renderPage({ [details]: () => [], 'POST /appointment-services': () => created, 'PUT /appointment-services/s9': () => { throw apiFailure(422); } });
    await screen.findByText('등록된 서비스가 없습니다.');
    fireEvent.change(screen.getByLabelText('서비스명'), { target: { value: '레이저' } });
    fireEvent.change(screen.getByLabelText('가격(원)'), { target: { value: '90000' } });
    fireEvent.click(screen.getByRole('button', { name: '서비스 추가' }));
    expect(await screen.findByText('서비스는 추가했지만 가격·카테고리를 저장하지 못했습니다. 목록에서 선택해 다시 저장하세요.')).toBeInTheDocument();
    expect(grid().getByText('레이저')).toBeInTheDocument();
  });
});

describe('SVC-11 담당 가능 직원', () => {
  const staffRow = (id: string, name: string, over: Record<string, unknown> = {}) => ({ id, organization_id: ORG, name, is_active: true, schedule_version: 1, ...over });
  const staffA = '33333333-3333-4333-8333-333333333333';
  const staffB = '55555555-5555-4555-8555-555555555555';
  const base: Handlers = {
    [details]: () => [service()],
    'GET /appointment-staff': () => [staffRow(staffA, '김원장'), staffRow(staffB, '이실장')],
  };

  it('표에 담당 직원 요약이 보이고 지정이 없으면 모든 직원이다', async () => {
    renderPage({ ...base, 'GET /appointment-service-staff': () => [{ service_id: 's1', staff_id: staffA }] });
    expect(await screen.findByText('관리')).toBeInTheDocument();
    expect(await grid().findByText('김원장')).toBeInTheDocument();
  });

  it('지정이 없는 서비스는 모든 직원으로 보인다', async () => {
    renderPage({ ...base, 'GET /appointment-service-staff': () => [] });
    await screen.findByText('관리');
    expect(await grid().findByText('모든 직원')).toBeInTheDocument();
  });

  it('다이얼로그에서 직원을 골라 저장하면 정렬된 ID 배열을 PUT하고 목록을 다시 읽는다', async () => {
    let mapping: Array<{ service_id: string; staff_id: string }> = [];
    const kit = renderPage({
      ...base,
      'GET /appointment-service-staff': () => mapping,
      'GET /appointment-services/s1/staff': () => ({ staff_ids: [] }),
      'PUT /appointment-services/s1/staff': (call) => { const ids = (call.body as { staff_ids: string[] }).staff_ids; mapping = ids.map((id) => ({ service_id: 's1', staff_id: id })); return { staff_ids: ids }; },
    });
    fireEvent.click(await screen.findByText('관리'));
    fireEvent.click(screen.getByRole('button', { name: '담당 가능 직원' }));
    const dialog = await screen.findByRole('dialog', { name: /담당 가능 직원/ });
    expect(await within(dialog).findByText('현재: 모든 직원이 가능합니다.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '저장' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /이실장/ }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /김원장/ }));
    expect(within(dialog).getByText('현재: 2명만 가능합니다.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(bodies(kit.calls, 'PUT /appointment-services/s1/staff')).toEqual([{ staff_ids: [staffA, staffB].sort() }]));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /담당 가능 직원/ })).not.toBeInTheDocument());
    expect(await grid().findByText('김원장, 이실장')).toBeInTheDocument();
  });

  it('모두 해제하고 저장하면 빈 배열로 제한을 푼다', async () => {
    const kit = renderPage({
      ...base,
      'GET /appointment-service-staff': () => [{ service_id: 's1', staff_id: staffA }],
      'GET /appointment-services/s1/staff': () => ({ staff_ids: [staffA] }),
      'PUT /appointment-services/s1/staff': () => ({ staff_ids: [] }),
    });
    fireEvent.click(await screen.findByText('관리'));
    fireEvent.click(screen.getByRole('button', { name: '담당 가능 직원' }));
    const dialog = await screen.findByRole('dialog', { name: /담당 가능 직원/ });
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: /김원장/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(bodies(kit.calls, 'PUT /appointment-services/s1/staff')).toEqual([{ staff_ids: [] }]));
  });

  it('저장에 실패하면 선택을 유지하고 오류를 알린다', async () => {
    renderPage({
      ...base,
      'GET /appointment-service-staff': () => [],
      'GET /appointment-services/s1/staff': () => ({ staff_ids: [] }),
      'PUT /appointment-services/s1/staff': () => { throw apiFailure(503); },
    });
    fireEvent.click(await screen.findByText('관리'));
    fireEvent.click(screen.getByRole('button', { name: '담당 가능 직원' }));
    const dialog = await screen.findByRole('dialog', { name: /담당 가능 직원/ });
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: /김원장/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: '저장' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('저장하지 못했습니다');
    expect(within(dialog).getByRole('checkbox', { name: /김원장/ })).toBeChecked();
  });

  it('조회 전용이면 체크박스를 바꿀 수 없고 저장 버튼이 없다', async () => {
    renderPage({ ...base, 'GET /appointment-service-staff': () => [], 'GET /appointment-services/s1/staff': () => ({ staff_ids: [staffA] }) }, true);
    fireEvent.click(await screen.findByText('관리'));
    fireEvent.click(screen.getByRole('button', { name: '담당 가능 직원' }));
    const dialog = await screen.findByRole('dialog', { name: /담당 가능 직원/ });
    expect(await within(dialog).findByRole('checkbox', { name: /김원장/ })).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: '저장' })).not.toBeInTheDocument();
  });
});
