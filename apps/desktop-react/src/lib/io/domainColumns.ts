/** 매출·재고·재무 내보내기 열 정의. 금액은 숫자 열(엑셀 합계 가능), 날짜는 YYYY-MM-DD. */
import type { CatalogProduct, StockMovement } from '../../features/catalog/schemas';
import type { Transaction, Visit } from '../../features/sales/types';
import type { ExportColumn } from './exportTable';

/** ISO 시각을 한국 표준시(KST) 기준 YYYY-MM-DD로. 해석할 수 없으면 빈 문자열. */
export function kstDate(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** ISO 시각을 KST 기준 YYYY-MM-DD HH:mm로. */
export function kstDateTime(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() + 9 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
}

const transactionTypeLabel = { income: '수입', expense: '지출' } as const;

export const transactionExportColumns: ExportColumn<Transaction>[] = [
  { header: '거래일', type: 'date', width: 12, value: (row) => row.transaction_date },
  { header: '유형', width: 8, value: (row) => transactionTypeLabel[row.transaction_type] },
  { header: '금액', type: 'number', width: 14, value: (row) => row.amount },
  { header: '순액(지출은 음수)', type: 'number', width: 18, value: (row) => (row.transaction_type === 'expense' ? `-${row.amount}` : row.amount) },
  { header: '분류', width: 16, value: (row) => row.category },
  { header: '거래처', width: 20, value: (row) => row.counterparty },
  { header: '메모', width: 30, value: (row) => row.memo },
  { header: '상태', width: 8, value: (row) => (row.is_archived ? '보관' : '') },
];

const visitStatusText: Record<string, string> = { open: '진행 중', checkout_ready: '결제 대기', closed: '수납 완료', canceled: '취소' };

export interface VisitExportRow {
  visit: Visit;
  customerName: string;
}

export const visitExportColumns: ExportColumn<VisitExportRow>[] = [
  { header: '방문 시작', width: 18, value: (row) => kstDateTime(row.visit.opened_at) },
  { header: '방문일', type: 'date', width: 12, value: (row) => kstDate(row.visit.opened_at) },
  { header: '고객', width: 16, value: (row) => row.customerName },
  { header: '상태', width: 10, value: (row) => visitStatusText[row.visit.status] ?? row.visit.status },
  { header: '종료', width: 18, value: (row) => kstDateTime(row.visit.closed_at) },
];

export const productExportColumns: ExportColumn<CatalogProduct>[] = [
  { header: '구분', width: 10, value: (row) => (row.kind === 'product' ? '상품' : '회원권') },
  { header: '이름', width: 22, value: (row) => row.name },
  { header: 'SKU', width: 14, value: (row) => row.sku },
  { header: '단위', width: 8, value: (row) => row.unit_name },
  { header: '판매가', type: 'number', width: 12, value: (row) => row.sale_price },
  { header: '제공 금액', type: 'number', width: 12, value: (row) => (row.kind === 'membership' ? row.benefit_money : null) },
  { header: '제공 횟수', type: 'number', width: 10, value: (row) => (row.kind === 'membership' ? row.benefit_count : null) },
  { header: '유효 일수', type: 'number', width: 10, value: (row) => row.valid_days },
  { header: '재고', type: 'number', width: 8, value: (row) => (row.kind === 'product' ? row.stock_quantity : null) },
  { header: '상태', width: 10, value: (row) => (row.is_active ? '판매 중' : '판매 중지') },
];

const movementText: Record<StockMovement['movement_kind'], string> = {
  receipt: '입고', purchase_order_receipt: '발주 입고', sale: '판매 출고', refund: '환불 복원', customer_return: '고객 상품 반품', supplier_return: '거래처 반품', disposal: '폐기', stocktake: '실사 조정', treatment_use: '시술 소모', adjustment: '재고 조정',
};

export const movementExportColumns: ExportColumn<StockMovement>[] = [
  { header: '일시', width: 18, value: (row) => kstDateTime(row.created_at) },
  { header: '변동 종류', width: 14, value: (row) => movementText[row.movement_kind] ?? row.movement_kind },
  { header: '수량', type: 'number', width: 10, value: (row) => row.quantity },
  { header: '사유', width: 36, value: (row) => row.reason },
];
