import { describe, expect, it } from 'vitest';
import type { CatalogProduct, StockMovement } from './schemas';
import { DEFAULT_LOW_STOCK, buildStocktakePlan, emptyMovementFilter, filterMovements, isLowStock, kstDate, lowStockLimit, parseLowStockInput } from './stock';
import { product } from './testServer';

const item = (over: Record<string, unknown> = {}) => product(over) as CatalogProduct;

describe('안전재고 기준', () => {
  it('상품별 값이 없으면 공통 기본값 5를 쓴다', () => {
    expect(DEFAULT_LOW_STOCK).toBe(5);
    expect(lowStockLimit(item())).toBe(5);
    expect(lowStockLimit(item({ low_stock_threshold: null }))).toBe(5);
    expect(lowStockLimit(item({ low_stock_threshold: 0 }))).toBe(0);
    expect(lowStockLimit(item({ low_stock_threshold: 12 }))).toBe(12);
  });

  it('재고가 기준값 이하(같으면 포함)인 실물 상품만 부족이다', () => {
    expect(isLowStock(item({ stock_quantity: 5 }))).toBe(true);
    expect(isLowStock(item({ stock_quantity: 6 }))).toBe(false);
    expect(isLowStock(item({ stock_quantity: 6, low_stock_threshold: 10 }))).toBe(true);
    expect(isLowStock(item({ stock_quantity: 0, low_stock_threshold: 0 }))).toBe(true);
    expect(isLowStock(item({ stock_quantity: 1, low_stock_threshold: 0 }))).toBe(false);
    expect(isLowStock(item({ kind: 'membership', stock_quantity: 0 }))).toBe(false);
  });

  it('입력은 비우면 null, 0 이상의 정수만 허용한다', () => {
    expect(parseLowStockInput('')).toBeNull();
    expect(parseLowStockInput('  ')).toBeNull();
    expect(parseLowStockInput('0')).toBe(0);
    expect(parseLowStockInput(' 12 ')).toBe(12);
    for (const bad of ['-1', '1.5', 'abc', '1e3', '1000000001']) expect(typeof parseLowStockInput(bad)).toBe('string');
  });
});

describe('실사 계획', () => {
  const a = item({ id: 'a', stock_quantity: 10 });
  const b = item({ id: 'b', stock_quantity: 3 });
  const c = item({ id: 'c', stock_quantity: 4 });
  const d = item({ id: 'd', stock_quantity: 4 });

  it('입력한 상품만 차이를 계산하고 비운 상품·일치 상품은 반영 대상이 아니다', () => {
    const plan = buildStocktakePlan([a, b, c, d], { a: '8', b: '3', c: '', d: ' 9 ' });
    expect(plan.entries.map((entry) => [entry.product.id, entry.counted, entry.difference])).toEqual([['a', 8, -2], ['d', 9, 5]]);
    expect(plan.unchanged).toBe(1);
    expect(plan.invalid).toEqual([]);
  });

  it('0개 실사도 가능하고 잘못된 수량은 오류로 모은다', () => {
    const plan = buildStocktakePlan([a, b, c], { a: '0', b: '-1', c: '2.5' });
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({ counted: 0, difference: -10 });
    expect(plan.invalid.map((entry) => entry.product.id)).toEqual(['b', 'c']);
  });
});

describe('재고 이력 필터', () => {
  const move = (id: string, kind: StockMovement['movement_kind'], at: string): StockMovement => ({
    id, organization_id: 'o', product_id: 'p', movement_kind: kind, quantity: 1, reason: id, created_by: 'u', created_at: at,
  });
  const list = [move('m1', 'receipt', '2026-10-01T10:00:00Z'), move('m2', 'sale', '2026-10-05T16:00:00Z'), move('m3', 'stocktake', '2026-10-09T01:00:00Z'), move('bad', 'disposal', 'not-a-date')];
  const ids = (filter: Partial<ReturnType<typeof emptyMovementFilter>>) => filterMovements(list, { ...emptyMovementFilter(), ...filter }).map((row) => row.id);

  it('한국 날짜 기준으로 변환한다(UTC 15시 이후는 다음 날)', () => {
    expect(kstDate('2026-10-05T16:00:00Z')).toBe('2026-10-06');
    expect(kstDate('2026-10-05T14:59:00Z')).toBe('2026-10-05');
    expect(kstDate('x')).toBe('');
  });

  it('조건이 없으면 모두, 종류와 기간(양 끝 포함)으로 좁힌다', () => {
    expect(ids({})).toEqual(['m1', 'm2', 'm3', 'bad']);
    expect(ids({ kind: 'sale' })).toEqual(['m2']);
    expect(ids({ from: '2026-10-06' })).toEqual(['m2', 'm3']);
    expect(ids({ from: '2026-10-06', to: '2026-10-06' })).toEqual(['m2']);
    expect(ids({ to: '2026-10-01' })).toEqual(['m1']);
    expect(ids({ from: '2026-10-01', kind: 'stocktake' })).toEqual(['m3']);
  });
});
