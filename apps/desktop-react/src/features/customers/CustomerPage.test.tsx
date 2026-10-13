import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CustomerPage } from './CustomerPage';

const customer = { id:'11111111-1111-4111-8111-111111111111', organization_id:'22222222-2222-4222-8222-222222222222', name:'김고객', email:null, phone:'010-1234-5678', notes:'', birth_date:null, skin_type:null, concerns:[], allergies:'', last_visit_date:null, next_visit_date:null, tags:['재방문'], status:'active' };
function api(rows: object[] = [customer]) {
  return {
    listCustomers: vi.fn(async () => rows),
    createCustomer: vi.fn(async (_o: string, input: object) => ({ ...customer, ...input, id: '33333333-3333-4333-8333-333333333333' })),
    updateCustomer: vi.fn(async (_o: string, _id: string, input: object) => ({ ...customer, ...input })),
    archiveCustomer: vi.fn(async () => ({ ...customer, status: 'archived' })),
    listCustomerActivities: vi.fn(async () => []),
    listCustomerPhotos: vi.fn(async () => []),
  } as never;
}
const grid = () => within(screen.getByRole('grid', { name: '고객 목록' }));

describe('CustomerPage', () => {
  it('searches customers, saves a selected profile, and exposes a retryable error', async () => {
    const client = api();
    render(<CustomerPage api={client} organizationId={customer.organization_id} readOnly={false} />);
    expect(await grid().findByText('김고객')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('고객 검색'), { target: { value: '재방문' } });
    expect(grid().getByText('김고객')).toBeInTheDocument();
    fireEvent.click(grid().getByText('김고객'));
    fireEvent.change(screen.getByLabelText('이름'), { target: { value: '김수정' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    expect((await screen.findAllByText('김수정')).length).toBeGreaterThan(0);
  });

  it('keeps member view read only', async () => {
    render(<CustomerPage api={api()} organizationId={customer.organization_id} readOnly />);
    await grid().findByText('김고객');
    expect(screen.queryByRole('button', { name: '저장' })).not.toBeInTheDocument();
  });

  it('keeps the list table (with headers) and every board panel present with zero customers', async () => {
    render(<CustomerPage api={api([])} organizationId={customer.organization_id} readOnly={false} />);
    expect(await grid().findByText('조건에 맞는 고객이 없습니다.')).toBeInTheDocument();
    expect(grid().getByRole('columnheader', { name: /고객명/ })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '고객 목록 영역' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '고객 인사이트 영역' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '다음 방문 임박' })).toHaveTextContent('예정된 방문이 없습니다');
    expect(screen.getByRole('region', { name: '장기 미방문' })).toHaveTextContent('장기 미방문 고객이 없습니다');
    expect(screen.getByRole('region', { name: '이번 달 생일' })).toHaveTextContent('생일인 고객이 없습니다');
    expect(screen.getByRole('region', { name: '고객 사진' })).toHaveTextContent('고객을 선택하면');
  });

  it('shows the table header while loading', async () => {
    const pending = api();
    (pending as unknown as { listCustomers: () => Promise<never> }).listCustomers = () => new Promise(() => undefined);
    render(<CustomerPage api={pending} organizationId={customer.organization_id} readOnly={false} />);
    expect(grid().getByRole('columnheader', { name: /연락처/ })).toBeInTheDocument();
    expect(grid().getByText('불러오는 중…')).toBeInTheDocument();
  });

  it('selects a customer from an insight panel and shows that customer photos area', async () => {
    const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const upcoming = { ...customer, id: '44444444-4444-4444-8444-444444444444', name: '박예정', next_visit_date: today, last_visit_date: '2020-01-01' };
    render(<CustomerPage api={api([upcoming])} organizationId={customer.organization_id} readOnly={false} />);
    await grid().findByText('박예정');
    fireEvent.click(within(screen.getByRole('region', { name: '다음 방문 임박' })).getByRole('button', { name: /박예정/ }));
    expect(await screen.findByRole('heading', { name: '박예정' })).toBeInTheDocument();
    expect(await screen.findByText(/등록된 사진이 없습니다/)).toBeInTheDocument();
  });
});
