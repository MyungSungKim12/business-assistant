import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { apiFailure, fakeApi, type FakeCall } from '../appointment-resources/testApi';
import { ManagementPage, formatWon, validPeriod } from './index';

const ORG = 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const preview = (from: string, to: string, extra: object = {}) => ({
  organization_id: ORG, from_date: from, to_date: to, recorded_income: '100000', recorded_expense: '20000', recorded_net: '80000', transaction_count: 2,
  visit_receipts: '100000', visit_refunds: '0', inventory_cogs:'1200', inventory_cost_unknown_units:0, recorded_tax_expense:'0', operating_profit_before_commission_tax:'98800', commission_settlement_complete:false,commission_expense:null,operating_profit_after_commission_before_tax:null,operating_profit_after_recorded_tax:null,excluded_costs: ['staff_commissions','unrecorded_taxes'], is_final_profit: false, staff_basis_is_commission: false,
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
    expect(screen.getByText(/최종 손익이 아닙니다/)).toBeInTheDocument();
    expect(screen.getByText(/상품·시술 원가/)).toBeInTheDocument();
    expect(screen.getByText((_, element) => element?.classList.contains('management-summary') === true && element.textContent?.includes('기록된 세금 지출 0원') === true)).toBeInTheDocument();
    expect(calls[0].path).toMatch(new RegExp(`^/organizations/${ORG}/management-preview\\?from_date=\\d{4}-\\d{2}-01&to_date=\\d{4}-\\d{2}-\\d{2}$`));
  });

  it('미확정 원가·수당 기간은 확정할 수 없다고 안내한다',async()=>{
    const {api}=setup({commission_settlement_complete:false,operating_profit_after_recorded_tax:null,inventory_cost_unknown_units:1});
    render(<ManagementPage api={api as never} organizationId={ORG} readOnly={false}/>);
    expect(await screen.findByText(/원가와 기간 전체 수당 정산을 완료해야 손익을 확정할 수 있습니다/)).toBeInTheDocument();
  });

  it('완전성 체크 뒤 관리 손익을 확정하고 이력에서 금액과 revision을 보여 준다',async()=>{
    const {api,calls}=fakeApi(call=>{
      const params=query(call);
      if(call.path.includes('/management-profit-finalizations')&&call.method==='GET')return [];
      if(call.path.includes('/management-profit-finalizations')&&call.method==='POST')return{id:'f9cc39fd-8e8c-4df8-a623-1f23a3a936bd',organization_id:ORG,from_date:'2026-10-01',to_date:'2026-10-08',revision:1,result:{...preview('2026-10-01','2026-10-08',{commission_settlement_complete:true,commission_expense:'5000',operating_profit_after_recorded_tax:'73800',is_final_profit:true,excluded_costs:[]})},reason:'',confirmed_by:ORG,confirmed_at:'2026-10-09T00:00:00Z'};
      return preview(params.get('from_date')!,params.get('to_date')!,{commission_settlement_complete:true,commission_expense:'5000',operating_profit_after_recorded_tax:'73800',operating_profit_after_commission_before_tax:'75800',excluded_costs:['unrecorded_taxes'],staff_basis_is_commission:true});
    });
    render(<ManagementPage api={api as never} organizationId={ORG} readOnly={false}/>);
    await screen.findByRole('grid',{name:'담당자별 판매 근거'});
    fireEvent.change(screen.getByLabelText('시작일'),{target:{value:'2026-10-01'}});
    fireEvent.change(screen.getByLabelText('종료일'),{target:{value:'2026-10-08'}});
    fireEvent.click(screen.getByRole('button',{name:'조회'}));
    await waitFor(()=>expect(calls.some(call=>call.path.includes('from_date=2026-10-01&to_date=2026-10-08'))).toBe(true));
    fireEvent.click(await screen.findByLabelText('원장 완전성 확인'));
    fireEvent.click(screen.getByRole('button',{name:'손익 확정'}));
    const history = await screen.findByRole('list', { name: '손익 확정 이력' });
    expect(within(history).getByText(/1차 확정/)).toBeInTheDocument();
    expect(history).toHaveTextContent('73,800원');
    expect(calls.some(call=>call.method==='POST'&&call.path.endsWith('/management-profit-finalizations'))).toBe(true);
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

  it('확정 수당과 실제 기록 세금만 분리해 보여 주고 최종 손익으로 부르지 않는다', async () => {
    const { api } = setup({ recorded_tax_expense:'2000', operating_profit_before_commission_tax:'80800', commission_settlement_complete:true, commission_expense:'5000', operating_profit_after_commission_before_tax:'75800', operating_profit_after_recorded_tax:'73800', excluded_costs:['unrecorded_taxes'], staff_basis_is_commission:true });
    render(<ManagementPage api={api as never} organizationId={ORG} readOnly={false} />);
    expect(await screen.findByText((_, element) => element?.classList.contains('management-summary') === true && element.textContent?.includes('기록된 세금 지출 2,000원') === true)).toBeInTheDocument();
    expect(screen.getByText((_, element) => element?.classList.contains('management-summary') === true && element.textContent?.includes('확정 수당 5,000원 차감 후(세전) 75,800원') === true)).toBeInTheDocument();
    expect(screen.getByText((_, element) => element?.classList.contains('management-summary') === true && element.textContent?.includes('수당 차감 후 잔액(기록 세금 반영) 73,800원') === true)).toBeInTheDocument();
    expect(screen.getByText(/최종 손익이 아닙니다/)).toBeInTheDocument();
  });

  it('담당이 빠진 수당 항목은 사유를 받아 관리자 귀속 RPC 후 미리보기를 다시 불러온다',async()=>{
    const line={source_event_id:'e9cc39fd-8e8c-4df8-a623-1f23a3a936bd',event_kind:'receipt',sale_line_id:'f9cc39fd-8e8c-4df8-a623-1f23a3a936bd',staff_id:null,staff_name_snapshot:'미지정',commission_scope:'product',source_id:'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd',rule_id:null,rule_rate_basis_points:null,rule_snapshot:{basis:'net_paid'},net_paid_amount:'10000',commission_amount:'0',warning:'담당 직원 미지정',attribution_override_version:0};
    let commissionPreviews=0;
    const {api,calls}=fakeApi(call=>{
      if(call.path.endsWith('/staff-commission-attribution-staff'))return[{id:'f9cc39fd-8e8c-4df8-a623-1f23a3a936bd',organization_id:ORG,name:'김담당',is_active:true}];
      if(call.path.includes('/staff-commission-attributions/'))return{organization_id:ORG,sale_line_id:line.sale_line_id,staff_id:'staff-1',version:1,reason:'결제 등록 시 담당 누락',replayed:false};
      if(call.path.endsWith('/staff-commission-settlements/preview')){commissionPreviews++;return{organization_id:ORG,from_date:'2026-10-01',to_date:'2026-10-08',lines:[{...line,...(commissionPreviews===1?{}:{staff_id:'staff-1',staff_name_snapshot:'김담당',rule_id:'rule-1',rule_rate_basis_points:1000,commission_amount:'1000',warning:null,attribution_override_version:1})}]};}
      const params=query(call);return preview(params.get('from_date')!,params.get('to_date')!);
    });
    render(<ManagementPage api={api as never} organizationId={ORG} readOnly={false}/>);
    await screen.findByRole('grid',{name:'담당자별 판매 근거'});
    fireEvent.change(screen.getByLabelText('시작일'),{target:{value:'2026-10-01'}});fireEvent.change(screen.getByLabelText('종료일'),{target:{value:'2026-10-08'}});fireEvent.click(screen.getByRole('button',{name:'조회'}));
    fireEvent.click(await screen.findByRole('button',{name:'수당 미리보기'}));
    await waitFor(()=>expect(calls.some(call=>call.path.endsWith('/staff-commission-settlements/preview'))).toBe(true));
    const staffSelect=await screen.findByLabelText(`귀속 직원 ${line.sale_line_id}`);
    fireEvent.change(staffSelect,{target:{value:'f9cc39fd-8e8c-4df8-a623-1f23a3a936bd'}});const save=screen.getByRole('button',{name:'담당 보정'});expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText(`보정 사유 ${line.sale_line_id}`),{target:{value:'결제 등록 시 담당 누락'}});fireEvent.click(save);
    await waitFor(()=>expect(calls.some(call=>call.method==='PATCH'&&call.path.endsWith(`/staff-commission-attributions/${line.sale_line_id}`))).toBe(true));
    expect(calls.find(call=>call.method==='PATCH')?.body).toMatchObject({staff_id:'f9cc39fd-8e8c-4df8-a623-1f23a3a936bd',expected_version:0,reason:'결제 등록 시 담당 누락'});
    expect((await screen.findAllByText('김담당')).length).toBeGreaterThan(0);expect(await screen.findByRole('button',{name:'귀속 변경'})).toBeInTheDocument();
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
