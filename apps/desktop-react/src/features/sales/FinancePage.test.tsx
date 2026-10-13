import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from '@business-assistant/react-ui';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../api/errors';
import { FinancePage } from './FinancePage';
import { CUSTOMER, ORG, USER, fakeApi, network, uid, type Call } from './testkit';

const tx = (over: Record<string, unknown> = {}) => ({
  id: uid(1), organization_id: ORG, transaction_type: 'income', amount: '1234.50', transaction_date: '2030-01-10', category: '시술 매출', counterparty: 'Acme', memo: '', is_archived: false, ...over,
});
const summary = (over: Record<string, unknown> = {}) => ({ from_date: null, to_date: null, income_total: '1234.50', expense_total: '10.10', net_total: '1224.40', transaction_count: 2, ...over });
const closeData = (over: Record<string, unknown> = {}) => ({ id: uid(2), version: 1, expected_cash: '120000', counted_cash: '100000', variance: '-20000', reason: '시재 확인', closed_at: '2030-01-15T10:00:00Z', adjustments: [], ...over });
const settlement = (over: Record<string, unknown> = {}) => ({
  organization_id: ORG, business_date: '2030-01-15', cash_received: '120000', cash_refunded: '0', expected_cash: '120000', card_received: '50000', card_refunded: '0',
  transfer_received: '0', transfer_refunded: '0', receipt_count: 3, refund_count: 0,
  receivables: [{ cart_id: uid(3), visit_id: uid(4), customer_id: CUSTOMER, customer_name: '김고객', total_amount: '90000', received_amount: '40000', refunded_amount: '0', due_amount: '50000' }],
  is_closed: false, close: null, ...over,
});

function open(handlers: Record<string, (body: unknown, call: Call) => unknown>, readOnly = false) {
  const kit = fakeApi({ 'GET /finance-transactions': () => [tx(), tx({ id: uid(9), transaction_type: 'expense', amount: '10.10', category: '소모품' })], 'GET /finance-summary': () => summary(), ...handlers });
  const user = userEvent.setup();
  render(<><FinancePage api={kit.api} organizationId={ORG} readOnly={readOnly} /><ConfirmDialog /></>);
  return { ...kit, user };
}
const fill = async (user: ReturnType<typeof userEvent.setup>, label: string, value: string) => { await user.clear(screen.getByLabelText(label)); await user.type(screen.getByLabelText(label), value); };

