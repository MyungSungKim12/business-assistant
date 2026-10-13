import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from '@business-assistant/react-ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentDialog, returnLimit } from './PaymentDialog';
import { ORG, VISIT, bundle, cartLine, conflict, fakeApi, network, payments, receipt, uid, type Call } from './testkit';
import type { CartLine } from './types';

const key = (kind: string) => `ba.sales.recovery.${kind}.${ORG}.${VISIT}`;
const productLine = (over: Record<string, unknown> = {}) => cartLine({ id: uid(5), source_type: 'product', description_snapshot: '세럼', quantity: 2, unit_price: '30000.00', line_total: '60000.00', ...over });

function open(handlers: Record<string, (body: unknown, call: Call) => unknown>, options: { canManage?: boolean; lines?: unknown[]; onClose?: (changed: boolean) => void } = {}) {
  const kit = fakeApi({ 'GET /visits/:id/payments': () => payments(), 'GET /visits/:id/sale-cart': () => bundle({ cart: { status: 'ready' }, lines: options.lines ?? [] }), ...handlers });
  const user = userEvent.setup();
  const onClose = options.onClose ?? vi.fn();
  render(<><PaymentDialog api={kit.api} organizationId={ORG} visitId={VISIT} canManage={options.canManage ?? true} onClose={onClose} /><ConfirmDialog /></>);
  return { ...kit, user, onClose };
}
const fill = async (user: ReturnType<typeof userEvent.setup>, label: string, value: string) => { await user.clear(screen.getByLabelText(label)); await user.type(screen.getByLabelText(label), value); };

