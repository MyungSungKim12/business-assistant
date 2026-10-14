import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog, NoticeHost } from '@business-assistant/react-ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { FinancePage } from './FinancePage';
import { ORG, fakeApi, uid, type Call } from './testkit';

const rid = (n: number) => uid(100 + n);
const item = (n: number, over: Record<string, unknown> = {}) => ({
  id: rid(n), organization_id: ORG, name: n === 1 ? '월세' : n === 2 ? '통신비' : '보험료', amount: n === 1 ? '1200000.00' : '55000.00', category: n === 1 ? '임대료' : '통신비',
  counterparty: '', memo: '', day_of_month: n === 2 ? 31 : 25, is_active: true, version: 1, updated_at: '2026-10-14T00:00:00Z', ...over,
});
const month = new Date().toISOString().slice(0, 7);
const closedError = () => new ApiError(409, 'FINANCE_MONTH_CLOSED', '마감된 달의 거래는 등록·수정(보관 포함)할 수 없습니다. 관리자가 월 마감을 재오픈한 뒤 다시 시도하세요.', false);

function open(handlers: Record<string, (body: unknown, call: Call) => unknown> = {}, readOnly = false) {
  const callVoid = vi.fn(async () => undefined);
  const kit = fakeApi({
    'GET /finance-transactions': () => [], 'GET /finance-summary': () => ({ from_date: null, to_date: null, income_total: '0', expense_total: '0', net_total: '0', transaction_count: 0 }),
    'GET /finance-month-closings': () => [],
    'GET /finance-recurring-expenses': () => [item(1), item(2)],
    'GET /finance-recurring-expenses/runs': () => [],
    ...handlers,
  }, { callVoid });
  const user = userEvent.setup();
  render(<><NoticeHost /><FinancePage api={kit.api} organizationId={ORG} readOnly={readOnly} /><ConfirmDialog /></>);
  return { ...kit, user, callVoid };
}
const openTab = async (user: ReturnType<typeof userEvent.setup>) => { await user.click(await screen.findByRole('tab', { name: '반복 지출' })); await screen.findByRole('table', { name: '반복 지출 목록' }); };

