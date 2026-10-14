import type { ExportColumn } from '../../lib/io/exportTable';
import { cents, centsToText } from '../sales/format';

const DAY = 86_400_000;
const dayKey = (time: number) => new Date(time).toISOString().slice(0, 10);

/** 선택한 기간(양끝 포함)과 같은 길이로, 바로 앞에 이어지는 이전 기간. 해석할 수 없으면 null. */
export function previousPeriod(from: string, to: string): { from: string; to: string } | null {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const days = Math.round((end - start) / DAY) + 1;
  return { from: dayKey(start - days * DAY), to: dayKey(start - DAY) };
}

export interface MoneySummary { income: string; expense: string; net: string; receipts: string; refunds: string }

export type Metric = 'income' | 'expense' | 'net' | 'receipts' | 'refunds';
export const METRIC_LABELS: Record<Metric, string> = {
  income: '기록된 수입', expense: '기록된 지출', net: '순액', receipts: '방문 수납', refunds: '방문 환불',
};
export const METRICS = Object.keys(METRIC_LABELS) as Metric[];

export interface ComparisonRow { metric: Metric; label: string; current: bigint; previous: bigint | null; change: string }

/** 이전 기간 대비 변화 문구. 기준이 0이면 비율을 계산하지 않고, 음수 기준은 절댓값을 분모로 쓴다. */
export function periodChangeLabel(current: bigint, previous: bigint | null): string {
  if (previous === null) return '비교 불가';
  if (previous === 0n) return current === 0n ? '변화 없음' : '이전 기간 기록 없음';
  const diff = current - previous;
  if (diff === 0n) return '변화 없음';
  const base = previous < 0n ? -previous : previous;
  const percent = Math.round(Math.abs(Number((diff * 1000n) / base) / 10));
  return `${diff > 0n ? '▲' : '▼'} ${percent}%`;
}

/** 이번 기간 요약과 이전 기간 요약(없을 수 있다)을 표 행으로 만든다. 금액을 해석할 수 없으면 0으로 본다. */
export function buildComparison(current: MoneySummary, previous: MoneySummary | null): ComparisonRow[] {
  return METRICS.map((metric) => {
    const now = cents(current[metric]) ?? 0n;
    const before = previous ? cents(previous[metric]) ?? 0n : null;
    return { metric, label: METRIC_LABELS[metric], current: now, previous: before, change: periodChangeLabel(now, before) };
  });
}

/** 내보내기 열. 금액은 숫자 열(엑셀 합계 가능)이다. 이전 기간을 못 불러왔으면 해당 칸은 비운다. */
export const comparisonExportColumns: ExportColumn<ComparisonRow>[] = [
  { header: '항목', width: 16, value: (row) => row.label },
  { header: '이번 기간(원)', type: 'number', width: 16, value: (row) => Number(centsToText(row.current)) },
  { header: '이전 기간(원)', type: 'number', width: 16, value: (row) => (row.previous === null ? null : Number(centsToText(row.previous))) },
  { header: '변화', width: 20, value: (row) => row.change },
];

export interface StaffBar { key: string; name: string; amount: number; share: number }

/** 담당자별 판매 항목 총액을 막대 비율(최대 100)로 바꾼다. 총액 큰 순서이고, 최댓값이 0이면 모두 0이다. */
export function staffBars(rows: Array<{ staff_id: string | null; staff_name_snapshot: string; gross_line_total: string }>): StaffBar[] {
  const items = rows.map((row) => ({ key: `${row.staff_id ?? 'none'}:${row.staff_name_snapshot}`, name: row.staff_name_snapshot || '담당 미지정', amount: Number(row.gross_line_total) || 0 }));
  items.sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'ko'));
  const peak = items.reduce((max, item) => Math.max(max, item.amount), 0);
  return items.map((item) => ({ ...item, share: peak > 0 ? Math.max(0, (item.amount / peak) * 100) : 0 }));
}
