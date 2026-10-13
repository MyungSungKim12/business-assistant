import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from '@business-assistant/react-ui';
import { beforeEach, describe, expect, it } from 'vitest';
import { SalesPage } from './SalesPage';
import { CART, CUSTOMER, LINE, ORG, PRODUCT, VISIT, bundle, cartLine, conflict, draft, fakeApi, network, payments, uid, visit, type Call } from './testkit';

type Line = ReturnType<typeof cartLine>;

/** 장바구니 서버를 흉내 낸다: 담기·수정·할인·검토 완료를 처리하고 버전을 올린다. */
function cartServer(options: { visits?: unknown[]; failFirst?: { path: RegExp; error: Error } } = {}) {
  const state = { visits: options.visits ?? [], lines: [] as Line[], version: 1, status: 'draft', discount: { kind: 'none', value: '0', reason: '' }, failed: false };
  const current = () => {
    const active = state.lines.filter((line) => line.status === 'active');
    const subtotal = active.reduce((sum, line) => sum + Number(line.unit_price) * line.quantity, 0);
    const discountTotal = state.discount.kind === 'amount' ? Number(state.discount.value) : state.discount.kind === 'percent' ? Math.round(subtotal * Number(state.discount.value) / 100) : 0;
    return bundle({
      cart: { version: state.version, status: state.status, subtotal: subtotal.toFixed(2), discount_total: discountTotal.toFixed(2), total_amount: (subtotal - discountTotal).toFixed(2), discount_kind: state.discount.kind, discount_value: state.discount.value, discount_reason: state.discount.reason },
      lines: state.lines.map((line) => ({ ...line, line_total: (Number(line.unit_price) * line.quantity).toFixed(2) })),
    });
  };
  const bump = () => { state.version += 1; state.status = state.status === 'ready' ? 'draft' : state.status; return current(); };
  const guarded = (call: Call, run: () => unknown) => {
    if (options.failFirst && !state.failed && options.failFirst.path.test(call.path)) { state.failed = true; return options.failFirst.error; }
    return run();
  };
  const handlers = {
    'GET /visits': () => state.visits,
    'GET /sale-cart-drafts': () => [draft()],
    'POST /customers/:id/visits': (_b: unknown, call: Call) => guarded(call, () => { state.visits = [visit()]; return current(); }),
    'GET /visits/:id/sale-cart': () => current(),
    'POST /visits/:id/sale-cart/lines/treatment-draft': (_b: unknown, call: Call) => guarded(call, () => { state.lines.push(cartLine()); return bump(); }),
    'POST /visits/:id/sale-cart/lines/catalog-product': () => { state.lines.push(cartLine({ id: uid(5), source_type: 'product', source_id: PRODUCT, description_snapshot: '세럼', unit_price: '30000.00', quantity: 1 })); return bump(); },
    'PATCH /visits/:id/sale-cart/lines/:lid': (body: unknown) => { const b = body as { quantity: number; unit_price: string; staff_name: string }; state.lines = state.lines.map((line) => line.id === LINE ? { ...line, quantity: b.quantity, unit_price: b.unit_price, staff_name_snapshot: b.staff_name } : line); return bump(); },
    'POST /visits/:id/sale-cart/lines/:lid/remove': (body: unknown) => { state.lines = state.lines.map((line) => line.id === LINE ? { ...line, status: 'removed', removal_reason: (body as { reason: string }).reason } : line); return bump(); },
    'POST /visits/:id/sale-cart/discount': (body: unknown) => { const b = body as { kind: string; value: string; reason: string }; state.discount = { kind: b.kind, value: b.value, reason: b.reason }; return bump(); },
    'POST /visits/:id/sale-cart/review': () => { state.status = 'ready'; state.version += 1; return current(); },
    'POST /visits/:id/cancel': () => { state.visits = []; return { ...current(), visit: visit({ status: 'canceled' }) }; },
    'GET /visits/:id/payments': () => payments(),
  };
  return { state, handlers };
}

function setup(server = cartServer(), readOnly = false) {
  const kit = fakeApi(server.handlers as never);
  (kit.api as unknown as { listOperationRecords: (o: string, m: string) => Promise<unknown[]> }).listOperationRecords = async () => [
    { id: PRODUCT, name: '세럼', kind: 'product', sale_price: 30000, is_active: true, stock_quantity: 5, unit_name: '개' },
  ];
  const user = userEvent.setup();
  render(<><SalesPage api={kit.api} organizationId={ORG} readOnly={readOnly} /><ConfirmDialog /></>);
  return { ...kit, user, server };
}
const ready = async () => { await screen.findByText('김고객'); };

