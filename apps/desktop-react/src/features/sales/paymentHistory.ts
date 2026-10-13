import type { ExportColumn } from '../../lib/io/exportTable';
import { kstDate, kstDateTime } from '../../lib/io/domainColumns';
import type { SalePaymentFilter } from './api';
import { cents, methodLabel, wholeAmount } from './format';
import type { SalePayment, SalePaymentsPage } from './types';

/** 매출 내역(수납·환불·반품) 검색 화면의 순수 로직. 화면 상태와 분리해 단위 테스트한다. */

export const kindLabel: Record<SalePayment['kind'], string> = { payment: '수납', refund: '환불', return: '반품' };
export const kindOptions = [
  { value: '', label: '전체 유형' }, { value: 'payment', label: '수납' }, { value: 'refund', label: '환불' }, { value: 'return', label: '반품' },
] as const;
export const methodOptions = [
  { value: '', label: '전체 수단' }, { value: 'cash', label: '현금' }, { value: 'card', label: '카드' }, { value: 'transfer', label: '이체' }, { value: 'wallet', label: '회원권' },
] as const;

export const PAGE_SIZE = 50;
/** 내보내기 한 번에 모을 수 있는 최대 건수(서버 페이지 200건 × 100쪽) */
export const EXPORT_LIMIT = 20_000;
const EXPORT_PAGE = 200;

export interface HistoryForm {
  from: string | null;
  to: string | null;
  customerId: string;
  method: '' | 'cash' | 'card' | 'transfer' | 'wallet';
  kind: '' | 'payment' | 'refund' | 'return';
  minAmount: string;
  maxAmount: string;
}
export const blankHistoryForm = (): HistoryForm => ({ from: null, to: null, customerId: '', method: '', kind: '', minAmount: '', maxAmount: '' });

export type HistorySort = { key: 'occurred_at' | 'customer_name' | 'kind' | 'method' | 'amount'; direction: 'asc' | 'desc' };
export const defaultSort: HistorySort = { key: 'occurred_at', direction: 'desc' };

export type FilterResult = { ok: true; filter: SalePaymentFilter } | { ok: false; message: string };

/** 입력 폼을 서버 검색 조건으로 바꾼다. 서버가 거절할 값은 미리 안내한다. */
export function toSearchFilter(form: HistoryForm): FilterResult {
  if (form.from && form.to && form.from > form.to) return { ok: false, message: '시작일은 종료일보다 늦을 수 없습니다.' };
  const min = form.minAmount.trim().replace(/,/g, '');
  const max = form.maxAmount.trim().replace(/,/g, '');
  if ((min && !wholeAmount.test(min)) || (max && !wholeAmount.test(max))) return { ok: false, message: '금액은 0 이상의 원 단위 정수로 입력하세요.' };
  if (min && max && BigInt(min) > BigInt(max)) return { ok: false, message: '최소 금액은 최대 금액보다 클 수 없습니다.' };
  return {
    ok: true,
    filter: {
      from: form.from ?? undefined, to: form.to ?? undefined, customerId: form.customerId || undefined, method: form.method || undefined,
      kind: form.kind || undefined, minAmount: min || undefined, maxAmount: max || undefined,
    },
  };
}

/** 환불·반품은 순매출을 줄이므로 부호 있는 "전" 단위 금액으로 바꾼다. */
export function signedAmount(row: Pick<SalePayment, 'kind' | 'amount'>): bigint {
  const value = cents(row.amount) ?? 0n;
  return row.kind === 'payment' ? value : -value;
}

/** 서버가 시각순으로 주므로 시각 정렬 외의 열은 불러온 행 안에서만 정렬한다. */
export function sortHistoryRows(rows: SalePayment[], sort: HistorySort): SalePayment[] {
  if (sort.key === 'occurred_at') return rows;
  const factor = sort.direction === 'asc' ? 1 : -1;
  const compare = (a: SalePayment, b: SalePayment): number => {
    switch (sort.key) {
      case 'amount': { const x = cents(a.amount) ?? 0n; const y = cents(b.amount) ?? 0n; return x < y ? -1 : x > y ? 1 : 0; }
      case 'customer_name': return a.customer_name.localeCompare(b.customer_name, 'ko');
      case 'kind': return kindLabel[a.kind].localeCompare(kindLabel[b.kind], 'ko');
      default: return methodLabel[a.method].localeCompare(methodLabel[b.method], 'ko');
    }
  };
  return [...rows].sort((a, b) => factor * compare(a, b) || b.occurred_at.localeCompare(a.occurred_at) || a.id.localeCompare(b.id));
}

/** 다음 클릭에서의 정렬 상태. 같은 열이면 방향을 바꾸고, 새 열이면 시각은 최신순·그 밖은 오름차순으로 시작한다. */
export function nextSort(current: HistorySort, key: HistorySort['key']): HistorySort {
  if (current.key === key) return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  return { key, direction: key === 'occurred_at' || key === 'amount' ? 'desc' : 'asc' };
}
export const serverSortOf = (sort: HistorySort): 'newest' | 'oldest' => (sort.key === 'occurred_at' && sort.direction === 'asc' ? 'oldest' : 'newest');

/** 수단 열 표시: 회원권 사용은 회원권 이름이 참조로 오므로 수단 이름만 보인다. */
export const referenceText = (row: SalePayment): string => [row.reference, row.reason].filter((part) => part !== '').join(' · ');

export const salePaymentExportColumns: ExportColumn<SalePayment>[] = [
  { header: '일시', width: 18, value: (row) => kstDateTime(row.occurred_at) },
  { header: '일자', type: 'date', width: 12, value: (row) => kstDate(row.occurred_at) },
  { header: '고객', width: 16, value: (row) => row.customer_name },
  { header: '유형', width: 8, value: (row) => kindLabel[row.kind] },
  { header: '수단', width: 8, value: (row) => methodLabel[row.method] },
  { header: '금액', type: 'number', width: 14, value: (row) => row.amount },
  { header: '순매출 반영(환불·반품은 음수)', type: 'number', width: 24, value: (row) => (row.kind === 'payment' ? row.amount : `-${row.amount}`) },
  { header: '승인·식별번호/회원권', width: 22, value: (row) => row.reference },
  { header: '사유', width: 30, value: (row) => row.reason },
];

export type Loader = (cursor: string | undefined) => Promise<SalePaymentsPage>;

/** 조건에 맞는 모든 행을 커서 순서대로 모은다. 합계 건수가 한도를 넘으면 요청 없이 tooMany로 알린다. */
export async function collectAllRows(load: Loader, limit = EXPORT_LIMIT, pageSize = EXPORT_PAGE): Promise<{ rows: SalePayment[]; tooMany: boolean }> {
  const rows: SalePayment[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  const maxPages = Math.ceil(limit / pageSize) + 1;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await load(cursor);
    if (page === 0 && result.totals.row_count > limit) return { rows: [], tooMany: true };
    for (const row of result.rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
    if (!result.next_cursor || result.next_cursor === cursor) return { rows, tooMany: false };
    cursor = result.next_cursor;
  }
  return { rows, tooMany: true };
}