describe('PaymentDialog 수납·환불·반품', () => {
  beforeEach(() => window.localStorage.clear());

  it('복합 수납을 한 번의 요청으로 기록하고 잔액·내역을 갱신한다', async () => {
    const paid = payments({ paid_amount: '100000', outstanding_amount: '0', status: 'paid', receipts: [receipt({ amount: '70000' }), receipt({ id: uid(9), method: 'cash', amount: '30000', reference: '' })] });
    const { user, calls } = open({ 'POST /visits/:id/payments': () => paid });
    expect(await screen.findByTestId('payment-balance')).toHaveTextContent('청구 100,000원 · 수납 0원 · 미수 100,000원');
    await fill(user, '카드 금액', '70000');
    await fill(user, '현금 금액', '30000');
    await user.click(screen.getByLabelText('위 금액을 실제로 받았음을 확인했습니다.'));
    await user.click(screen.getByRole('button', { name: '수납 기록 저장' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('카드 승인번호 또는 이체 식별번호가 필요합니다.');
    await fill(user, '카드 승인번호', 'approval-1');
    await user.click(screen.getByRole('button', { name: '수납 기록 저장' }));
    await waitFor(() => expect(screen.getByTestId('payment-balance')).toHaveTextContent('수납 100,000원 · 미수 0원'));
    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.body).toEqual({
      operation_id: expect.stringMatching(/^[0-9a-f-]{36}$/), expected_version: 3, confirmed: true,
      payments: [{ method: 'cash', amount: '30000', reference: '' }, { method: 'card', amount: '70000', reference: 'approval-1' }],
    });
    expect(window.localStorage.getItem(key('payment'))).toBeNull();
    expect(screen.getAllByRole('row').length).toBeGreaterThanOrEqual(3);
  });

  it.each([
    ['금액이 숫자가 아니면', { cash: '10.5' }, '금액은 0보다 큰 원 단위 숫자로 입력하세요.'],
    ['미수금을 넘으면', { cash: '100001' }, '입력한 수납액이 남은 미수금보다 큽니다.'],
    ['금액 없이 승인번호만 있으면', { card: '', cardRef: 'x' }, '확인 번호를 입력한 수단의 금액도 입력하세요.'],
  ])('%s 요청하지 않는다', async (_name, input, message) => {
    const { user, calls } = open({});
    await screen.findByTestId('payment-balance');
    if ('cash' in input) await fill(user, '현금 금액', input.cash as string);
    if ('cardRef' in input) await fill(user, '카드 승인번호', input.cardRef as string);
    await user.click(screen.getByLabelText('위 금액을 실제로 받았음을 확인했습니다.'));
    await user.click(screen.getByRole('button', { name: '수납 기록 저장' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('확인을 체크하지 않으면 거절한다', async () => {
    const { user, calls } = open({});
    await screen.findByTestId('payment-balance');
    await fill(user, '현금 금액', '1000');
    await user.click(screen.getByRole('button', { name: '수납 기록 저장' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('실제 수납 확인을 체크하세요');
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('결과가 불명확하면 요청을 보관하고 같은 작업 ID로 다시 확인한다', async () => {
    let attempts = 0;
    const paid = payments({ paid_amount: '1000', outstanding_amount: '99000', status: 'collecting', receipts: [receipt({ amount: '1000', method: 'cash', reference: '' })] });
    const { user, calls } = open({ 'POST /visits/:id/payments': () => (++attempts === 1 ? network() : paid) });
    await screen.findByTestId('payment-balance');
    await fill(user, '현금 금액', '1000');
    await user.click(screen.getByLabelText('위 금액을 실제로 받았음을 확인했습니다.'));
    await user.click(screen.getByRole('button', { name: '수납 기록 저장' }));
    expect(await screen.findByText(/수납 결과가 아직 확인되지 않았습니다/)).toBeInTheDocument();
    expect(window.localStorage.getItem(key('payment'))).not.toBeNull();
    expect(screen.getByLabelText('현금 금액')).toBeDisabled();
    expect(screen.getByRole('button', { name: '수납 기록 저장' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '미확인 수납 다시 확인' }));
    await waitFor(() => expect(screen.getByTestId('payment-balance')).toHaveTextContent('수납 1,000원'));
    const posts = calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(2);
    expect((posts[0].body as { operation_id: string }).operation_id).toBe((posts[1].body as { operation_id: string }).operation_id);
    expect(window.localStorage.getItem(key('payment'))).toBeNull();
  });

  it('다시 열었을 때 보관된 요청을 복원해 입력을 잠그고 같은 요청으로 확인한다', async () => {
    const op = uid(3);
    window.localStorage.setItem(key('payment'), JSON.stringify({ operation_id: op, expected_version: 3, confirmed: true, payments: [{ method: 'cash', amount: '2000', reference: '' }] }));
    const paid = payments({ paid_amount: '2000', outstanding_amount: '98000', status: 'collecting', receipts: [receipt({ amount: '2000', method: 'cash', reference: '' })] });
    const { user, calls } = open({ 'POST /visits/:id/payments': () => paid });
    await screen.findByTestId('payment-balance');
    expect(screen.getByLabelText('현금 금액')).toHaveValue('2000');
    expect(screen.getByLabelText('현금 금액')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '미확인 수납 다시 확인' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    expect((calls.find((call) => call.method === 'POST')!.body as { operation_id: string }).operation_id).toBe(op);
    await waitFor(() => expect(window.localStorage.getItem(key('payment'))).toBeNull());
  });

  it('손상된 복구 정보가 있으면 새 수납을 잠근다', async () => {
    window.localStorage.setItem(key('payment'), '{"broken":true}');
    open({});
    expect(await screen.findByText(/복구 정보를 읽을 수 없어 새 요청을 잠갔습니다/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '수납 기록 저장' })).toBeDisabled();
  });

  it('서버가 확정적으로 거절하면(409) 보관을 지우고 입력을 유지한다', async () => {
    const { user } = open({ 'POST /visits/:id/payments': () => conflict() });
    await screen.findByTestId('payment-balance');
    await fill(user, '현금 금액', '1000');
    await user.click(screen.getByLabelText('위 금액을 실제로 받았음을 확인했습니다.'));
    await user.click(screen.getByRole('button', { name: '수납 기록 저장' }));
    expect(await screen.findByText(/수납이 거절되었습니다/)).toBeInTheDocument();
    expect(window.localStorage.getItem(key('payment'))).toBeNull();
    expect(screen.getByLabelText('현금 금액')).toHaveValue('1000');
    expect(screen.getByRole('button', { name: '수납 기록 저장' })).toBeEnabled();
  });

  it('읽기 전용에서는 입력과 저장 버튼이 없다', async () => {
    open({}, { canManage: false });
    await screen.findByTestId('payment-balance');
    expect(screen.queryByRole('button', { name: '수납 기록 저장' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('현금 금액')).toBeDisabled();
  });

  it('작성 중인 입력이 있으면 닫기 전에 확인한다', async () => {
    const { user, onClose } = open({});
    await screen.findByTestId('payment-balance');
    await fill(user, '현금 금액', '500');
    await user.click(screen.getAllByRole('button', { name: '닫기' })[0]);
    expect(await screen.findByText('저장하지 않은 입력을 버릴까요?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '취소' }));
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getAllByRole('button', { name: '닫기' })[0]);
    await user.click(await screen.findByRole('button', { name: '버리기' }));
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('환불은 원거래 잔액 안에서만 허용하고 회원권 사용은 전체 취소만 허용한다', async () => {
    const snapshot = payments({ paid_amount: '60000', outstanding_amount: '40000', status: 'collecting', receipts: [receipt()] });
    const after = payments({ ...snapshot, paid_amount: '30000', outstanding_amount: '70000', refunded_amount: '30000', refunds: [{ id: uid(11), source_id: uid(7), source_kind: 'receipt', amount: '30000', reason: '고객 요청', created_at: '2030-01-02T00:00:00Z', operation_id: uid(12) }] });
    const { user, calls } = open({ 'GET /visits/:id/payments': () => snapshot, 'POST /visits/:id/payments/refunds': () => after });
    await screen.findByTestId('payment-balance');
    await user.click(screen.getByRole('tab', { name: '환불 · 사용 취소' }));
    await fill(user, '환불 금액', '70000');
    await fill(user, '환불 사유', '고객 요청');
    await user.click(screen.getByLabelText('외부 취소 여부와 환불 대상을 확인했습니다.'));
    await user.click(screen.getByRole('button', { name: '환불 기록' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('환불 가능 금액 안에서 입력하세요');
    await fill(user, '환불 금액', '30000');
    await user.click(screen.getByRole('button', { name: '환불 기록' }));
    await waitFor(() => expect(screen.getByTestId('payment-balance')).toHaveTextContent('수납 30,000원'));
    expect(calls.find((call) => call.path.endsWith('/refunds'))!.body).toEqual({ operation_id: expect.any(String), expected_version: 3, source_id: uid(7), amount: '30000', reason: '고객 요청', confirmed: true });
    expect(screen.getByText('환불 내역')).toBeInTheDocument();
  });

  it('회원권 사용(wallet) 환불은 부분 금액을 거절한다', async () => {
    const snapshot = payments({ paid_amount: '60000', outstanding_amount: '40000', status: 'collecting', receipts: [receipt({ method: 'wallet', reference: '' })] });
    const { user, calls } = open({ 'GET /visits/:id/payments': () => snapshot });
    await screen.findByTestId('payment-balance');
    await user.click(screen.getByRole('tab', { name: '환불 · 사용 취소' }));
    await fill(user, '환불 금액', '1000');
    await fill(user, '환불 사유', '취소');
    await user.click(screen.getByLabelText('외부 취소 여부와 환불 대상을 확인했습니다.'));
    await user.click(screen.getByRole('button', { name: '환불 기록' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('전체 취소만 가능합니다');
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('상품 반품은 수량·원결제·재입고 선택과 함께 한 번에 기록한다', async () => {
    const snapshot = payments({ total_amount: '60000', paid_amount: '60000', outstanding_amount: '0', status: 'paid', receipts: [receipt()] });
    const after = payments({ ...snapshot, paid_amount: '30000', outstanding_amount: '30000', refunded_amount: '30000', refunds: [{ id: uid(11), source_id: uid(7), source_kind: 'receipt', amount: '30000', reason: '미개봉', created_at: '2030-01-02T00:00:00Z', operation_id: uid(12) }] });
    const { user, calls } = open({ 'GET /visits/:id/payments': () => snapshot, 'POST /visits/:id/payments/product-returns': () => after }, { lines: [productLine()] });
    await screen.findByTestId('payment-balance');
    await user.click(screen.getByRole('tab', { name: '상품 반품' }));
    await fill(user, '반품 수량', '1');
    await fill(user, '환불 금액', '40000');
    await fill(user, '반품 사유', '미개봉');
    await user.click(screen.getByLabelText('반품 상품과 원결제 환불 처리, 실제 외부 취소 상태를 확인했습니다.'));
    await user.click(screen.getByRole('button', { name: '반품·환불 기록' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('점검하세요');
    await fill(user, '환불 금액', '30000');
    await user.click(screen.getByLabelText('반품 상품 재입고'));
    await user.click(screen.getByRole('button', { name: '반품·환불 기록' }));
    await waitFor(() => expect(calls.some((call) => call.path.endsWith('/product-returns'))).toBe(true));
    expect(calls.find((call) => call.path.endsWith('/product-returns'))!.body).toMatchObject({
      sale_line_id: uid(5), receipt_id: uid(7), quantity: 1, restock: false, amount: '30000', reason: '미개봉', expected_version: 3, confirmed: true,
    });
  });

  it('반품 한도는 할인 안분과 원 단위 반올림(half-up)을 따른다', () => {
    const line = (over: Record<string, unknown>) => productLine({ quantity: 3, unit_price: '10000.00', line_total: '30000.00', ...over }) as unknown as CartLine;
    expect(returnLimit(line({}), 1)).toBe(1000000n);
    // 3개 중 1개 반품, 할인 1000원 → 333.33 → 333원 안분
    expect(returnLimit(line({ discount_share: '1000' }), 1)).toBe(966700n);
    // 마지막 수량은 남은 할인 전부를 반영
    expect(returnLimit(line({ discount_share: '1000', returned_quantity: 2, returned_discount_amount: '667', returned_refund_amount: '19333' }), 1)).toBe(1000000n - 33300n);
    // 이미 환불한 금액이 있으면 남은 순판매가로 제한
    expect(returnLimit(line({ returned_refund_amount: '25000' }), 1)).toBe(500000n);
    // 0.5원 경계는 올림
    expect(returnLimit(line({ discount_share: '1', quantity: 2, unit_price: '5000.00', line_total: '10000.00' }), 1)).toBe(500000n - 100n);
  });
});