describe('SalesPage 방문 장바구니', () => {
  beforeEach(() => window.localStorage.clear());

  it('방문 시작 → 초안·상품 담기 → 수정 → 할인 → 검토 완료까지 구성한다', async () => {
    const { user, calls } = setup();
    await ready();
    await user.click(screen.getByRole('button', { name: /김고객/ }));
    expect((await screen.findAllByText(/열린 방문이 없습니다/)).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: '새 방문 시작' }));
    expect(await screen.findByText(/장바구니를 저장했습니다/)).toBeInTheDocument();
    const create = calls.find((call) => call.path.endsWith('/visits') && call.method === 'POST')!;
    expect(create.body).toMatchObject({ operation_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });

    await user.click(screen.getByRole('button', { name: '시술 초안 담기 보톡스 시술' }));
    await waitFor(() => expect(screen.getByTestId('subtotal')).toHaveTextContent('150,000원'));
    const add = calls.find((call) => call.path.endsWith('/treatment-draft'))!;
    expect(add.body).toMatchObject({ draft_id: expect.any(String), expected_version: 1 });
    await user.click(screen.getByRole('button', { name: '상품 담기 세럼' }));
    await waitFor(() => expect(screen.getByTestId('subtotal')).toHaveTextContent('180,000원'));
    expect(calls.find((call) => call.path.endsWith('/catalog-product'))!.body).toMatchObject({ product_id: PRODUCT, expected_version: 2 });

    await user.click(screen.getByRole('button', { name: '보톡스 시술' }));
    const editor = screen.getByLabelText('항목 편집');
    await user.clear(within(editor).getByLabelText('수량'));
    await user.type(within(editor).getByLabelText('수량'), '2');
    await user.clear(within(editor).getByLabelText('단가'));
    await user.type(within(editor).getByLabelText('단가'), '100000.50');
    await user.type(within(editor).getByLabelText('담당자'), '박원장');
    await user.click(screen.getByRole('button', { name: '항목 수정' }));
    await waitFor(() => expect(screen.getByTestId('subtotal')).toHaveTextContent('230,001원'));
    const patch = calls.find((call) => call.method === 'PATCH')!;
    expect(patch.body).toMatchObject({ quantity: 2, unit_price: '100000.50', staff_id: null, staff_name: '박원장', expected_version: 3 });

    const discount = screen.getByLabelText('수동 할인');
    await user.selectOptions(within(discount).getByLabelText('할인 종류'), 'percent');
    await user.type(within(discount).getByLabelText('할인 값'), '10');
    await user.type(within(discount).getByLabelText('할인 사유'), '첫 방문');
    await user.click(screen.getByRole('button', { name: '할인 적용' }));
    expect(await screen.findByText(/할인 규칙을 저장했습니다|확인 항목을 점검/)).toHaveTextContent('확인 항목을 점검');
    await user.click(within(discount).getByLabelText('할인 내용과 권한을 확인했습니다.'));
    await user.click(screen.getByRole('button', { name: '할인 적용' }));
    await waitFor(() => expect(screen.getByTestId('discount-summary')).toHaveTextContent('비율 10% · 첫 방문'));
    expect(calls.find((call) => call.path.endsWith('/discount'))!.body).toMatchObject({ kind: 'percent', value: '10', reason: '첫 방문', confirmed: true, expected_version: 4 });
    expect(screen.getByTestId('total')).toHaveTextContent('청구 예정 207,001원');

    await user.click(screen.getByRole('button', { name: '검토 완료' }));
    expect(await screen.findByText('장바구니 상태: 검토 완료')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '수납 기록 · 내역' })).toBeEnabled();
  });

  it('요청 결과가 불명확하면 같은 작업 ID로 재시도하고 화면 내용을 유지한다', async () => {
    const server = cartServer({ failFirst: { path: /\/visits$/, error: network() } });
    const { user, calls } = setup(server);
    await ready();
    await user.click(screen.getByRole('button', { name: /김고객/ }));
    await user.click(screen.getByRole('button', { name: '새 방문 시작' }));
    expect(await screen.findByText(/요청을 완료하지 못했습니다/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /김고객/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '같은 요청 재시도' }));
    expect(await screen.findByText(/장바구니를 저장했습니다/)).toBeInTheDocument();
    const creates = calls.filter((call) => call.method === 'POST' && call.path.endsWith('/visits'));
    expect(creates).toHaveLength(2);
    expect((creates[0].body as { operation_id: string }).operation_id).toBe((creates[1].body as { operation_id: string }).operation_id);
    expect(screen.queryByRole('button', { name: '같은 요청 재시도' })).not.toBeInTheDocument();
  });

  it('충돌(409)은 안내하고 재시도 대신 새로고침을 유도한다', async () => {
    const server = cartServer({ visits: [visit()], failFirst: { path: /treatment-draft/, error: conflict() } });
    const { user } = setup(server);
    await ready();
    await user.click(screen.getByRole('button', { name: /김고객/ }));
    await screen.findByTestId('subtotal');
    await user.click(screen.getByRole('button', { name: '시술 초안 담기 보톡스 시술' }));
    expect(await screen.findByText(/다른 변경과 충돌했습니다/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '같은 요청 재시도' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '시술 초안 담기 보톡스 시술' }));
    await waitFor(() => expect(screen.getByTestId('subtotal')).toHaveTextContent('150,000원'));
  });

  it('수정 중인 항목이 있으면 이동 전에 확인하고 취소하면 그대로 둔다', async () => {
    const server = cartServer({ visits: [visit()] });
    server.state.lines = [cartLine()];
    const { user } = setup(server);
    await ready();
    await user.click(screen.getByRole('button', { name: /김고객/ }));
    await user.click(await screen.findByRole('button', { name: '보톡스 시술' }));
    await user.type(within(screen.getByLabelText('항목 편집')).getByLabelText('담당자'), '박');
    await user.click(screen.getByRole('button', { name: /이고객/ }));
    expect(await screen.findByText('수정 중인 내용을 버리고 이동할까요?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '취소' }));
    expect(within(screen.getByLabelText('항목 편집')).getByLabelText('담당자')).toHaveValue('박');
    expect(screen.getByRole('button', { name: /김고객/ })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: /이고객/ }));
    await user.click(await screen.findByRole('button', { name: '버리기' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /이고객/ })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.queryByLabelText('항목 편집')).not.toBeInTheDocument();
  });

  it('제거 사유가 없으면 거절하고, 사유가 있으면 제거 후 제거 취소를 제공한다', async () => {
    const server = cartServer({ visits: [visit()] });
    server.state.lines = [cartLine()];
    const { user, calls } = setup(server);
    await ready();
    await user.click(screen.getByRole('button', { name: /김고객/ }));
    await user.click(await screen.findByRole('button', { name: '보톡스 시술' }));
    await user.click(screen.getByRole('button', { name: '항목 제거' }));
    expect(await screen.findByText('항목을 제거하려면 사유를 입력하세요.')).toBeInTheDocument();
    expect(calls.some((call) => call.path.endsWith('/remove'))).toBe(false);
    await user.type(within(screen.getByLabelText('항목 편집')).getByLabelText('제거 사유'), '중복');
    await user.click(screen.getByRole('button', { name: '항목 제거' }));
    await waitFor(() => expect(calls.some((call) => call.path.endsWith('/remove'))).toBe(true));
    expect(await screen.findByText('제거됨')).toBeInTheDocument();
  });

  it('빈 방문 취소는 확인을 받는다', async () => {
    const { user, calls } = setup(cartServer({ visits: [visit()] }));
    await ready();
    await user.click(screen.getByRole('button', { name: /김고객/ }));
    await screen.findByTestId('subtotal');
    await user.click(screen.getByRole('button', { name: '빈 방문 취소' }));
    await user.click(await screen.findByRole('button', { name: '방문 취소' }));
    await waitFor(() => expect(calls.find((call) => call.path.endsWith('/cancel'))!.body).toMatchObject({ expected_version: 1 }));
  });

  it('읽기 전용이면 변경 컨트롤을 숨기고 수납 내역 조회만 허용한다', async () => {
    const server = cartServer({ visits: [visit()] });
    server.state.lines = [cartLine()];
    server.state.status = 'ready';
    const { user } = setup(server, true);
    await ready();
    expect(screen.getByText(/조회 전용입니다/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /김고객/ }));
    await screen.findByTestId('subtotal');
    for (const name of ['새 방문 시작', '검토 완료', '할인 적용', '빈 방문 취소']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('수동 할인')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /담기/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '수납 기록 · 내역' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '수납 기록 · 내역' }));
    expect(await screen.findByTestId('payment-balance')).toHaveTextContent('미수 100,000원');
    expect(screen.queryByRole('button', { name: '수납 기록 저장' })).not.toBeInTheDocument();
  });

  it('고객 목록을 못 불러오면 오류와 재시도를 보여준다', async () => {
    const kit = fakeApi({});
    (kit.api as unknown as { listCustomers: () => Promise<never> }).listCustomers = async () => { throw network(); };
    render(<SalesPage api={kit.api} organizationId={ORG} readOnly={false} />);
    expect(await screen.findByText(/고객 목록을 불러오지 못했습니다/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeInTheDocument();
    expect(CUSTOMER).toBeTruthy();
    expect(VISIT).toBeTruthy();
    expect(CART).toBeTruthy();
  });
});
