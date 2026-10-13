import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog, NoticeHost } from '@business-assistant/react-ui';
import { apiFailure } from '../appointment-resources/testApi';
import { InventoryPage } from './index';
import type { CatalogProduct } from './schemas';
import { StocktakeDialog } from './StocktakeDialog';
import { ORG, bodies, product, server, type Handlers } from './testServer';

const a = product({ id: 'a', sku: 'A', name: '크림', stock_quantity: 10, version: 3 }) as CatalogProduct;
const b = product({ id: 'b', sku: 'B', name: '토너', stock_quantity: 4, version: 1 }) as CatalogProduct;
const c = product({ id: 'c', sku: 'C', name: '앰플', stock_quantity: 6, version: 2 }) as CatalogProduct;
const adjust = (id: string) => `POST /catalog-products/${id}/stock-adjustments`;
const applied = (row: CatalogProduct) => (call: { body?: unknown }) => ({ ...row, version: row.version + 1, stock_quantity: (call.body as { quantity: number }).quantity });

function open(handlers: Handlers, products = [a, b, c]) {
  const kit = server(handlers);
  const onApplied = vi.fn();
  render(<><NoticeHost /><ConfirmDialog /><StocktakeDialog api={kit.api} organizationId={ORG} products={products} onApplied={onApplied} onClose={() => undefined} /></>);
  return { ...kit, onApplied };
}
const count = (name: string, value: string) => fireEvent.change(screen.getByLabelText(`${name} 실사 수량`), { target: { value } });
const confirmApply = async () => {
  fireEvent.click(screen.getByRole('button', { name: '차이 확인 후 반영' }));
  fireEvent.click(await screen.findByRole('button', { name: '반영' }));
};

describe('StocktakeDialog', () => {
  it('입력한 수량의 차이를 표에 계산해 보여 주고 차이가 없으면 반영 버튼이 꺼져 있다', () => {
    open({});
    expect(screen.getByRole('button', { name: '차이 확인 후 반영' })).toBeDisabled();
    count('크림', '8');
    count('토너', '4');
    const row = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;
    expect(within(row('크림')).getByText('-2')).toBeInTheDocument();
    expect(within(row('토너')).getByText('0')).toBeInTheDocument();
    expect(screen.getByText('차이 1건 · 일치 1건')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '차이 확인 후 반영' })).toBeEnabled();
  });

  it('확인 후 차이 있는 상품만 stocktake 요청(수량·버전·사유·멱등 키)으로 반영한다', async () => {
    const { calls, onApplied } = open({ [adjust('a')]: applied(a), [adjust('c')]: applied(c) });
    count('크림', '8'); count('토너', '4'); count('앰플', '9');
    await confirmApply();
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(2));
    expect(bodies(calls, adjust('a'))[0]).toMatchObject({ kind: 'stocktake', quantity: 8, expected_version: 3, reason: '정기 재고 실사' });
    expect(bodies(calls, adjust('c'))[0]).toMatchObject({ kind: 'stocktake', quantity: 9, expected_version: 2 });
    expect(bodies(calls, adjust('b'))).toHaveLength(0);
    expect(typeof bodies(calls, adjust('a'))[0].operation_id).toBe('string');
    expect(await screen.findAllByText('2개 상품의 재고를 반영했습니다.')).not.toHaveLength(0);
    expect(screen.getByLabelText('크림 실사 수량')).toHaveValue(null);
    expect(within(screen.getByText('크림').closest('tr') as HTMLElement).getByText('8')).toBeInTheDocument();
  });

  it('입력 오류나 빈 사유는 요청하지 않고 안내한다', async () => {
    const { calls } = open({ [adjust('a')]: applied(a) });
    count('크림', '-1');
    expect(screen.getByText('오류')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('실사 사유'), { target: { value: ' ' } });
    count('크림', '8');
    fireEvent.click(screen.getByRole('button', { name: '차이 확인 후 반영' }));
    expect(await screen.findByText('실사 사유를 입력하세요.')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('일부 실패는 행별로 표시하고, 다시 반영하면 실패한 행만 같은 operation_id로 재시도한다', async () => {
    let failB = true;
    const { calls, onApplied } = open({
      [adjust('a')]: applied(a),
      [adjust('b')]: (call) => { if (failB) throw apiFailure(503, '일시 오류'); return applied(b)(call); },
    });
    count('크림', '8'); count('토너', '2');
    await confirmApply();
    expect(await screen.findByText(/1개 반영, 1개 실패/)).toBeInTheDocument();
    expect(screen.getByText('결과를 확인하지 못했습니다. 다시 반영하면 중복 없이 처리됩니다.')).toBeInTheDocument();
    expect(onApplied).toHaveBeenCalledTimes(1);
    failB = false;
    await confirmApply();
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(2));
    const attempts = bodies(calls, adjust('b'));
    expect(attempts).toHaveLength(2);
    expect(attempts[1].operation_id).toBe(attempts[0].operation_id);
    expect(bodies(calls, adjust('a'))).toHaveLength(1);
  });

  it('충돌(409)은 새로고침 안내를 행에 표시한다', async () => {
    open({ [adjust('a')]: () => { throw apiFailure(409); } });
    count('크림', '1');
    await confirmApply();
    expect(await screen.findByText('다른 변경과 충돌했습니다. 목록을 새로고침한 뒤 다시 실사하세요.')).toBeInTheDocument();
  });
});

describe('InventoryPage 재고 실사 진입', () => {
  it('관리자는 실물 상품만 실사 대상으로 열고, 반영한 재고가 목록에 보인다', async () => {
    const pass = product({ id: 'p9', sku: 'PASS', name: '10회 패키지', kind: 'membership', stock_quantity: 0, benefit_count: 10 });
    const kit = server({ 'GET /catalog-products': () => [a, pass], [adjust('a')]: applied(a) });
    render(<><NoticeHost /><ConfirmDialog /><InventoryPage api={kit.api as never} organizationId={ORG} readOnly={false} /></>);
    await screen.findByText('10회 패키지');
    fireEvent.click(screen.getByRole('button', { name: '재고 실사' }));
    const dialog = within(await screen.findByRole('dialog', { name: '재고 실사' }));
    expect(dialog.getByLabelText('크림 실사 수량')).toBeInTheDocument();
    expect(dialog.queryByLabelText('10회 패키지 실사 수량')).not.toBeInTheDocument();
  });
});
