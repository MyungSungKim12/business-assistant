import type { CatalogProduct, StockMovement } from './schemas';

/** 상품에 안전재고가 없을 때 쓰는 공통 기본값(대시보드 재고 부족 기준과 같다). */
export const DEFAULT_LOW_STOCK = 5;
const MAX_STOCK = 1_000_000_000;

/** 상품의 재고 부족 기준값. 상품별 값이 없으면 공통 기본값을 쓴다. */
export function lowStockLimit(product: Pick<CatalogProduct, 'low_stock_threshold'>): number {
  return product.low_stock_threshold ?? DEFAULT_LOW_STOCK;
}

/** 실물 상품이고 재고가 기준값 이하이면 부족. 회원권·패키지는 재고가 없어 제외한다. */
export function isLowStock(product: Pick<CatalogProduct, 'kind' | 'stock_quantity' | 'low_stock_threshold'>): boolean {
  return product.kind === 'product' && product.stock_quantity <= lowStockLimit(product);
}

/** 안전재고 입력을 서버 값으로 바꾼다. 비우면 null(공통 기본값), 잘못된 값은 오류 문구. */
export function parseLowStockInput(text: string): number | null | string {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(value) || value > MAX_STOCK) return `안전재고는 0~${MAX_STOCK.toLocaleString('ko-KR')} 사이의 정수이며, 비우면 기본값(${DEFAULT_LOW_STOCK}개)을 씁니다.`;
  return value;
}

export type StocktakeEntry = { product: CatalogProduct; counted: number; difference: number };
export type StocktakePlan = { entries: StocktakeEntry[]; unchanged: number; invalid: { product: CatalogProduct; text: string }[] };

/** 실사 수량 입력(상품 id → 문자열)에서 차이를 계산한다. 비워 둔 상품은 실사하지 않은 것으로 본다. */
export function buildStocktakePlan(products: CatalogProduct[], counts: Record<string, string>): StocktakePlan {
  const entries: StocktakeEntry[] = [];
  const invalid: StocktakePlan['invalid'] = [];
  let unchanged = 0;
  for (const product of products) {
    const text = (counts[product.id] ?? '').trim();
    if (text === '') continue;
    const counted = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(counted) || counted > MAX_STOCK) { invalid.push({ product, text }); continue; }
    const difference = counted - product.stock_quantity;
    if (difference === 0) unchanged += 1;
    else entries.push({ product, counted, difference });
  }
  return { entries, unchanged, invalid };
}

const KST_OFFSET_MS = 9 * 3_600_000;
/** 서버 시각(UTC ISO)을 한국 날짜(YYYY-MM-DD)로 바꾼다. 해석할 수 없으면 빈 문자열. */
export function kstDate(timestamp: string): string {
  const time = Date.parse(timestamp);
  return Number.isNaN(time) ? '' : new Date(time + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export type MovementFilter = { from: string; to: string; kind: StockMovement['movement_kind'] | 'all' };
export const emptyMovementFilter = (): MovementFilter => ({ from: '', to: '', kind: 'all' });

/** 기간(한국 날짜 기준, 양 끝 포함)과 변동 종류로 재고 이력을 거른다. */
export function filterMovements(movements: StockMovement[], filter: MovementFilter): StockMovement[] {
  return movements.filter((movement) => {
    if (filter.kind !== 'all' && movement.movement_kind !== filter.kind) return false;
    const day = kstDate(movement.created_at);
    if ((filter.from || filter.to) && day === '') return false;
    if (filter.from && day < filter.from) return false;
    if (filter.to && day > filter.to) return false;
    return true;
  });
}
