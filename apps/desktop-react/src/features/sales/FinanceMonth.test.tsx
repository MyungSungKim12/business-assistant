import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog, NoticeHost } from '@business-assistant/react-ui';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../api/errors';
import { FinancePage } from './FinancePage';
import { ORG, USER, fakeApi, uid, type Call } from './testkit';

const tx = (n: number, over: Record<string, unknown> = {}) => ({
  id: uid(n), organization_id: ORG, transaction_type: 'income', amount: '100000', transaction_date: '2030-01-10', category: '시술 매출', counterparty: '', memo: '', is_archived: false, ...over,
});
const closing = (over: Record<string, unknown> = {}) => ({
  id: uid(50), organization_id: ORG, month: '2030-01-01', note: '1월 결산', closed_by: USER, closed_at: '2030-02-01T01:00:00Z', reopened_by: null, reopened_at: null, reopen_reason: null, ...over,
});
const pastClosing = (over: Record<string, unknown> = {}) => closing({ month: '2020-01-01', ...over });
const summary = (over: Record<string, unknown> = {}) => ({ from_date: '2030-01-01', to_date: '2030-01-31', income_total: '300000', expense_total: '120000', net_total: '180000', transaction_count: 5, ...over });
type Handlers = Record<string, (body: unknown, call: Call) => unknown>;

function open(handlers: Handlers = {}, readOnly = false) {
  const kit = fakeApi({
    'GET /finance-transactions': () => [
      tx(1, { amount: '300000', category: '시술 매출', memo: '보톡스' }),
      tx(2, { transaction_type: 'expense', amount: '50000', category: '소모품', counterparty: '쿠팡', memo: '세럼', transaction_date: '2030-01-12' }),
      tx(3, { transaction_type: 'expense', amount: '70000', category: '임대료', counterparty: '건물주', transaction_date: '2030-01-05' }),
      tx(4, { amount: '99999', category: '보관 거래', is_archived: true }),
    ],
    'GET /finance-summary': () => summary(),
    'GET /finance-month-closings': () => [],
    ...handlers,
  });
  const user = userEvent.setup();
  render(<><FinancePage api={kit.api} organizationId={ORG} readOnly={readOnly} /><ConfirmDialog /><NoticeHost /></>);
  return { ...kit, user };
}
const dateColumn = () => within(screen.getByRole('table', { name: '거래 내역' })).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[0].textContent);

describe('수입·지출 검색·정렬·합계', () => {
  beforeEach(() => window.localStorage.clear());

  it('분류·거래처·메모로 검색하면 목록과 합계가 함께 줄어든다', async () => {
    const { user } = open();
    await screen.findByText('시술 매출');
    expect(screen.getByTestId('ledger-visible-totals')).toHaveTextContent('표시 중인 거래 합계(보관 제외)');
    expect(screen.getByTestId('ledger-visible-totals')).toHaveTextContent('수입 300,000원 (1건)');
    expect(screen.getByTestId('ledger-visible-totals')).toHaveTextContent('지출 120,000원 (2건)');
    expect(screen.getByTestId('ledger-visible-totals')).toHaveTextContent('순액 180,000원');
    await user.type(screen.getByLabelText('거래 검색'), '세럼');
    expect(screen.queryByText('시술 매출')).not.toBeInTheDocument();
    expect(screen.getByText('소모품')).toBeInTheDocument();
    expect(screen.getByTestId('ledger-visible-totals')).toHaveTextContent('검색 결과 합계(보관 제외)');
    expect(screen.getByTestId('ledger-visible-totals')).toHaveTextContent('지출 50,000원 (1건)');
    await user.clear(screen.getByLabelText('거래 검색'));
    await user.type(screen.getByLabelText('거래 검색'), '없는말');
    expect(await screen.findByText('검색 조건에 맞는 거래가 없습니다.')).toBeInTheDocument();
  });

  it('머리글을 눌러 정렬하고 다시 누르면 방향이 바뀐다', async () => {
    const { user } = open();
    await screen.findByText('시술 매출');
    expect(dateColumn()).toEqual(['2030-01-12', '2030-01-10', '2030-01-10', '2030-01-05']);
    await user.click(screen.getByRole('button', { name: /^거래일/ }));
    expect(dateColumn()[0]).toBe('2030-01-05');
    await user.click(screen.getByRole('button', { name: '금액' }));
    const amounts = within(screen.getByRole('table', { name: '거래 내역' })).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[2].textContent);
    expect(amounts).toEqual(['300,000원', '99,999원', '70,000원', '50,000원']);
    await user.click(screen.getByRole('button', { name: /^금액/ }));
    expect(within(screen.getByRole('table', { name: '거래 내역' })).getAllByRole('row')[1]).toHaveTextContent('50,000원');
    expect(screen.getByRole('columnheader', { name: /금액/ })).toHaveAttribute('aria-sort', 'ascending');
  });

  it('분류별 합계는 보관 거래를 빼고 펼쳐서 볼 수 있다', async () => {
    const { user } = open();
    await screen.findByText('시술 매출');
    expect(screen.queryByRole('table', { name: '분류별 합계' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /분류별 합계 보기 \(3개\)/ }));
    const table = screen.getByRole('table', { name: '분류별 합계' });
    expect(within(table).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[0].textContent)).toEqual(['시술 매출', '임대료', '소모품']);
    expect(within(table).queryByText('보관 거래')).not.toBeInTheDocument();
  });
});

