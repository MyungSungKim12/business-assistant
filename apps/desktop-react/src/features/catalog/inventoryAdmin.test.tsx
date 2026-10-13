import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConfirmDialog, NoticeHost } from '@business-assistant/react-ui';
import { apiFailure } from '../appointment-resources/testApi';
import { InventoryPage } from './index';
import { ORG, bodies, product, server } from './testServer';

const renderInventory = (api: never, readOnly = false) => render(<><NoticeHost /><ConfirmDialog /><InventoryPage api={api} organizationId={ORG} readOnly={readOnly} /></>);
const cream = product();
const low = product({ id: 'p3', sku: 'SKU-3', name: '선크림', stock_quantity: 2 });
const custom = product({ id: 'p4', sku: 'SKU-4', name: '앰플', stock_quantity: 8, low_stock_threshold: 10 });
const pass = product({ id: 'p2', sku: 'PASS', name: '10회 패키지', kind: 'membership', benefit_count: 10, valid_days: 365, stock_quantity: 0, sale_price: '500000' });
const grid = () => within(screen.getByRole('grid', { name: '상품 목록' }));

describe('INV-10 안전재고 표시·필터', () => {
  it('기준값 이하(기본 5, 상품별 값 우선)인 실물 상품에 부족 배지를 붙이고 회원권에는 붙이지 않는다', async () => {
    renderInventory(server({ 'GET /catalog-products': () => [cream, low, custom, pass] }).api as never);
    await screen.findByText('선크림');
    expect(grid().getAllByText('부족')).toHaveLength(2);
    expect(within(grid().getByText('선크림').closest('tr') as HTMLElement).getByText('부족')).toBeInTheDocument();
    expect(within(grid().getByText('앰플').closest('tr') as HTMLElement).getByText('부족')).toBeInTheDocument();
    expect(within(grid().getByText('보습 크림').closest('tr') as HTMLElement).queryByText('부족')).not.toBeInTheDocument();
    expect(within(grid().getByText('10회 패키지').closest('tr') as HTMLElement).queryByText('부족')).not.toBeInTheDocument();
  });

  it('"재고 부족만" 필터로 목록을 좁힌다', async () => {
    renderInventory(server({ 'GET /catalog-products': () => [cream, low, custom, pass] }).api as never);
    await screen.findByText('보습 크림');
    fireEvent.change(screen.getByLabelText('재고 필터'), { target: { value: 'low' } });
    expect(screen.queryByText('보습 크림')).not.toBeInTheDocument();
    expect(screen.getByText('선크림')).toBeInTheDocument();
    expect(screen.getByText('앰플')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '재고 부족만 (2)' })).toBeInTheDocument();
  });

  it('구버전 응답(low_stock_threshold 없음)도 기본값으로 동작한다', async () => {
    renderInventory(server({ 'GET /catalog-products': () => [low] }).api as never);
    expect(await screen.findByText('선크림')).toBeInTheDocument();
    expect(grid().getByText('기본 5')).toBeInTheDocument();
  });
});

