import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CustomerPage } from '../CustomerPage';

const customer = {
  id: '11111111-1111-4111-8111-111111111111', organization_id: '22222222-2222-4222-8222-222222222222', name: '김고객', email: null, phone: '010-1234-5678', notes: '',
  birth_date: null, skin_type: null, concerns: [], allergies: '', last_visit_date: null, next_visit_date: null, tags: ['재방문'], status: 'active',
};
const api = () => ({
  listCustomers: vi.fn(async () => [customer, { ...customer, id: '33333333-3333-4333-8333-333333333333', name: '보관고객', status: 'archived' }]),
  listCustomerActivities: vi.fn(async () => []),
  listCustomerPhotos: vi.fn(async () => []),
}) as never;

describe('CustomerPage import/export buttons', () => {
  it('offers export for everyone, with current-list and all scopes, and import only to writers', async () => {
    render(<CustomerPage api={api()} organizationId={customer.organization_id} readOnly={false} />);
    await screen.findByText('활성 고객');
    fireEvent.click(await screen.findByRole('button', { name: '내보내기' }));
    expect(await screen.findByText(/현재 목록 \(1건/)).toBeInTheDocument();
    expect(screen.getByText(/전체 \(2건\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /엑셀/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /CSV/ })).toBeInTheDocument();
  });

  it('opens the import wizard and hides import for read-only members', async () => {
    const { unmount } = render(<CustomerPage api={api()} organizationId={customer.organization_id} readOnly={false} />);
    fireEvent.click(await screen.findByRole('button', { name: '가져오기' }));
    expect(await screen.findByRole('dialog', { name: '고객 가져오기' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '양식 내려받기' })).toBeInTheDocument();
    unmount();
    render(<CustomerPage api={api()} organizationId={customer.organization_id} readOnly />);
    expect(await screen.findByRole('button', { name: '내보내기' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '가져오기' })).not.toBeInTheDocument();
  });
});