describe('월 마감된 달의 거래', () => {
  beforeEach(() => window.localStorage.clear());

  it('마감된 달의 거래를 고르면 안내하고 수정·보관을 막는다', async () => {
    const { user } = open({ 'GET /finance-month-closings': () => [closing()] });
    await screen.findByText('시술 매출');
    expect(screen.queryByTestId('closed-month-notice')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('월 마감').length).toBeGreaterThan(1));
    await user.click(screen.getAllByRole('button', { name: '2030-01-12' })[0]);
    expect(screen.getByTestId('closed-month-notice')).toHaveTextContent('2030-01은(는) 월 마감된 달');
    expect(screen.getByRole('button', { name: '수정 저장' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '보관' })).toBeDisabled();
  });

  it('마감된 달의 날짜로 새 거래를 입력하면 안내하고 등록을 막는다', async () => {
    const { user } = open({ 'GET /finance-month-closings': () => [closing()] });
    await screen.findByText('시술 매출');
    fireEvent.change(screen.getByLabelText('거래 일자'), { target: { value: '2030-01-20' } });
    expect(await screen.findByTestId('closed-month-notice')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '등록' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('거래 일자'), { target: { value: '2030-02-20' } });
    expect(screen.queryByTestId('closed-month-notice')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '등록' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '등록' }));
  });

  it('재오픈된 마감은 막지 않는다', async () => {
    open({ 'GET /finance-month-closings': () => [closing({ reopened_at: '2030-02-03T00:00:00Z', reopened_by: USER, reopen_reason: '정정' })] });
    await screen.findByText('시술 매출');
    fireEvent.change(screen.getByLabelText('거래 일자'), { target: { value: '2030-01-20' } });
    expect(screen.queryByTestId('closed-month-notice')).not.toBeInTheDocument();
  });

  it('서버가 마감 오류(409)를 주면 서버 안내 문구를 그대로 보여 주고 목록을 다시 읽는다', async () => {
    const message = '마감된 달의 거래는 등록·수정(보관 포함)할 수 없습니다. 관리자가 월 마감을 재오픈한 뒤 다시 시도하세요.';
    const { user, calls } = open({ 'POST /finance-transactions': () => new ApiError(409, 'FINANCE_MONTH_CLOSED', message, false) });
    await screen.findByText('시술 매출');
    await user.type(screen.getByLabelText('금액'), '1000');
    await user.type(screen.getByLabelText('분류'), '기타');
    await user.click(screen.getByRole('button', { name: '등록' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    await waitFor(() => expect(calls.filter((call) => call.path === '/finance-month-closings').length).toBeGreaterThanOrEqual(2));
  });

  it('다른 409는 기존 충돌 안내를 쓴다', async () => {
    const { user } = open({ 'POST /finance-transactions': () => new ApiError(409, 'HTTP_409', 'Record conflict', false) });
    await screen.findByText('시술 매출');
    await user.type(screen.getByLabelText('금액'), '1000');
    await user.type(screen.getByLabelText('분류'), '기타');
    await user.click(screen.getByRole('button', { name: '등록' }));
    expect(await screen.findByText(/다른 변경과 충돌했습니다/)).toBeInTheDocument();
  });
});

describe('월 마감 탭', () => {
  beforeEach(() => window.localStorage.clear());

  async function openMonth(handlers: Handlers = {}, readOnly = false, month = '2020-01') {
    const kit = open(handlers, readOnly);
    await screen.findByText('시술 매출');
    await kit.user.click(screen.getByRole('tab', { name: '월 마감' }));
    await screen.findByLabelText('마감 월');
    fireEvent.change(screen.getByLabelText('마감 월'), { target: { value: month } });
    return kit;
  }
  const confirmWith = async (user: ReturnType<typeof userEvent.setup>, label: string) => {
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: label }));
  };

  it('선택한 달의 수입·지출·순액·건수를 보여 주고 열림 상태를 알린다', async () => {
    const { calls } = await openMonth();
    await waitFor(() => expect(screen.getByTestId('month-summary')).toHaveTextContent('수입 300,000원'));
    expect(screen.getByTestId('month-summary')).toHaveTextContent('지출 120,000원');
    expect(screen.getByTestId('month-summary')).toHaveTextContent('순액 180,000원');
    expect(screen.getByTestId('month-summary')).toHaveTextContent('거래 5건');
    expect(screen.getByTestId('month-status')).toHaveTextContent('2020-01 열림(마감 전)');
    expect(calls.some((call) => call.path === '/finance-summary?from_date=2020-01-01&to_date=2020-01-31')).toBe(true);
    expect(screen.getByText(/일 마감’과는 별개|일 마감\)?과는 별개/)).toBeInTheDocument();
  });

  it('마감 메모를 요구하고 확인 뒤 달의 첫날로 마감한다', async () => {
    let closed = false;
    const { user, calls } = await openMonth({
      'GET /finance-month-closings': () => (closed ? [pastClosing()] : []),
      'POST /finance-month-closings': () => { closed = true; return pastClosing(); },
    });
    await screen.findByTestId('month-status');
    await user.click(screen.getByTestId('month-close-submit'));
    expect(await screen.findByText('마감 메모를 입력하세요(1,000자 이하).')).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    await user.type(screen.getByLabelText('마감 메모'), '  1월 결산 확인  ');
    await user.click(screen.getByTestId('month-close-submit'));
    await confirmWith(user, '월 마감');
    await waitFor(() => expect(screen.getByTestId('month-status')).toHaveTextContent('2020-01 마감됨'));
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({ month: '2020-01-01', note: '1월 결산 확인' });
    expect(await screen.findByText('2020-01 장부를 마감했습니다.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '월 마감 재오픈' })).toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: '월 마감 이력' })).getByText('마감')).toBeInTheDocument();
  });

  it('확인 창에서 취소하면 요청하지 않는다', async () => {
    const { user, calls } = await openMonth();
    await screen.findByTestId('month-status');
    await user.type(screen.getByLabelText('마감 메모'), '메모');
    await user.click(screen.getByTestId('month-close-submit'));
    await confirmWith(user, '취소');
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('마감된 달은 사유를 받아 재오픈하고 이력에 남긴다', async () => {
    let reopened = false;
    const { user, calls } = await openMonth({
      'GET /finance-month-closings': () => [reopened ? pastClosing({ reopened_at: '2030-02-03T00:00:00Z', reopened_by: USER, reopen_reason: '세금계산서 정정' }) : pastClosing()],
      'POST /finance-month-closings/:month/reopen': () => { reopened = true; return pastClosing({ reopened_at: '2030-02-03T00:00:00Z', reopened_by: USER, reopen_reason: '세금계산서 정정' }); },
    });
    await waitFor(() => expect(screen.getByTestId('month-status')).toHaveTextContent('2020-01 마감됨'));
    await user.click(screen.getByRole('button', { name: '월 마감 재오픈' }));
    expect(await screen.findByText('재오픈 사유를 입력하세요(1,000자 이하).')).toBeInTheDocument();
    await user.type(screen.getByLabelText('재오픈 사유'), '세금계산서 정정');
    await user.click(screen.getByRole('button', { name: '월 마감 재오픈' }));
    await confirmWith(user, '재오픈');
    await waitFor(() => expect(screen.getByTestId('month-status')).toHaveTextContent('2020-01 열림(마감 전)'));
    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.path).toBe('/finance-month-closings/2020-01-01/reopen');
    expect(post.body).toEqual({ reason: '세금계산서 정정' });
    expect(within(screen.getByRole('table', { name: '월 마감 이력' })).getByText('재오픈됨')).toBeInTheDocument();
  });

  it('서버가 이미 마감됨(409)을 알리면 안내 문구를 보여 주고 상태를 다시 읽는다', async () => {
    const detail = '이미 마감된 달입니다. 화면을 새로고침해 마감 상태를 확인하세요.';
    const { user, calls } = await openMonth({ 'POST /finance-month-closings': () => new ApiError(409, 'FINANCE_MONTH_ALREADY_CLOSED', detail, false) });
    await screen.findByTestId('month-status');
    await user.type(screen.getByLabelText('마감 메모'), '메모');
    await user.click(screen.getByTestId('month-close-submit'));
    await confirmWith(user, '월 마감');
    expect(await screen.findByText(detail)).toBeInTheDocument();
    await waitFor(() => expect(calls.filter((call) => call.path === '/finance-month-closings' && call.method === 'GET').length).toBeGreaterThanOrEqual(3));
  });

  it('아직 시작되지 않은 달은 마감할 수 없다', async () => {
    await openMonth({}, false, '2099-01');
    await screen.findByTestId('month-status');
    expect(screen.getByTestId('month-status')).toHaveTextContent('아직 시작되지 않은 달');
    expect(screen.getByTestId('month-close-submit')).toBeDisabled();
  });

  it('조회 전용 사용자에게는 마감·재오픈 입력이 보이지 않는다', async () => {
    await openMonth({ 'GET /finance-month-closings': () => [pastClosing()] }, true);
    await waitFor(() => expect(screen.getByTestId('month-status')).toHaveTextContent('2020-01 마감됨'));
    expect(screen.queryByLabelText('재오픈 사유')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '월 마감 재오픈' })).not.toBeInTheDocument();
  });

  it('조회 실패는 오류와 재시도를 보여 준다', async () => {
    let fail = true;
    const { user } = await openMonth({ 'GET /finance-month-closings': () => (fail ? new ApiError(503, 'HTTP_503', 'x', true) : []) });
    expect(await screen.findByText(/월 마감 정보를 불러오지 못했습니다/)).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByTestId('month-status')).toHaveTextContent('열림(마감 전)');
  });

  it('일 마감 탭에는 월 마감과 구분하는 안내가 있다', async () => {
    const { user } = open({ 'GET /sale-daily-settlement': () => new ApiError(503, 'HTTP_503', 'x', true) });
    await screen.findByText('시술 매출');
    await user.click(screen.getByRole('tab', { name: '미수·일 마감' }));
    expect(await screen.findByText(/영업일 시재\(현금\)를 맞추는 일 마감입니다/)).toBeInTheDocument();
  });
});
