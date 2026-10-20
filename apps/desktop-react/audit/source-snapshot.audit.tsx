/** Regression cases derived from the source audit. */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConfirmDialog } from '@business-assistant/react-ui';
import { describe, expect, it, vi } from 'vitest';
import { CustomerPage } from '../src/features/customers/CustomerPage';
import { PurchaseOrdersDialog } from '../src/features/catalog/PurchaseOrdersDialog';
import { fakeApi, ORG, USER, renderWithHosts } from '../src/features/documents/testkit';

describe('2026-10-16 source audit regressions', () => {
  it('failed customer save retains dirty protection', async () => {
    const first = { id: '11111111-1111-4111-8111-111111111111', organization_id: ORG, name: '첫고객', email: null, phone: null, notes: '', birth_date: null, skin_type: null, concerns: [], allergies: '', last_visit_date: null, next_visit_date: null, tags: [], status: 'active' };
    const second = { ...first, id: '33333333-3333-4333-8333-333333333333', name: '둘고객' };
    const api = { listCustomers: vi.fn(async () => [first, second]), updateCustomer: vi.fn(async () => { throw new Error('mock failed save'); }), listCustomerActivities: vi.fn(async () => []), listCustomerPhotos: vi.fn(async () => []) } as never;
    render(<><CustomerPage api={api} organizationId={ORG} readOnly={false} /><ConfirmDialog /></>);
    const grid = within(screen.getByRole('grid', { name: '고객 목록' }));
    fireEvent.click(await grid.findByText('첫고객'));
    await screen.findByDisplayValue('첫고객');
    fireEvent.change(screen.getByLabelText('이름'), { target: { value: '저장실패한이름' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await screen.findByText(/저장하지 못했습니다/);
    await waitFor(() => expect(screen.getByRole('button', { name: '저장' })).toBeEnabled());
    fireEvent.click(grid.getByText('둘고객'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('이름')).toHaveValue('저장실패한이름');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('purchase receipt retry retains its operation ID after an unknown outcome', async () => {
    const supplier = { id: '44444444-4444-4444-8444-444444444444', organization_id: ORG, name: '검증공급처', contact_name: '', phone: '', email: '', note: '', is_active: true, version: 1, created_by: USER, created_at: '2026-10-16T00:00:00Z', updated_at: '2026-10-16T00:00:00Z' };
    const product = { id: '55555555-5555-4555-8555-555555555555', organization_id: ORG, sku: 'audit', name: '검증상품', kind: 'product' as const, unit_name: '개', sale_price: '1000', benefit_money: '0', benefit_count: 0, valid_days: null, is_active: true, version: 1, stock_quantity: 0 };
    const orderId = '66666666-6666-4666-8666-666666666666', lineId = '77777777-7777-4777-8777-777777777777';
    const order = { id: orderId, organization_id: ORG, supplier_id: supplier.id, status: 'ordered', ordered_at: '2026-10-16T00:00:00Z', note: '', version: 2, created_by: USER, created_at: '2026-10-16T00:00:00Z', updated_at: '2026-10-16T00:00:00Z', lines: [{ id: lineId, organization_id: ORG, order_id: orderId, product_id: product.id, quantity_ordered: 10, quantity_received: 0, unit_cost: '100', note: '', created_at: '2026-10-16T00:00:00Z' }] };
    let receipts = 0;
    const { api, calls } = fakeApi((call) => {
      if (call.path.endsWith('/catalog-suppliers')) return [supplier];
      if (call.path.endsWith('/catalog-purchase-orders')) return [order];
      if (call.path.endsWith('/receipts')) {
        receipts++;
        if (receipts === 1) throw new Error('mock response lost after commit');
        return { receipt_id: '88888888-8888-4888-8888-888888888888', order_id: orderId, line_id: lineId, quantity: 2, replayed: false };
      }
      throw new Error('Unexpected audit request');
    });
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('2');
    try {
      const view = renderWithHosts(<PurchaseOrdersDialog api={api} organizationId={ORG} products={[product]} readOnly={false} onClose={() => undefined} />);
      fireEvent.click(await screen.findByRole('button', { name: '입고' }));
      fireEvent.change(screen.getByLabelText('입고 수량'), { target: { value: '2' } });
      fireEvent.click(screen.getByRole('button', { name: '입고 반영' }));
      await screen.findByText(/입고 결과를 확인하지 못했습니다/);
      view.unmount();
      renderWithHosts(<PurchaseOrdersDialog api={api} organizationId={ORG} products={[product]} readOnly={false} onClose={() => undefined} />);
      expect(await screen.findByText('미확인 입고 2개')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '입고 결과 다시 확인' }));
      await waitFor(() => expect(receipts).toBe(2));
      const requests = calls.filter((call) => call.path.endsWith('/receipts'));
      expect((requests[0].body as { operation_id: string }).operation_id).toBe((requests[1].body as { operation_id: string }).operation_id);
    } finally { prompt.mockRestore(); }
  });
});
