import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../api/client';
import { CustomerPage } from './CustomerPage';

const org = '22222222-2222-4222-8222-222222222222';
const customer = (id: string, name: string, status = 'active') => ({ id, organization_id: org, name, email: null, phone: '010-1111-2222', notes: '', birth_date: null, skin_type: null, concerns: [], allergies: '', last_visit_date: null, next_visit_date: null, tags: [], status });
const A = customer('11111111-1111-4111-8111-111111111111', '가나다');
const B = customer('33333333-3333-4333-8333-333333333333', '보관된고객', 'archived');

function api() {
  return {
    listCustomers: vi.fn(async () => [A, B]),
    listCustomerActivities: vi.fn(async () => []),
    listCustomerPhotos: vi.fn(async () => []),
    createCustomer: vi.fn(),
    updateCustomer: vi.fn(),
    archiveCustomer: vi.fn(),
  } as unknown as ApiClient;
}

describe('CustomerPage focus', () => {
  it('selects the customer passed from a search result', async () => {
    render(<CustomerPage api={api()} organizationId={org} readOnly={false} focusCustomerId={A.id} focusNonce={1} />);
    expect(await screen.findByRole('heading', { name: '가나다' })).toBeInTheDocument();
  });

  it('widens the status filter to find an archived customer', async () => {
    render(<CustomerPage api={api()} organizationId={org} readOnly={false} focusCustomerId={B.id} focusNonce={1} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: '보관된고객' })).toBeInTheDocument());
  });

  it('ignores an unknown customer and keeps the empty form', async () => {
    render(<CustomerPage api={api()} organizationId={org} readOnly={false} focusCustomerId="99999999-9999-4999-8999-999999999999" focusNonce={1} />);
    expect(await screen.findByText('새 고객 등록')).toBeInTheDocument();
  });
});
