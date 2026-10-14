import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from '@business-assistant/react-ui';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../api/errors';
import { FinancePage } from './FinancePage';
import { ORG, fakeApi, uid, type Call } from './testkit';

const tx = (n: number, type: 'income' | 'expense', amount: string, date: string, category: string, over: Record<string, unknown> = {}) => ({
  id: uid(n), organization_id: ORG, transaction_type: type, amount, transaction_date: date, category, counterparty: '', memo: '', is_archived: false, ...over,
});
const year = new Date().getFullYear();
const rows = [
  tx(1, 'income', '300000', `${year}-01-05`, '시술 매출'),
  tx(2, 'expense', '1200000', `${year}-01-25`, '임대료'),
  tx(3, 'expense', '1200000', `${year}-02-25`, '임대료'),
  tx(4, 'income', '500000', `${year}-02-10`, '시술 매출'),
  tx(5, 'expense', '999999', `${year}-02-12`, '보관됨', { is_archived: true }),
];

function open(handlers: Record<string, (body: unknown, call: Call) => unknown> = {}) {
  const kit = fakeApi({
    'GET /finance-transactions': () => rows, 'GET /finance-summary': () => ({ from_date: null, to_date: null, income_total: '0', expense_total: '0', net_total: '0', transaction_count: 0 }),
    'GET /finance-month-closings': () => [], 'GET /finance-recurring-expenses': () => [], ...handlers,
  });
  const user = userEvent.setup();
  render(<><FinancePage api={kit.api} organizationId={ORG} readOnly={false} /><ConfirmDialog /></>);
  return { ...kit, user };
}
const openTab = async (user: ReturnType<typeof userEvent.setup>) => { await user.click(await screen.findByRole('tab', { name: '분류·세무 자료' })); await screen.findByTestId('tax-totals'); };

describe('TaxReportPanel 분류·세무 자료(FIN-11)', () => {
  beforeEach(() => window.localStorage.clear());

  it('올해 거래를 읽어 합계·분류별·월별을 보인다(보관 거래 제외)', async () => {
    const { user, calls } = open();
    await openTab(user);
    expect(calls.some((call) => call.path.startsWith('/finance-transactions?') && call.path.includes(`from_date=${year}-01-01`))).toBe(true);
    const totals = screen.getByTestId('tax-totals');
    expect(totals).toHaveTextContent('수입 800,000원');
    expect(totals).toHaveTextContent('지출 2,400,000원');
    expect(totals).toHaveTextContent('순액 -1,600,000원');
    expect(totals).toHaveTextContent('거래 4건');
    const categories = within(screen.getByRole('table', { name: '분류별 합계' }));
    expect(categories.getByText('임대료')).toBeInTheDocument();
    expect(categories.queryByText('보관됨')).not.toBeInTheDocument();
    const months = within(screen.getByRole('table', { name: '월별 합계' }));
    expect(months.getByText(`${year}-01`)).toBeInTheDocument();
    expect(months.getByText(`${year}-02`)).toBeInTheDocument();
  });

  it('기간을 바꿔 다시 조회하면 서버에 새 기간을 보낸다', async () => {
    const { user, calls } = open();
    await openTab(user);
    const input = screen.getByLabelText('시작일');
    await user.clear(input);
    await user.type(input, `${year}-02-01`);
    await user.click(screen.getByRole('button', { name: '조회' }));
    await waitFor(() => expect(calls.some((call) => call.path.startsWith('/finance-transactions?') && call.path.includes(`from_date=${year}-02-01`))).toBe(true));
  });

  it('시작일이 종료일보다 늦으면 요청하지 않고 안내한다', async () => {
    const { user, calls } = open();
    await openTab(user);
    const input = screen.getByLabelText('시작일');
    await user.clear(input);
    await screen.findByTestId('tax-totals');
    const before = calls.length;
    await user.type(input, '2999-01-01');
    expect(await screen.findByText('시작일은 종료일보다 늦을 수 없습니다.')).toBeInTheDocument();
    expect(calls.length).toBe(before);
  });

  it('내보내기 버튼 세 개를 제공하고, 거래가 없으면 꺼진다', async () => {
    const { user } = open();
    await openTab(user);
    for (const name of ['분류별 내보내기', '월별 내보내기', '세무용 상세 내보내기']) expect(screen.getByRole('button', { name })).toBeEnabled();
  });

  it('거래가 없으면 안내하고 내보내기가 꺼진다', async () => {
    const { user } = open({ 'GET /finance-transactions': () => [] });
    await openTab(user);
    expect(screen.getAllByText('이 기간에 거래가 없습니다.')).toHaveLength(2);
    for (const name of ['분류별 내보내기', '월별 내보내기', '세무용 상세 내보내기']) expect(screen.getByRole('button', { name })).toBeDisabled();
  });

  it('조회 실패는 안내하고 다시 시도할 수 있다', async () => {
    let fail = true;
    const { user } = open({ 'GET /finance-transactions': () => (fail ? new ApiError(503, 'HTTP_503', 'x', true) : rows) });
    await user.click(await screen.findByRole('tab', { name: '분류·세무 자료' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toBeInTheDocument();
    fail = false;
    await user.click(within(alert).getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByTestId('tax-totals')).toBeInTheDocument();
  });

  it('수입·지출 탭의 분류 입력에 사용했던 분류와 기본 분류를 제안한다', async () => {
    const { user } = open();
    await screen.findAllByText('임대료');
    const list = document.getElementById('finance-categories')!;
    const values = Array.from(list.querySelectorAll('option')).map((option) => option.getAttribute('value'));
    expect(values).toContain('임대료');
    expect(values).toContain('인건비');
    expect(new Set(values).size).toBe(values.length);
    void user;
  });
});