describe('FinancePage 수입·지출', () => {
  beforeEach(() => window.localStorage.clear());

  it('거래 목록과 합계를 보여주고 기간·유형 필터를 서버에 전달한다', async () => {
    const { user, calls } = open({});
    expect(await screen.findByText('시술 매출')).toBeInTheDocument();
    const cards = screen.getByTestId('finance-summary');
    expect(cards).toHaveTextContent('수입 1,234.50원');
    expect(cards).toHaveTextContent('지출 10.10원');
    expect(cards).toHaveTextContent('순액 1,224.40원');
    await user.selectOptions(screen.getByLabelText('조회 유형'), 'expense');
    await user.type(screen.getByLabelText('시작일'), '2030-01-01');
    const ledgerCalls = () => calls.filter((call) => !call.path.startsWith('/finance-month-closings'));
    await waitFor(() => expect(ledgerCalls().at(-2)!.path).toBe('/finance-transactions?transaction_type=expense&from_date=2030-01-01'));
    expect(ledgerCalls().at(-1)!.path).toBe('/finance-summary?from_date=2030-01-01');
  });

  it('시작일이 종료일보다 늦으면 요청하지 않고 안내한다', async () => {
    const { user, calls } = open({});
    await screen.findByText('시술 매출');
    const before = calls.length;
    await user.type(screen.getByLabelText('시작일'), '2030-02-01');
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
    const count = calls.length;
    await user.type(screen.getByLabelText('종료일'), '2030-01-01');
    expect(await screen.findByText('조회 시작일은 종료일보다 늦을 수 없습니다.')).toBeInTheDocument();
    expect(calls.length).toBe(count);
  });

  it('조회 실패는 오류와 재시도를 보여주고 재시도하면 복구된다', async () => {
    let fail = true;
    const { user } = open({ 'GET /finance-transactions': () => { if (fail) return new ApiError(503, 'HTTP_503', 'x', true); return [tx()]; } });
    expect(await screen.findByText(/재무 내역을 불러오지 못했습니다/)).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByText('시술 매출')).toBeInTheDocument();
  });

  it('권한이 없으면(403) 권한 안내를 보여준다', async () => {
    open({ 'GET /finance-transactions': () => new ApiError(403, 'HTTP_403', 'denied', false) });
    expect(await screen.findByText(/재무 접근 권한이 없습니다/)).toBeInTheDocument();
  });

  it('등록은 입력을 검증하고 소수 금액을 문자열로 보낸 뒤 목록을 다시 읽는다', async () => {
    const created = tx({ id: uid(5), transaction_type: 'expense', amount: '25.50', category: '소모품' });
    const { user, calls } = open({ 'POST /finance-transactions': () => created });
    await screen.findByText('시술 매출');
    await user.click(screen.getByRole('button', { name: '등록' }));
    expect(await screen.findByText(/유형, 일자, 금액/)).toBeInTheDocument();
    await fill(user, '금액', '25.505');
    await fill(user, '분류', '소모품');
    await user.click(screen.getByRole('button', { name: '등록' }));
    expect(await screen.findByText(/유형, 일자, 금액/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('거래 유형'), 'expense');
    await fill(user, '금액', '25.50');
    await user.click(screen.getByRole('button', { name: '등록' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    expect(calls.find((call) => call.method === 'POST')!.body).toMatchObject({ transaction_type: 'expense', amount: '25.50', category: '소모품', is_archived: false });
    await waitFor(() => expect(screen.getByRole('button', { name: '등록' })).toBeInTheDocument());
    expect(calls.filter((call) => call.method === 'GET' && call.path.startsWith('/finance-transactions')).length).toBeGreaterThanOrEqual(2);
  });

  it('저장 실패 시 입력을 유지한다', async () => {
    const { user } = open({ 'POST /finance-transactions': () => network() });
    await screen.findByText('시술 매출');
    await fill(user, '금액', '100');
    await fill(user, '분류', '임대료');
    await user.click(screen.getByRole('button', { name: '등록' }));
    expect(await screen.findByText(/저장하지 못했습니다. 작성 내용은 유지됩니다/)).toBeInTheDocument();
    expect(screen.getByLabelText('금액')).toHaveValue('100');
    expect(screen.getByLabelText('분류')).toHaveValue('임대료');
  });

  it('선택한 거래를 수정·보관하고 변경 중 다른 거래로 이동하면 확인한다', async () => {
    const { user, calls } = open({
      'PATCH /finance-transactions/:id': (body) => tx({ ...(body as object) }),
    });
    await screen.findByText('시술 매출');
    await user.click(screen.getAllByRole('button', { name: '2030-01-10' })[0]);
    expect(screen.getByRole('heading', { name: '거래 수정' })).toBeInTheDocument();
    await fill(user, '분류', '수정 분류');
    await user.click(screen.getAllByRole('button', { name: '2030-01-10' })[1]);
    expect(await screen.findByText('저장하지 않은 변경 내용이 있습니다. 이동하시겠습니까?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '취소' }));
    expect(screen.getByLabelText('분류')).toHaveValue('수정 분류');
    await user.click(screen.getByRole('button', { name: '수정 저장' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    expect(calls.find((call) => call.method === 'PATCH')!.path).toBe(`/finance-transactions/${uid(1)}`);
    await user.click(await screen.findByRole('button', { name: '보관' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '보관' }));
    await waitFor(() => expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(2));
    expect(calls.filter((call) => call.method === 'PATCH')[1].body).toEqual({ is_archived: true });
  });

  it('읽기 전용에서는 등록 패널이 없다', async () => {
    open({}, true);
    await screen.findByText('시술 매출');
    expect(screen.queryByRole('button', { name: '등록' })).not.toBeInTheDocument();
    expect(screen.getByText(/조회 전용입니다/)).toBeInTheDocument();
  });
});

describe('FinancePage 미수·일 마감', () => {
  beforeEach(() => window.localStorage.clear());
  const goSettlement = async (user: ReturnType<typeof userEvent.setup>) => { await screen.findByText('시술 매출'); await user.click(screen.getByRole('tab', { name: '미수·일 마감' })); };

  it('결제수단별 합계와 미수 고객을 보여주고 마감 전 상태를 표시한다', async () => {
    const { user, calls } = open({ 'GET /sale-daily-settlement': () => settlement() });
    await goSettlement(user);
    expect(await screen.findByTestId('settlement-summary')).toHaveTextContent('현금 수납 120,000원 / 환불 0원');
    expect(screen.getByTestId('close-status')).toHaveTextContent('마감 전');
    expect(screen.getByRole('cell', { name: '50,000원' })).toBeInTheDocument();
    expect(calls.at(-1)!.path).toMatch(/^\/sale-daily-settlement\?business_date=\d{4}-\d{2}-\d{2}$/);
  });

  it('마감은 시재·사유 검증 후 확인을 받고 작업 ID와 함께 한 번 보낸다', async () => {
    const closed = settlement({ is_closed: true, close: closeData() });
    const { user, calls } = open({ 'GET /sale-daily-settlement': () => settlement(), 'POST /sale-daily-settlement/close': () => closed });
    await goSettlement(user);
    await screen.findByTestId('close-status');
    await user.click(screen.getByRole('button', { name: '마감 저장' }));
    expect(await screen.findByText(/실제 시재는 0원 이상의 정수/)).toBeInTheDocument();
    await fill(user, '실제 현금 시재', '1.5');
    await user.click(screen.getByRole('button', { name: '마감 저장' }));
    expect(await screen.findByText(/실제 시재는 0원 이상의 정수/)).toBeInTheDocument();
    await fill(user, '실제 현금 시재', '100000');
    await user.click(screen.getByRole('button', { name: '마감 저장' }));
    expect(await screen.findByText('마감 또는 정정 사유를 입력하세요.')).toBeInTheDocument();
    await fill(user, '사유', '시재 확인');
    await user.click(screen.getByRole('button', { name: '마감 저장' }));
    await user.click(await screen.findByRole('button', { name: '일 마감' }));
    await waitFor(() => expect(screen.getByTestId('close-status')).toHaveTextContent('마감 완료 · 정정 0회 · 차이 -20,000원'));
    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.path).toMatch(/^\/sale-daily-settlement\/close\?business_date=/);
    expect(post.body).toEqual({ operation_id: expect.stringMatching(/^[0-9a-f-]{36}$/), counted_cash: '100000', reason: '시재 확인', confirmed: true });
    expect(screen.getByRole('button', { name: '마감 정정' })).toBeInTheDocument();
  });

  it('마감 후 정정은 현재 버전을 expected_version으로 보낸다', async () => {
    const closed = settlement({ is_closed: true, close: closeData({ version: 3 }) });
    const adjusted = settlement({ is_closed: true, close: closeData({ version: 4, counted_cash: '90000', variance: '-30000', adjustments: [{ version: 4, previous_counted_cash: '100000', counted_cash: '90000', reason: '재확인', adjusted_at: '2030-01-16T00:00:00Z' }] }) });
    const { user, calls } = open({ 'GET /sale-daily-settlement': () => closed, 'POST /sale-daily-settlement/adjustments': () => adjusted });
    await goSettlement(user);
    await screen.findByTestId('close-status');
    expect(screen.getByLabelText('실제 현금 시재')).toHaveValue('100000');
    await fill(user, '실제 현금 시재', '90000');
    await fill(user, '사유', '재확인');
    await user.click(screen.getByRole('button', { name: '마감 정정' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '마감 정정' }));
    await waitFor(() => expect(screen.getByTestId('close-status')).toHaveTextContent('정정 3회'));
    expect(calls.find((call) => call.method === 'POST')!.body).toMatchObject({ expected_version: 3, counted_cash: '90000', reason: '재확인', confirmed: true });
    expect(screen.getByText('정정 이력 1건')).toBeInTheDocument();
  });

  it('결과가 불명확한 마감은 같은 내용으로 재시도할 때 같은 작업 ID를 쓴다', async () => {
    let attempts = 0;
    const { user, calls } = open({ 'GET /sale-daily-settlement': () => settlement(), 'POST /sale-daily-settlement/close': () => (++attempts === 1 ? network() : settlement({ is_closed: true, close: closeData() })) });
    await goSettlement(user);
    await screen.findByTestId('close-status');
    await fill(user, '실제 현금 시재', '100000');
    await fill(user, '사유', '시재 확인');
    for (let i = 0; i < 2; i += 1) {
      await user.click(screen.getByRole('button', { name: '마감 저장' }));
      await user.click(await screen.findByRole('button', { name: '일 마감' }));
      if (i === 0) expect(await screen.findByText(/저장 결과를 확인하지 못했습니다/)).toBeInTheDocument();
    }
    await waitFor(() => expect(screen.getByTestId('close-status')).toHaveTextContent('마감 완료'));
    const posts = calls.filter((call) => call.method === 'POST');
    expect((posts[0].body as { operation_id: string }).operation_id).toBe((posts[1].body as { operation_id: string }).operation_id);
  });

  it('읽기 전용에서는 마감 입력이 없고 조회 실패는 재시도를 제공한다', async () => {
    let fail = true;
    const { user } = open({ 'GET /sale-daily-settlement': () => (fail ? network() : settlement()) }, true);
    await goSettlement(user);
    expect(await screen.findByText(/정산 내역을 불러오지 못했습니다/)).toBeInTheDocument();
    fail = false;
    await user.click(screen.getAllByRole('button', { name: '다시 시도' }).at(-1)!);
    expect(await screen.findByTestId('close-status')).toBeInTheDocument();
    expect(screen.queryByLabelText('실제 현금 시재')).not.toBeInTheDocument();
    expect(USER).toBeTruthy();
    expect(within(screen.getByTestId('settlement-summary')).getByText(/예상 시재 120,000원/)).toBeInTheDocument();
  });
});

