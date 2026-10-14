import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { apiFailure, fakeApi, type FakeCall } from '../appointment-resources/testApi';
import { ManagementPage, formatWon, validPeriod } from './index';

const ORG = 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const preview = (from: string, to: string, extra: object = {}) => ({
  organization_id: ORG, from_date: from, to_date: to, recorded_income: '100000', recorded_expense: '20000', recorded_net: '80000', transaction_count: 2,
  visit_receipts: '100000', visit_refunds: '0', excluded_costs: ['inventory_cogs'], is_final_profit: false, staff_basis_is_commission: false,
  staff_sales_basis: [{ staff_id: 's1', staff_name_snapshot: '김담당', line_count: 3, gross_line_total: '90000' }, { staff_id: null, staff_name_snapshot: '', line_count: 1, gross_line_total: '10000' }],
  ...extra,
});
const query = (call: FakeCall) => new URL(call.path, 'http://x').searchParams;

function setup(extra: object = {}, fail = false) {
  return fakeApi((call) => {
    if (fail) throw apiFailure(503);
    const params = query(call);
    return preview(params.get('from_date')!, params.get('to_date')!, extra);
  });
}

describe('ManagementPage', () => {
  it('기본 기간으로 조회해 수지 요약과 담당자별 근거를 보여 준다', async () => {
    const { api, calls } = setup();
    render(<ManagementPage api={api as never} organizationId={ORG} readOnly={false} />);
    expect(await screen.findByText('기록된 수입 100,000원 · 지출 20,000원 · 순액 80,000원')).toBeInTheDocument();
    expect(screen.getByText('방문 수납 100,000원 · 방문 환불 0원 · 원장 거래 2건')).toBeInTheDocument();
    const grid = within(screen.getByRole('grid', { name: '담당자별 판매 근거' }));
    expect(grid.getByText('김담당')).toBeInTheDocument();
    expect(grid.getByText('담당 미지정')).toBeInTheDocument();
    expect(screen.getAllByText('수당 미확정')).toHaveLength(2);
    expect(screen.getByText(/관리손익 최종치가 아닙니다/)).toBeInTheDocument();
    expect(calls[0].path).toMatch(new RegExp(`^/organizations/${ORG}/management-preview\\?from_date=\\d{4}-\\d{2}-01&to_date=\\d{4}-\\d{2}-\\d{2}$`));
  });

  it('조회 기간을 바꿔 다시 조회한다', async () => {
    const { api, calls } = setup();
    render(<ManagementPage api={api as never} organizationId={ORG} readOnly={false} />);
    await screen.findByRole('grid', { name: '담당자별 판매 근거' });
    fireEvent.change(screen.getByLabelText('시작일'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('종료일'), { target: { value: '2026-10-08' } });
    fireEvent.click(screen.getByRole('button', { name: '조회' }));
    await waitFor(() => expect(calls.some((call) => call.path.includes('from_date=2026-10-01&to_date=2026-10-08'))).toBe(true));
  });

  it('잘못된 기간(역순, 366일 초과, 빈 값)은 서버로 보내지 않는다', async () => {
    const { api, calls } = setup();
    render(<ManagementPage api={api as never} organizationId={ORG} readOnly={false} />);
    await screen.findByRole('grid', { name: '담당자별 판매 근거' });
    const before = calls.length;
    for (const [start, end] of [['2026-11-01', '2026-10-01'], ['2026-01-01', '2027-12-31'], ['', '2026-10-01']]) {
      fireEvent.change(screen.getByLabelText('시작일'), { target: { value: start } });
      fireEvent.change(screen.getByLabelText('종료일'), { target: { value: end } });
      fireEvent.click(screen.getByRole('button', { name: '조회' }));
      expect(await screen.findByText('시작일과 종료일을 366일 이내의 YYYY-MM-DD로 입력하세요.')).toBeInTheDocument();
    }
    expect(calls).toHaveLength(before);
  });

  it('읽기 전용(member)은 조회하지 않고 안내만 한다', () => {
    const { api, calls } = setup();
    render(<ManagementPage api={api as never} organizationId={ORG} readOnly />);
    expect(screen.getByRole('alert')).toHaveTextContent('관리자(소유자·관리자)만 조회할 수 있습니다.');
    expect(screen.queryByRole('button', { name: '조회' })).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('조회 실패는 안내하고 다시 시도할 수 있다', async () => {
    const { api } = setup({}, true);
    render(<ManagementPage api={api as never} organizationId={ORG} readOnly={false} />);
    expect(await screen.findByText(/조회하지 못했습니다/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeInTheDocument();
  });

  it('403은 관리자 전용임을 알린다', async () => {
    const { api } = fakeApi(() => { throw apiFailure(403); });
    render(<ManagementPage api={api as never} organizationId={ORG} readOnly={false} />);
    expect(await screen.findByText('관리자만 조회할 수 있습니다.')).toBeInTheDocument();
  });

  it('최종 손익·수당 확정으로 표시된 응답은 보여 주지 않는다', async () => {
    const { api } = setup({ is_final_profit: true });
    render(<ManagementPage api={api as never} organizationId={ORG} readOnly={false} />);
    expect(await screen.findByText(/조회하지 못했습니다/)).toBeInTheDocument();
    expect(screen.queryByText(/기록된 수입/)).not.toBeInTheDocument();
  });

  it('담당자 행이 없으면 빈 상태를 보여 준다', async () => {
    const { api } = setup({ staff_sales_basis: [] });
    render(<ManagementPage api={api as never} organizationId={ORG} readOnly={false} />);
    expect(await screen.findByText('해당 기간에 담당자별 판매 항목이 없습니다.')).toBeInTheDocument();
  });
});

describe('도우미', () => {
  it('validPeriod와 formatWon', () => {
    expect(validPeriod('2026-01-01', '2027-01-02')).toBe(true);
    expect(validPeriod('2026-01-01', '2027-01-03')).toBe(false);
    expect(validPeriod('2026-02-01', '2026-01-01')).toBe(false);
    expect(validPeriod(null, '2026-01-01')).toBe(false);
    expect(formatWon('1234567')).toBe('1,234,567원');
    expect(formatWon('abc')).toBe('금액 확인 필요');
  });
});

describe('ManagementPage 이전 기간 비교(LAB-10)', () => {
  it('같은 길이의 이전 기간을 함께 조회하고 변화를 보여 준다', async () => {
    const { api, calls } = fakeApi((call) => {
      const params = query(call);
      const from = params.get('from_date')!;
      const isPrevious = from < '2026-10-01';
      return preview(from, params.get('to_date')!, isPrevious ? { recorded_income: '50000', recorded_expense: '20000', recorded_net: '30000' } : {});
    });
    render(<ManagementPage api={api as never} organizationId={ORG} readOnly={false} />);
    await screen.findByRole('grid', { name: '담당자별 판매 근거' });
    fireEvent.change(screen.getByLabelText('시작일'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('종료일'), { target: { value: '2026-10-13' } });
    fireEvent.click(screen.getByRole('button', { name: '조회' }));
    await waitFor(() => expect(calls.some((call) => call.path.includes('from_date=2026-09-18&to_date=2026-09-30'))).toBe(true));
    expect(await screen.findByText('이전 기간 2026-09-18 ~ 2026-09-30')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('change-income')).toHaveTextContent('▲ 100%'));
    expect(screen.getByTestId('change-expense')).toHaveTextContent('변화 없음');
    expect(screen.getByTestId('change-net')).toHaveTextContent('▲ 167%');
  });

  it('이전 기간을 불러오지 못해도 이번 기간은 보여 주고 안내한다', async () => {
    const { api } = fakeApi((call) => {
      const params = query(call);
      if (params.get('from_date')! < new Date().toISOString().slice(0, 8) + '01') throw apiFailure(503);
      return preview(params.get('from_date')!, params.get('to_date')!);
    });
    render(<ManagementPage api={api as never} organizationId={ORG} readOnly={false} />);
    expect(await screen.findByText('기록된 수입 100,000원 · 지출 20,000원 · 순액 80,000원')).toBeInTheDocument();
    expect(await screen.findByText(/이전 기간 데이터를 불러오지 못해/)).toBeInTheDocument();
    expect(screen.getByTestId('change-income')).toHaveTextContent('비교 불가');
  });

  it('확정 손익으로 표시된 이전 기간 응답은 쓰지 않는다', async () => {
    const { api } = fakeApi((call) => {
      const params = query(call);
      const isPrevious = params.get('from_date')! < new Date().toISOString().slice(0, 8) + '01';
      return preview(params.get('from_date')!, params.get('to_date')!, isPrevious ? { is_final_profit: true } : {});
    });
    render(<ManagementPage api={api as never} organizationId={ORG} readOnly={false} />);
    expect(await screen.findByText(/이전 기간 데이터를 불러오지 못해/)).toBeInTheDocument();
  });

  it('담당자 막대와 내보내기 버튼을 보여 준다', async () => {
    const { api } = setup();
    render(<ManagementPage api={api as never} organizationId={ORG} readOnly={false} />);
    const chart = await screen.findByRole('list', { name: '담당자별 판매 항목 총액 막대' });
    expect(within(chart).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('button', { name: '비교 내보내기' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '담당자별 내보내기' })).toBeEnabled();
  });

  it('담당자별 판매가 없으면 막대와 담당자 내보내기를 숨기거나 끈다', async () => {
    const { api } = setup({ staff_sales_basis: [] });
    render(<ManagementPage api={api as never} organizationId={ORG} readOnly={false} />);
    await screen.findByText(/해당 기간에 담당자별 판매 항목이 없습니다/);
    expect(screen.queryByRole('list', { name: '담당자별 판매 항목 총액 막대' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '담당자별 내보내기' })).toBeDisabled();
  });
});