describe('INV-10 안전재고 저장', () => {
  it('안전재고만 별도 경로로 저장하고 expected_version·멱등 키를 보낸다', async () => {
    const { api, calls } = server({
      'GET /catalog-products': () => [cream],
      'PUT /catalog-products/p1/low-stock': (call) => ({ ...cream, version: 2, low_stock_threshold: (call.body as { low_stock_threshold: number }).low_stock_threshold }),
    });
    renderInventory(api as never);
    fireEvent.click(await screen.findByText('보습 크림'));
    expect(screen.getByLabelText('안전재고')).toHaveValue(null);
    fireEvent.change(screen.getByLabelText('안전재고'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: '안전재고 저장' }));
    await waitFor(() => expect(bodies(calls, 'PUT /catalog-products/p1/low-stock')).toHaveLength(1));
    const [body] = bodies(calls, 'PUT /catalog-products/p1/low-stock');
    expect(body).toMatchObject({ low_stock_threshold: 10, expected_version: 1 });
    expect(typeof body.operation_id).toBe('string');
    expect(await screen.findAllByText('안전재고를 저장했습니다.')).not.toHaveLength(0);
    expect(within(await screen.findByRole('grid', { name: '상품 목록' })).getByText('부족')).toBeInTheDocument();
  });

  it('비우면 null(기본값)로 보내고 잘못된 값은 보내지 않는다', async () => {
    const { api, calls } = server({ 'GET /catalog-products': () => [custom], 'PUT /catalog-products/p4/low-stock': () => ({ ...custom, version: 2, low_stock_threshold: null }) });
    renderInventory(api as never);
    fireEvent.click(await screen.findByText('앰플'));
    expect(screen.getByLabelText('안전재고')).toHaveValue(10);
    fireEvent.change(screen.getByLabelText('안전재고'), { target: { value: '-3' } });
    fireEvent.click(screen.getByRole('button', { name: '안전재고 저장' }));
    expect(await screen.findByText(/안전재고는 0~/)).toBeInTheDocument();
    expect(bodies(calls, 'PUT /catalog-products/p4/low-stock')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('안전재고'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '안전재고 저장' }));
    await waitFor(() => expect(bodies(calls, 'PUT /catalog-products/p4/low-stock')).toHaveLength(1));
    expect(bodies(calls, 'PUT /catalog-products/p4/low-stock')[0]).toMatchObject({ low_stock_threshold: null });
  });

  it('충돌(409)은 새로고침 안내를 보이고, 읽기 전용에서는 저장 버튼이 없다', async () => {
    const { api } = server({ 'GET /catalog-products': () => [cream], 'PUT /catalog-products/p1/low-stock': () => { throw apiFailure(409); } });
    renderInventory(api as never);
    fireEvent.click(await screen.findByText('보습 크림'));
    fireEvent.change(screen.getByLabelText('안전재고'), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: '안전재고 저장' }));
    expect(await screen.findByText('다른 변경과 충돌했습니다. 새로고침 후 다시 확인하세요.')).toBeInTheDocument();
  });

  it('읽기 전용(member)은 안전재고를 보기만 한다', async () => {
    renderInventory(server({ 'GET /catalog-products': () => [custom] }).api as never, true);
    fireEvent.click(await screen.findByText('앰플'));
    expect(screen.getByLabelText('안전재고')).toBeDisabled();
    expect(screen.queryByRole('button', { name: '안전재고 저장' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '재고 실사' })).not.toBeInTheDocument();
  });
});

describe('INV-10 재고 이력 필터', () => {
  const move = (id: string, kind: string, at: string, quantity: number) => ({ id, organization_id: ORG, product_id: 'p1', movement_kind: kind, quantity, reason: `사유-${id}`, created_by: 'u', created_at: at });
  const movements = [move('a', 'receipt', '2026-10-01T01:00:00Z', 10), move('b', 'sale', '2026-10-05T01:00:00Z', -1), move('c', 'stocktake', '2026-10-09T01:00:00Z', -2)];

  async function openHistory() {
    renderInventory(server({ 'GET /catalog-products': () => [cream], 'GET /catalog-products/p1/stock-ledger': () => movements }).api as never);
    fireEvent.click(await screen.findByText('보습 크림'));
    fireEvent.click(screen.getByRole('button', { name: '재고 변동 이력' }));
    const dialog = await screen.findByRole('dialog', { name: '보습 크림 · 재고 변동 이력' });
    return within(dialog);
  }

  it('유형과 기간으로 이력을 거르고 필터 해제로 되돌린다', async () => {
    const dialog = await openHistory();
    expect(dialog.getByText('최근 3건 중 3건')).toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText('이력 종류'), { target: { value: 'sale' } });
    expect(dialog.getByText('사유-b')).toBeInTheDocument();
    expect(dialog.queryByText('사유-a')).not.toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText('이력 종류'), { target: { value: 'all' } });
    fireEvent.change(dialog.getByLabelText('이력 시작일'), { target: { value: '2026-10-05' } });
    fireEvent.change(dialog.getByLabelText('이력 종료일'), { target: { value: '2026-10-08' } });
    expect(dialog.getByText('최근 3건 중 1건')).toBeInTheDocument();
    expect(dialog.getByText('사유-b')).toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText('이력 시작일'), { target: { value: '2026-11-01' } });
    expect(await dialog.findByText('조건에 맞는 이력이 없습니다.')).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: '필터 해제' }));
    expect(dialog.getByText('최근 3건 중 3건')).toBeInTheDocument();
  });
});
