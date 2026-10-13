import { describe, expect, it, vi } from 'vitest';
import type { ZodType } from 'zod';
import { dashboardApi, type DashboardApi } from './dashboardApi';
import { lowStock } from './dashboardMetrics';

const ORG = 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** 서버 응답을 실제 스키마로 검증하는 가짜 api. */
function fakeApi(payload: unknown) {
  const call = vi.fn(async (_method: string, _path: string, schema: ZodType<unknown>) => schema.parse(payload));
  return { api: { call } as unknown as DashboardApi, call };
}

describe('dashboardApi.products', () => {
  it('안전재고(low_stock_threshold)가 있는 응답과 없는 구버전 응답을 모두 읽는다', async () => {
    const { api } = fakeApi([
      { id: id(1), name: '새 응답', kind: 'product', is_active: true, stock_quantity: 9, low_stock_threshold: 10, sku: 'S1', version: 3 },
      { id: id(2), name: '널 기준', kind: 'product', is_active: true, stock_quantity: 4, low_stock_threshold: null },
      { id: id(3), name: '구버전', kind: 'product', is_active: true, stock_quantity: 5, unit_name: '개' },
    ]);
    const products = await dashboardApi.products(api, ORG);
    expect(products.map((item) => item.low_stock_threshold)).toEqual([10, null, undefined]);
    expect(lowStock(products).map((item) => item.name)).toEqual(['널 기준', '구버전', '새 응답']);
  });

  it('잘못된 안전재고 값은 응답 오류로 거부한다', async () => {
    const { api } = fakeApi([{ id: id(1), name: '이상', kind: 'product', is_active: true, stock_quantity: 1, low_stock_threshold: -1 }]);
    await expect(dashboardApi.products(api, ORG)).rejects.toThrow();
  });
});

describe('dashboardApi.receivables', () => {
  it('전체 미수금 요약을 상위 5건 요청으로 읽는다', async () => {
    const { api, call } = fakeApi({
      receivable_count: 2, total_due: '150000',
      items: [{ cart_id: id(1), visit_id: id(2), customer_id: id(3), customer_name: '김고객', opened_at: '2030-01-01T00:00:00Z', total_amount: '200000', received_amount: '50000', refunded_amount: '0', due_amount: '150000' }],
    });
    const result = await dashboardApi.receivables(api, ORG);
    expect(call).toHaveBeenCalledWith('GET', `/organizations/${ORG}/receivables?limit=5`, expect.anything());
    expect(result).toMatchObject({ receivable_count: 2, total_due: '150000' });
    expect(result.items[0].customer_name).toBe('김고객');
  });
});
