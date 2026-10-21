import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PurchaseOrdersDialog } from './PurchaseOrdersDialog';
import { fakeApi, ORG, renderWithHosts, USER } from '../documents/testkit';

const product = (id: string, name: string) => ({ id, organization_id: ORG, sku: id, name, kind: 'product' as const, unit_name: '개', purchase_unit_name: '박스', units_per_purchase_unit: 12, sale_price: '1000', benefit_money: '0', benefit_count: 0, valid_days: null, is_active: true, version: 1, stock_quantity: 0,category:'기타',barcode:null,image_file_id:null });

describe('PurchaseOrdersDialog', () => {
  it('공급처 상세정보를 저장하고 여러 품목을 한 발주로 생성한다', async () => {
    const supplierId = '88888888-8888-4888-8888-888888888888';
    const first = product('11111111-1111-4111-8111-111111111111', '클렌저');
    const second = product('22222222-2222-4222-8222-222222222222', '토너');
    const supplier = { id: supplierId, organization_id: ORG, name: '뷰티상사', contact_name: '담당자', phone: '01012345678', email: 'sales@example.com', note: '', is_active: true, version: 1, created_by: USER, created_at: '2026-10-16T00:00:00Z', updated_at: '2026-10-16T00:00:00Z' };
    const { api, calls } = fakeApi((call) => {
      if (call.method === 'GET') return call.path.endsWith('/catalog-suppliers') ? [supplier] : [];
      if (call.path.endsWith('/catalog-suppliers')) return supplier;
      if (call.path.endsWith('/catalog-purchase-orders')) return { id: '99999999-9999-4999-8999-999999999999', organization_id: ORG, supplier_id: supplierId, status: 'draft', ordered_at: null, note: '', version: 1, created_by: USER, created_at: '2026-10-16T00:00:00Z', updated_at: '2026-10-16T00:00:00Z', lines: [] };
      return [];
    });
    renderWithHosts(<PurchaseOrdersDialog api={api} organizationId={ORG} products={[first, second]} readOnly={false} onClose={() => undefined} />);
    await screen.findByRole('option', { name: '뷰티상사' });
    fireEvent.change(screen.getByLabelText('발주 공급처'), { target: { value: supplierId } });
    expect(screen.getByLabelText('발주 공급처')).toHaveValue(supplierId);
    fireEvent.change(screen.getByLabelText('발주 상품 1'), { target: { value: first.id } });
    fireEvent.click(screen.getByRole('button', { name: '품목 추가' }));
    fireEvent.change(screen.getByLabelText('발주 상품 2'), { target: { value: second.id } });
    expect(screen.getByLabelText('발주 상품 1')).toHaveValue(first.id);
    expect(screen.getByLabelText('발주 상품 2')).toHaveValue(second.id);
    fireEvent.click(screen.getByRole('button', { name: '발주 초안 만들기' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.path.endsWith('/catalog-purchase-orders') && (call.body as { lines?: unknown[] })?.lines?.length === 2)).toBe(true));
  });
});