describe('RecurringPanel 반복 지출(FIN-11)', () => {
  beforeEach(() => window.localStorage.clear());

  it('목록에 금액·분류·이번 달 등록일(말일 보정)과 상태를 보인다', async () => {
    const { user } = open({ 'GET /finance-recurring-expenses/runs': () => [{ recurring_id: rid(1), organization_id: ORG, month: `${month}-01`, transaction_id: uid(9) }] });
    await openTab(user);
    const table = within(screen.getByRole('table', { name: '반복 지출 목록' }));
    expect(table.getByText('1,200,000원')).toBeInTheDocument();
    expect(screen.getByTestId(`status-${rid(1)}`)).toHaveTextContent('등록됨');
    expect(screen.getByTestId(`status-${rid(2)}`)).toHaveTextContent('등록 대기');
    expect(table.getByText(/^\d{4}-\d{2}-(28|29|30|31)$/)).toBeInTheDocument();
  });

  it('대기 건수를 버튼에 보이고, 확인 후 한 달치를 등록한 뒤 목록을 다시 읽는다', async () => {
    let registered = false;
    const { user, calls } = open({
      'GET /finance-recurring-expenses/runs': () => (registered ? [rid(1), rid(2)].map((id) => ({ recurring_id: id, organization_id: ORG, month: `${month}-01`, transaction_id: uid(9) })) : []),
      'POST /finance-recurring-expenses/generate': () => { registered = true; return { month: `${month}-01`, created: 2, skipped: 0, transaction_ids: [uid(8), uid(9)] }; },
    });
    await openTab(user);
    await user.click(await screen.findByRole('button', { name: '이 달 반복 지출 등록 (2건)' }));
    await user.click(within(await screen.findByRole('dialog', { name: '이 달 반복 지출 등록' })).getByRole('button', { name: '등록' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.path.endsWith('/generate'))).toBe(true));
    expect(calls.find((call) => call.path.endsWith('/generate'))!.body).toEqual({ month });
    expect(await screen.findByText(/2건을 지출로 등록했습니다/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId(`status-${rid(1)}`)).toHaveTextContent('등록됨'));
    expect(screen.getByRole('button', { name: '이 달 반복 지출 등록' })).toBeDisabled();
  });

  it('확인에서 취소하면 등록하지 않는다', async () => {
    const { user, calls } = open();
    await openTab(user);
    await user.click(await screen.findByRole('button', { name: /이 달 반복 지출 등록 \(2건\)/ }));
    await user.click(within(await screen.findByRole('dialog', { name: '이 달 반복 지출 등록' })).getByRole('button', { name: '취소' }));
    expect(calls.some((call) => call.path.endsWith('/generate'))).toBe(false);
  });

  it('마감된 달이면 서버 안내를 그대로 보이고 입력은 유지된다', async () => {
    const { user } = open({ 'POST /finance-recurring-expenses/generate': () => closedError() });
    await openTab(user);
    await user.click(await screen.findByRole('button', { name: /이 달 반복 지출 등록/ }));
    await user.click(within(await screen.findByRole('dialog', { name: '이 달 반복 지출 등록' })).getByRole('button', { name: '등록' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('마감된 달의 거래는');
  });

  it('새 반복 지출은 검증 후 서버 규칙대로 보내고 목록에 추가된다', async () => {
    const { user, calls } = open({ 'POST /finance-recurring-expenses': () => item(3, { name: '보험료', amount: '80000.00', category: '보험', day_of_month: 10 }) });
    await openTab(user);
    await user.click(screen.getByRole('button', { name: '추가' }));
    expect(await screen.findByText('이름을 입력하세요.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('이름'), '보험료');
    await user.type(screen.getByLabelText('금액(원)'), '80,000');
    await user.type(screen.getByLabelText('분류'), '보험');
    await user.clear(screen.getByLabelText('매달 나가는 날'));
    await user.type(screen.getByLabelText('매달 나가는 날'), '10');
    await user.click(screen.getByRole('button', { name: '추가' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.path.endsWith('/finance-recurring-expenses'))).toBe(true));
    expect(calls.find((call) => call.method === 'POST' && call.path.endsWith('/finance-recurring-expenses'))!.body).toEqual({
      name: '보험료', amount: '80000', category: '보험', day_of_month: 10, counterparty: '', memo: '', is_active: true,
    });
  });

  it('수정은 expected_version과 함께 PATCH하고, 이미 등록된 거래는 바뀌지 않는다고 알린다', async () => {
    const { user, calls } = open({ 'PATCH /finance-recurring-expenses/:id': () => item(1, { amount: '1300000.00', version: 2 }) });
    await openTab(user);
    await user.click(screen.getByRole('button', { name: '월세' }));
    expect(screen.getByLabelText('이름')).toHaveValue('월세');
    expect(screen.getByRole('button', { name: '수정 저장' })).toBeDisabled();
    await user.clear(screen.getByLabelText('금액(원)'));
    await user.type(screen.getByLabelText('금액(원)'), '1300000');
    await user.click(screen.getByRole('button', { name: '수정 저장' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    expect(calls.find((call) => call.method === 'PATCH')!.body).toMatchObject({ amount: '1300000', expected_version: 1 });
    expect(await screen.findByText(/이미 등록된 거래는 바뀌지 않습니다/)).toBeInTheDocument();
  });

  it('같은 이름(409)이면 안내하고 입력을 유지한다', async () => {
    const { user } = open({ 'POST /finance-recurring-expenses': () => new ApiError(409, 'HTTP_409', 'conflict', false) });
    await openTab(user);
    await user.type(screen.getByLabelText('이름'), '월세');
    await user.type(screen.getByLabelText('금액(원)'), '1000');
    await user.type(screen.getByLabelText('분류'), '임대료');
    await user.click(screen.getByRole('button', { name: '추가' }));
    expect(await screen.findByText(/같은 이름의 반복 지출이 있거나/)).toBeInTheDocument();
    expect(screen.getByLabelText('이름')).toHaveValue('월세');
  });

  it('삭제는 확인을 거친다', async () => {
    const { user, callVoid } = open();
    await openTab(user);
    await user.click(screen.getByRole('button', { name: '월세' }));
    await user.click(screen.getByRole('button', { name: '삭제' }));
    await user.click(within(await screen.findByRole('dialog', { name: '반복 지출 삭제' })).getByRole('button', { name: '취소' }));
    expect(callVoid).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '삭제' }));
    await user.click(within(await screen.findByRole('dialog', { name: '반복 지출 삭제' })).getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(callVoid).toHaveBeenCalledWith('DELETE', `/organizations/${ORG}/finance-recurring-expenses/${rid(1)}`));
  });

  it('조회 전용이면 목록만 보이고 등록·편집이 없다', async () => {
    const { user } = open({}, true);
    await openTab(user);
    expect(screen.getByRole('table', { name: '반복 지출 목록' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /이 달 반복 지출 등록/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('이름')).not.toBeInTheDocument();
  });

  it('다음 달보다 먼 달은 등록 버튼이 꺼진다', async () => {
    const { user } = open();
    await openTab(user);
    const far = new Date(); far.setMonth(far.getMonth() + 3);
    const value = far.toISOString().slice(0, 7);
    const input = screen.getByLabelText('등록할 월');
    await user.clear(input);
    await user.type(input, value);
    expect(await screen.findByText('다음 달보다 먼 달은 등록할 수 없습니다.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /이 달 반복 지출 등록/ })).toBeDisabled();
  });
});
