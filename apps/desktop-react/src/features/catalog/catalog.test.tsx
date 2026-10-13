import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NoticeHost, ConfirmDialog } from '@business-assistant/react-ui';
import { apiFailure, fakeApi, type FakeCall } from '../appointment-resources/testApi';
import { CustomerWalletDialog, InventoryPage, ServicePage, StaffPage, WalletUseDialog, toProductInput } from './index';

const ORG = 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const cream = { id: 'p1', organization_id: ORG, sku: 'SKU-1', name: '보습 크림', kind: 'product', unit_name: '개', sale_price: '30000', benefit_money: '0', benefit_count: 0, valid_days: null, is_active: true, version: 1, stock_quantity: 7 };
const pass = { id: 'p2', organization_id: ORG, sku: 'PASS-1', name: '10회 패키지', kind: 'membership', unit_name: '회', sale_price: '500000', benefit_money: '0', benefit_count: 10, valid_days: 365, is_active: true, version: 3, stock_quantity: 0 };

type Handlers = Record<string, (call: FakeCall) => unknown>;
function server(handlers: Handlers) {
  return fakeApi((call) => {
    const key = `${call.method} ${call.path.replace(`/organizations/${ORG}`, '')}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected ${key}`);
    return handler(call);
  });
}
const bodies = (calls: FakeCall[], key: string) => calls.filter((call) => `${call.method} ${call.path.replace(`/organizations/${ORG}`, '')}` === key).map((call) => call.body as Record<string, unknown>);
const renderInventory = (api: never, readOnly = false) => render(<><NoticeHost /><ConfirmDialog /><InventoryPage api={api} organizationId={ORG} readOnly={readOnly} /></>);
const field = (label: string) => screen.getByLabelText(label, { selector: 'input, select' });

describe('toProductInput', () => {
  const base = { kind: 'product' as const, sku: ' SKU ', name: ' 이름 ', unit_name: ' 개 ', sale_price: '1000', benefit_money: '0', benefit_count: '0', valid_days: '', is_active: true };
  it('상품은 혜택 필드를 0으로 고정하고 공백을 제거한다', () => {
    expect(toProductInput({ ...base, benefit_money: '99', benefit_count: '5', valid_days: '30' })).toEqual({ sku: 'SKU', name: '이름', kind: 'product', unit_name: '개', sale_price: '1000', benefit_money: '0', benefit_count: 0, valid_days: null, is_active: true });
  });
  it('판매가는 1원 이상의 정수 문자열이어야 한다', () => {
    for (const price of ['', '0', '1.5', '-1', 'abc', '1000000000000']) expect(toProductInput({ ...base, sale_price: price })).toBe('SKU, 이름, 단위와 1원 이상의 판매가를 확인하세요.');
    expect(toProductInput({ ...base, sku: ' ' })).toBe('SKU, 이름, 단위와 1원 이상의 판매가를 확인하세요.');
  });
  it('회원권은 혜택이 필요하고 유효 일수는 비우면 무제한이다', () => {
    const membership = { ...base, kind: 'membership' as const };
    expect(toProductInput(membership)).toBe('회원권은 제공 금액이나 제공 횟수가 필요합니다.');
    expect(toProductInput({ ...membership, benefit_money: '50000', valid_days: '' })).toMatchObject({ benefit_money: '50000', benefit_count: 0, valid_days: null });
    expect(toProductInput({ ...membership, benefit_count: '3', valid_days: '90' })).toMatchObject({ benefit_count: 3, valid_days: 90 });
    expect(toProductInput({ ...membership, benefit_count: '3', valid_days: '4000' })).toBe('유효 일수는 1~3650일이며 비우면 기간 제한이 없습니다.');
  });
});

describe('InventoryPage', () => {
  it('상품 목록을 보여 주고 검색과 구분 필터로 좁힌다', async () => {
    const { api } = server({ 'GET /catalog-products': () => [cream, pass] });
    renderInventory(api as never);
    expect(await screen.findByText('보습 크림')).toBeInTheDocument();
    expect(screen.getByText('30,000원')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('상품 검색'), { target: { value: 'pass' } });
    expect(screen.queryByText('보습 크림')).not.toBeInTheDocument();
    expect(screen.getByText('10회 패키지')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('상품 검색'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('구분 필터'), { target: { value: 'product' } });
    expect(screen.queryByText('10회 패키지')).not.toBeInTheDocument();
  });

  it('새 상품을 만들면 목록에 추가하고 멱등 키를 보낸다', async () => {
    const { api, calls } = server({ 'GET /catalog-products': () => [], 'POST /catalog-products': (call) => ({ ...cream, ...(call.body as object), id: 'new', version: 1, stock_quantity: 0 }) });
    renderInventory(api as never);
    await screen.findByText('등록된 상품과 회원권이 없습니다.');
    fireEvent.change(field('SKU'), { target: { value: 'SKU-1' } });
    fireEvent.change(field('이름'), { target: { value: '보습 크림' } });
    fireEvent.change(field('판매가'), { target: { value: '30000' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByText('보습 크림', { selector: '[role="gridcell"], td, span, div' })).toBeInTheDocument();
    const [body] = bodies(calls, 'POST /catalog-products');
    expect(body).toMatchObject({ sku: 'SKU-1', name: '보습 크림', kind: 'product', sale_price: '30000', unit_name: '개', is_active: true });
    expect(typeof body.operation_id).toBe('string');
    expect(body).not.toHaveProperty('expected_version');
    expect(screen.getAllByText('판매 조건을 저장했습니다.').length).toBeGreaterThan(0);
  });

  it('잘못된 입력은 서버로 보내지 않고 안내한다', async () => {
    const { api, calls } = server({ 'GET /catalog-products': () => [cream] });
    renderInventory(api as never);
    await screen.findByText('보습 크림');
    fireEvent.change(field('판매가'), { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByText('SKU, 이름, 단위와 1원 이상의 판매가를 확인하세요.')).toBeInTheDocument();
    expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
  });

  it('선택한 상품을 수정하면 expected_version을 보낸다', async () => {
    const { api, calls } = server({ 'GET /catalog-products': () => [cream], 'PUT /catalog-products/p1': (call) => ({ ...cream, ...(call.body as object), version: 2 }) });
    renderInventory(api as never);
    fireEvent.click(await screen.findByText('보습 크림'));
    expect(field('SKU')).toHaveValue('SKU-1');
    expect(field('종류')).toBeDisabled();
    fireEvent.change(field('이름'), { target: { value: '보습 크림 L' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(bodies(calls, 'PUT /catalog-products/p1')).toHaveLength(1));
    expect(bodies(calls, 'PUT /catalog-products/p1')[0]).toMatchObject({ name: '보습 크림 L', expected_version: 1 });
    expect(await screen.findByText('보습 크림 L', { selector: '[role="gridcell"], td, span, div' })).toBeInTheDocument();
  });

  it('결과를 모르는 실패 뒤 재시도는 같은 operation_id를 쓰고 충돌은 새로고침을 안내한다', async () => {
    let attempt = 0;
    const { api, calls } = server({
      'GET /catalog-products': () => [cream],
      'PUT /catalog-products/p1': () => { attempt += 1; if (attempt === 1) throw apiFailure(503); if (attempt === 2) throw apiFailure(409); return { ...cream, version: 2 }; },
    });
    renderInventory(api as never);
    fireEvent.click(await screen.findByText('보습 크림'));
    fireEvent.change(field('이름'), { target: { value: '변경' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByText(/결과를 확인하지 못했습니다/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByText('다른 변경과 충돌했습니다. 새로고침 후 다시 확인하세요.')).toBeInTheDocument();
    const sent = bodies(calls, 'PUT /catalog-products/p1');
    expect(sent[0].operation_id).toBe(sent[1].operation_id);
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(bodies(calls, 'PUT /catalog-products/p1')).toHaveLength(3));
    expect(bodies(calls, 'PUT /catalog-products/p1')[2].operation_id).not.toBe(sent[1].operation_id);
  });

  it('입고는 사유와 수량을 검증하고 재고를 갱신한다', async () => {
    const { api, calls } = server({ 'GET /catalog-products': () => [cream], 'POST /catalog-products/p1/stock-receipts': () => ({ ...cream, version: 2, stock_quantity: 10 }) });
    renderInventory(api as never);
    fireEvent.click(await screen.findByText('보습 크림'));
    fireEvent.change(screen.getByLabelText('수량'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: '선택 상품 입고' }));
    expect(await screen.findByText('실물 상품을 선택하고 입고 사유를 입력하세요.')).toBeInTheDocument();
    expect(bodies(calls, 'POST /catalog-products/p1/stock-receipts')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('수량 변경 사유'), { target: { value: ' 신규 입고 ' } });
    fireEvent.click(screen.getByRole('button', { name: '선택 상품 입고' }));
    await waitFor(() => expect(bodies(calls, 'POST /catalog-products/p1/stock-receipts')).toHaveLength(1));
    expect(bodies(calls, 'POST /catalog-products/p1/stock-receipts')[0]).toMatchObject({ quantity: 3, reason: '신규 입고' });
    expect(await screen.findByText('재고 · 현재 10개')).toBeInTheDocument();
  });

  it('재고 변동은 종류별 수량 규칙을 지키고 expected_version을 보낸다', async () => {
    const { api, calls } = server({ 'GET /catalog-products': () => [cream], 'POST /catalog-products/p1/stock-adjustments': (call) => ({ ...cream, version: 2, stock_quantity: (call.body as { quantity: number }).quantity }) });
    renderInventory(api as never);
    fireEvent.click(await screen.findByText('보습 크림'));
    fireEvent.change(screen.getByLabelText('수량 변경 사유'), { target: { value: '실사' } });
    fireEvent.change(screen.getByLabelText('수량'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: '재고 변동 기록' }));
    expect(await screen.findByText('실물 상품과 사유를 확인하세요. 반품·폐기 수량은 1개 이상이어야 합니다.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('변동 종류'), { target: { value: 'stocktake' } });
    fireEvent.click(screen.getByRole('button', { name: '재고 변동 기록' }));
    await waitFor(() => expect(bodies(calls, 'POST /catalog-products/p1/stock-adjustments')).toHaveLength(1));
    expect(bodies(calls, 'POST /catalog-products/p1/stock-adjustments')[0]).toMatchObject({ kind: 'stocktake', quantity: 0, reason: '실사', expected_version: 1 });
  });

  it('회원권에는 재고 영역이 없다', async () => {
    const { api } = server({ 'GET /catalog-products': () => [pass] });
    renderInventory(api as never);
    fireEvent.click(await screen.findByText('10회 패키지'));
    expect(field('제공 횟수')).toHaveValue(10);
    expect(screen.queryByRole('button', { name: '선택 상품 입고' })).not.toBeInTheDocument();
  });

  it('재고 변동 이력을 모달로 보여 준다', async () => {
    const movement = { id: 'm1', organization_id: ORG, product_id: 'p1', movement_kind: 'supplier_return', quantity: -2, reason: '거래처 반품', created_by: 'u1', created_at: '2026-10-08T01:30:00Z' };
    const { api } = server({ 'GET /catalog-products': () => [cream], 'GET /catalog-products/p1/stock-ledger': () => [movement] });
    renderInventory(api as never);
    fireEvent.click(await screen.findByText('보습 크림'));
    fireEvent.click(screen.getByRole('button', { name: '재고 변동 이력' }));
    const dialog = await screen.findByRole('dialog', { name: '보습 크림 · 재고 변동 이력' });
    const grid = within(within(dialog).getByRole('grid', { name: '재고 변동 이력' }));
    expect(grid.getAllByText('거래처 반품')).toHaveLength(2);
    expect(grid.getByText('-2 개')).toBeInTheDocument();
  });

  it('읽기 전용(member)은 저장·입고·변동 기록 UI가 없고 이력만 본다', async () => {
    const { api } = server({ 'GET /catalog-products': () => [cream] });
    renderInventory(api as never, true);
    fireEvent.click(await screen.findByText('보습 크림'));
    for (const label of ['저장', '새 상품', '선택 상품 입고', '재고 변동 기록']) expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    expect(field('SKU')).toBeDisabled();
    expect(screen.getByRole('button', { name: '재고 변동 이력' })).toBeEnabled();
  });

  it('권한 없음과 불러오기 실패를 구분해 안내한다', async () => {
    renderInventory(server({ 'GET /catalog-products': () => { throw apiFailure(403); } }).api as never);
    expect(await screen.findByText('상품·재고 권한이 없습니다.')).toBeInTheDocument();
    renderInventory(server({ 'GET /catalog-products': () => { throw apiFailure(503); } }).api as never);
    expect(await screen.findByText('상품과 회원권을 불러오지 못했습니다.')).toBeInTheDocument();
  });

  it('작성 중 다른 상품으로 이동하면 확인을 묻는다', async () => {
    const { api } = server({ 'GET /catalog-products': () => [cream, pass] });
    renderInventory(api as never);
    fireEvent.click(await screen.findByText('보습 크림'));
    fireEvent.change(field('이름'), { target: { value: '수정 중' } });
    fireEvent.click(screen.getByText('10회 패키지'));
    expect(await screen.findByText('저장하지 않은 내용을 버릴까요?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(field('이름')).toHaveValue('수정 중');
    fireEvent.click(screen.getByText('10회 패키지'));
    fireEvent.click(await screen.findByRole('button', { name: '버리기' }));
    await waitFor(() => expect(field('이름')).toHaveValue('10회 패키지'));
  });
});

const staffRow = { id: 'st1', organization_id: ORG, name: '김담당', is_active: true };
describe('StaffPage', () => {
  it('직원 목록, 추가, 근무시간 대화상자를 제공한다', async () => {
    const { api, calls } = server({
      'GET /appointment-staff': () => [staffRow],
      'POST /appointment-staff': (call) => ({ ...staffRow, id: 'st2', name: (call.body as { name: string }).name, schedule_version: 1 }),
      'GET /appointment-staff/st1/availability': () => ({ staff_id: 'st1', schedule_version: 1, hours: [], time_off: [] }),
    });
    render(<><NoticeHost /><ConfirmDialog /><StaffPage api={api as never} organizationId={ORG} readOnly={false} /></>);
    expect(await screen.findByText('김담당')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('새 직원 이름'), { target: { value: ' 박신입 ' } });
    fireEvent.click(screen.getByRole('button', { name: '직원 추가' }));
    expect(await screen.findByText('박신입')).toBeInTheDocument();
    expect(bodies(calls, 'POST /appointment-staff')[0]).toEqual({ name: '박신입' });
    fireEvent.click(screen.getByText('김담당'));
    fireEvent.click(screen.getByRole('button', { name: '근무시간·휴무' }));
    expect(await screen.findByRole('dialog', { name: '김담당 · 근무시간과 휴무' })).toBeInTheDocument();
  });

  it('빈 이름은 보내지 않고 읽기 전용에서는 추가 UI가 없다', async () => {
    const { api, calls } = server({ 'GET /appointment-staff': () => [staffRow] });
    const view = render(<StaffPage api={api as never} organizationId={ORG} readOnly={false} />);
    await screen.findByText('김담당');
    fireEvent.click(screen.getByRole('button', { name: '직원 추가' }));
    expect(await screen.findByText('직원 이름을 입력하세요.')).toBeInTheDocument();
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    view.unmount();
    render(<StaffPage api={api as never} organizationId={ORG} readOnly />);
    await screen.findByText('김담당');
    expect(screen.queryByRole('button', { name: '직원 추가' })).not.toBeInTheDocument();
  });

  it('목록 실패는 다시 시도할 수 있다', async () => {
    let fail = true;
    const { api } = server({ 'GET /appointment-staff': () => { if (fail) throw apiFailure(503); return [staffRow]; } });
    render(<StaffPage api={api as never} organizationId={ORG} readOnly={false} />);
    expect(await screen.findByText('직원 목록을 불러오지 못했습니다.')).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByText('김담당')).toBeInTheDocument();
  });
});

const serviceRow = { id: 's1', organization_id: ORG, name: '관리', duration_minutes: 60, buffer_minutes: 10, is_active: true, resource_version: 1, price_krw: 0, category: '', service_version: 1 };
describe('ServicePage', () => {
  it('서비스를 추가하고 입력 범위를 검사한다', async () => {
    const { api, calls } = server({ 'GET /appointment-service-details': () => [serviceRow], 'POST /appointment-services': (call) => ({ ...serviceRow, id: 's2', ...(call.body as object) }) });
    render(<><NoticeHost /><ServicePage api={api as never} organizationId={ORG} readOnly={false} /></>);
    expect(await screen.findByText('관리')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '서비스 추가' }));
    expect(await screen.findByText('서비스명을 입력하세요.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('서비스명'), { target: { value: '레이저' } });
    fireEvent.change(screen.getByLabelText('소요 시간(분)'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: '서비스 추가' }));
    expect(await screen.findByText('소요 시간은 5~480분이어야 합니다.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('소요 시간(분)'), { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: '서비스 추가' }));
    expect(await screen.findByText('레이저')).toBeInTheDocument();
    expect(bodies(calls, 'POST /appointment-services')[0]).toEqual({ name: '레이저', duration_minutes: 45, buffer_minutes: 10 });
  });

  it('읽기 전용에서는 추가 UI가 없고 공간·장비는 볼 수 있다', async () => {
    const { api } = server({ 'GET /appointment-service-details': () => [serviceRow], 'GET /appointment-resources': () => [], 'GET /appointment-services/s1/resource-setup': () => ({ service_id: 's1', resource_version: 1, requirements: [] }) });
    render(<ServicePage api={api as never} organizationId={ORG} readOnly />);
    await screen.findByText('관리');
    expect(screen.queryByRole('button', { name: '서비스 추가' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '공간·장비 관리' }));
    expect(await screen.findByRole('dialog', { name: '예약 공간·장비' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '자원 추가' })).not.toBeInTheDocument();
  });
});

const walletCell = (text: string) => within(screen.getByRole('grid', { name: '회원권 목록' })).getByText(text);
const wallet = {
  id: 'w1', organization_id: ORG, customer_id: 'c1', product_id: 'p2', sale_line_id: 'l1', name_snapshot: '10회 패키지', money_balance: '100000', count_balance: 4,
  valid_from: '2026-10-01', expires_on: '2026-12-31', lifecycle_status: 'active', lifecycle_version: 2,
  usage_history: [{ id: 'u1', visit_id: 'v1', sale_line_id: 'l2', mode: 'money', money_delta: '-5000', count_delta: 0, applied_amount: '5000', created_at: '2026-10-05T01:00:00Z' }],
};
describe('CustomerWalletDialog', () => {
  it('잔여 혜택과 사용 내역을 보여 주고 정지는 사유·버전과 함께 보낸다', async () => {
    let current = wallet;
    const { api, calls } = server({
      'GET /customers/c1/wallets': () => [current],
      'POST /customers/c1/wallets/w1/lifecycle': (call) => { current = { ...wallet, lifecycle_status: 'paused', lifecycle_version: 3 }; return { ...current, action: (call.body as { action: string }).action }; },
    });
    render(<><NoticeHost /><CustomerWalletDialog api={api} organizationId={ORG} customerId="c1" onClose={() => undefined} /></>);
    expect(await screen.findByText('100,000원')).toBeInTheDocument();
    expect(screen.getByText('4회')).toBeInTheDocument();
    expect(screen.getAllByText('5,000원').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '정지' })).toBeDisabled();
    fireEvent.click(walletCell('10회 패키지'));
    fireEvent.click(screen.getByRole('button', { name: '정지' }));
    fireEvent.click(screen.getByRole('button', { name: '변경 확인' }));
    expect(await screen.findByText('변경 사유를 입력하세요.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('변경 사유'), { target: { value: '고객 요청' } });
    fireEvent.click(screen.getByRole('button', { name: '변경 확인' }));
    await waitFor(() => expect(bodies(calls, 'POST /customers/c1/wallets/w1/lifecycle')).toHaveLength(1));
    expect(bodies(calls, 'POST /customers/c1/wallets/w1/lifecycle')[0]).toMatchObject({ action: 'pause', extend_days: null, reason: '고객 요청', expected_version: 2 });
    expect(await screen.findByText('정지', { selector: '[role="gridcell"], td, span, div' })).toBeInTheDocument();
  });

  it('기간 연장은 일수를 검사하고 만료일이 없는 회원권은 연장할 수 없다', async () => {
    const { api, calls } = server({ 'GET /customers/c1/wallets': () => [wallet, { ...wallet, id: 'w2', expires_on: null, name_snapshot: '무기한', usage_history: [] }], 'POST /customers/c1/wallets/w1/lifecycle': () => wallet });
    render(<CustomerWalletDialog api={api} organizationId={ORG} customerId="c1" onClose={() => undefined} />);
    await screen.findByText('무기한');
    fireEvent.click(walletCell('무기한'));
    expect(screen.getByRole('button', { name: '기간 연장' })).toBeDisabled();
    fireEvent.click(walletCell('10회 패키지'));
    fireEvent.click(screen.getByRole('button', { name: '기간 연장' }));
    fireEvent.change(screen.getByLabelText('연장할 일수'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('변경 사유'), { target: { value: '이벤트' } });
    fireEvent.click(screen.getByRole('button', { name: '변경 확인' }));
    expect(await screen.findByText('연장할 일수는 1~3650일이어야 합니다.')).toBeInTheDocument();
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('연장할 일수'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: '변경 확인' }));
    await waitFor(() => expect(bodies(calls, 'POST /customers/c1/wallets/w1/lifecycle')[0]).toMatchObject({ action: 'extend', extend_days: 30, reason: '이벤트' }));
  });

  it('읽기 전용에서는 변경 버튼이 없다', async () => {
    const { api } = server({ 'GET /customers/c1/wallets': () => [wallet] });
    render(<CustomerWalletDialog api={api} organizationId={ORG} customerId="c1" readOnly onClose={() => undefined} />);
    await screen.findByText('100,000원');
    for (const label of ['정지', '재개', '기간 연장']) expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
  });

  it('충돌과 불러오기 실패를 안내한다', async () => {
    const { api } = server({ 'GET /customers/c1/wallets': () => [wallet], 'POST /customers/c1/wallets/w1/lifecycle': () => { throw apiFailure(409); } });
    render(<CustomerWalletDialog api={api} organizationId={ORG} customerId="c1" onClose={() => undefined} />);
    await screen.findByText('100,000원');
    fireEvent.click(walletCell('10회 패키지'));
    fireEvent.click(screen.getByRole('button', { name: '정지' }));
    fireEvent.change(screen.getByLabelText('변경 사유'), { target: { value: '요청' } });
    fireEvent.click(screen.getByRole('button', { name: '변경 확인' }));
    expect(await screen.findByText('다른 변경과 충돌했습니다. 새로고침 후 다시 확인하세요.')).toBeInTheDocument();
    const failed = server({ 'GET /customers/c1/wallets': () => { throw apiFailure(503); } });
    render(<CustomerWalletDialog api={failed.api} organizationId={ORG} customerId="c1" onClose={() => undefined} />);
    expect(await screen.findByText('회원권을 불러오지 못했습니다. 잠시 후 다시 확인하세요.')).toBeInTheDocument();
  });
});

const bundle = {
  visit: { id: 'v1', status: 'open' }, cart: { id: 'cart1', version: 5 },
  lines: [
    { id: 'line1', status: 'active', source_type: 'treatment_draft', description_snapshot: '보습 관리', line_total: '60000' },
    { id: 'line2', status: 'voided', source_type: 'treatment_draft', description_snapshot: '취소된 줄', line_total: '1000' },
    { id: 'line3', status: 'active', source_type: 'catalog', description_snapshot: '크림', line_total: '30000' },
  ],
};
describe('WalletUseDialog', () => {
  const ready = (extra: Handlers = {}) => server({ 'GET /customers/c1/wallets': () => [wallet], ...extra });
  const open = (api: never, props: object = {}) => render(<><NoticeHost /><WalletUseDialog api={api} organizationId={ORG} customerId="c1" bundle={bundle as never} onClose={() => undefined} {...props} /></>);

  it('활성 시술 줄만 고를 수 있고 금액권은 잔액 안에서 확인 후 사용한다', async () => {
    const used: unknown[] = [];
    const { api, calls } = ready({ 'POST /visits/v1/wallet-usages': () => ({ visit_id: 'v1', cart_version: 6, outstanding_amount: '25000' }) });
    open(api as never, { onUsed: (result: unknown) => used.push(result) });
    await screen.findByText('100,000원');
    const lineSelect = screen.getByLabelText('적용 시술');
    expect(within(lineSelect).getAllByRole('option')).toHaveLength(1);
    expect(within(lineSelect).getByRole('option', { name: '보습 관리 · 60,000원' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '회원권 사용' }));
    expect(await screen.findByText('잔여 금액 안에서 사용할 원 단위 금액을 입력하세요.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('사용 금액'), { target: { value: '200000' } });
    fireEvent.click(screen.getByRole('button', { name: '회원권 사용' }));
    expect(await screen.findByText('잔여 금액 안에서 사용할 원 단위 금액을 입력하세요.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('사용 금액'), { target: { value: '35000' } });
    fireEvent.click(screen.getByRole('button', { name: '회원권 사용' }));
    expect(await screen.findByText('선택한 시술과 차감 혜택을 확인해 주세요.')).toBeInTheDocument();
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    fireEvent.click(screen.getByRole('checkbox', { name: '선택한 시술과 차감 혜택을 확인했습니다.' }));
    fireEvent.click(screen.getByRole('button', { name: '회원권 사용' }));
    await waitFor(() => expect(bodies(calls, 'POST /visits/v1/wallet-usages')).toHaveLength(1));
    expect(bodies(calls, 'POST /visits/v1/wallet-usages')[0]).toMatchObject({ wallet_id: 'w1', sale_line_id: 'line1', mode: 'money', amount: '35000', expected_cart_version: 5, confirmed: true });
    expect((await screen.findAllByText('회원권 사용을 기록했습니다. 남은 방문 금액은 25,000원입니다.')).length).toBeGreaterThan(0);
    expect(used).toHaveLength(1);
  });

  it('횟수권은 금액 없이 사용하고 다음 요청은 갱신된 장바구니 버전을 쓴다', async () => {
    const { api, calls } = ready({ 'POST /visits/v1/wallet-usages': () => ({ visit_id: 'v1', cart_version: 6, outstanding_amount: '0' }) });
    open(api as never);
    await screen.findByText('100,000원');
    fireEvent.change(screen.getByLabelText('사용 방식'), { target: { value: 'count' } });
    expect(screen.getByLabelText('사용 금액')).toBeDisabled();
    for (let round = 0; round < 2; round += 1) {
      fireEvent.click(screen.getByRole('checkbox', { name: '선택한 시술과 차감 혜택을 확인했습니다.' }));
      fireEvent.click(screen.getByRole('button', { name: '회원권 사용' }));
      await waitFor(() => expect(bodies(calls, 'POST /visits/v1/wallet-usages')).toHaveLength(round + 1));
      await screen.findAllByText(/회원권 사용을 기록했습니다/);
    }
    const sent = bodies(calls, 'POST /visits/v1/wallet-usages');
    expect(sent[0]).toMatchObject({ mode: 'count', amount: null, expected_cart_version: 5 });
    expect(sent[1]).toMatchObject({ expected_cart_version: 6 });
    expect(sent[0].operation_id).not.toBe(sent[1].operation_id);
  });

  it('정지된 회원권은 사용할 수 없고 결과를 모르는 실패의 재시도는 같은 operation_id다', async () => {
    let attempt = 0;
    const { api, calls } = server({
      'GET /customers/c1/wallets': () => [wallet],
      'POST /visits/v1/wallet-usages': () => { attempt += 1; if (attempt === 1) throw apiFailure(503); return { visit_id: 'v1', cart_version: 6 }; },
    });
    open(api as never);
    await screen.findByText('100,000원');
    fireEvent.change(screen.getByLabelText('사용 방식'), { target: { value: 'count' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '선택한 시술과 차감 혜택을 확인했습니다.' }));
    fireEvent.click(screen.getByRole('button', { name: '회원권 사용' }));
    expect(await screen.findByText(/사용 결과를 확인하지 못했습니다/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '회원권 사용' }));
    await waitFor(() => expect(bodies(calls, 'POST /visits/v1/wallet-usages')).toHaveLength(2));
    const [first, second] = bodies(calls, 'POST /visits/v1/wallet-usages');
    expect(first.operation_id).toBe(second.operation_id);
  });

  it('정지된 회원권 사용 시도는 서버로 보내지 않는다', async () => {
    const { api, calls } = server({ 'GET /customers/c1/wallets': () => [{ ...wallet, lifecycle_status: 'paused' }] });
    open(api as never);
    await screen.findByText('100,000원');
    fireEvent.change(screen.getByLabelText('사용 방식'), { target: { value: 'count' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '선택한 시술과 차감 혜택을 확인했습니다.' }));
    fireEvent.click(screen.getByRole('button', { name: '회원권 사용' }));
    expect(await screen.findByText('정지된 회원권입니다. 관리자에게 문의하세요.')).toBeInTheDocument();
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('서버가 거절하면 새로 확인하도록 안내하고 읽기 전용은 사용 버튼이 없다', async () => {
    const { api } = ready({ 'POST /visits/v1/wallet-usages': () => { throw apiFailure(409); } });
    open(api as never);
    await screen.findByText('100,000원');
    fireEvent.change(screen.getByLabelText('사용 금액'), { target: { value: '1000' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '선택한 시술과 차감 혜택을 확인했습니다.' }));
    fireEvent.click(screen.getByRole('button', { name: '회원권 사용' }));
    expect(await screen.findByText('회원권 사용이 거절되었습니다. 방문·잔액을 새로 확인해 주세요.')).toBeInTheDocument();
  });

  it('읽기 전용에서는 사용 버튼이 없다', async () => {
    const { api } = ready();
    open(api as never, { readOnly: true });
    await screen.findByText('100,000원');
    expect(screen.queryByRole('button', { name: '회원권 사용' })).not.toBeInTheDocument();
  });
});
