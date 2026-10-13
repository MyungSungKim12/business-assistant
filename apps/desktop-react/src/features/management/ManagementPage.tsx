import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { DataGrid, DateField, ErrorState, LoadingState, type Column } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import './management.css';

const money = z.union([z.string(), z.number()]).transform(String);
export const managementPreviewSchema = z.object({
  organization_id: z.string(), from_date: z.string(), to_date: z.string(),
  recorded_income: money, recorded_expense: money, recorded_net: money, transaction_count: z.number(), visit_receipts: money, visit_refunds: money,
  staff_sales_basis: z.array(z.object({ staff_id: z.string().nullable(), staff_name_snapshot: z.string(), line_count: z.number(), gross_line_total: money })),
  is_final_profit: z.boolean(), excluded_costs: z.array(z.string()), staff_basis_is_commission: z.boolean(),
});
export type ManagementPreview = z.infer<typeof managementPreviewSchema>;
type StaffRow = ManagementPreview['staff_sales_basis'][number];

const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const DAY = 86_400_000;
/** 조회 기간 검사(서버와 같은 규칙): 시작 ≤ 종료, 최대 366일. */
export function validPeriod(from: string | null, to: string | null): boolean {
  if (!from || !to) return false;
  const days = (Date.parse(to) - Date.parse(from)) / DAY;
  return Number.isFinite(days) && days >= 0 && days <= 366;
}
export function formatWon(raw: string): string {
  const amount = Number(raw);
  if (!Number.isFinite(amount)) return '금액 확인 필요';
  return `${amount.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}원`;
}

const columns: Column<StaffRow>[] = [
  { key: 'staff', header: '담당자', width: 180, value: (row) => row.staff_name_snapshot || '담당 미지정' },
  { key: 'lines', header: '항목 수', width: 80, value: (row) => row.line_count },
  { key: 'total', header: '판매 항목 총액', width: 140, value: (row) => Number(row.gross_line_total), render: (row) => formatWon(row.gross_line_total) },
  { key: 'state', header: '확정 여부', width: 100, value: () => '수당 미확정' },
];

export interface ManagementPageProps { api: ApiClient; organizationId: string; readOnly: boolean }

/** 운영 수지 · 담당 매출 근거(분석·경영 실험실 미리보기). 관리자(owner/admin)만 조회한다. 확정 손익이 아니다. */
export function ManagementPage({ api, organizationId, readOnly }: ManagementPageProps) {
  const today = new Date();
  const [from, setFrom] = useState<string | null>(localDate(new Date(today.getFullYear(), today.getMonth(), 1)));
  const [to, setTo] = useState<string | null>(localDate(today));
  const [result, setResult] = useState<ManagementPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [periodError, setPeriodError] = useState('');

  const refresh = useCallback(async (start: string | null, end: string | null) => {
    if (!start || !end || !validPeriod(start, end)) { setPeriodError('시작일과 종료일을 366일 이내의 YYYY-MM-DD로 입력하세요.'); return; }
    setPeriodError(''); setError(''); setLoading(true);
    try {
      const preview = await api.call('GET', `/organizations/${organizationId}/management-preview?from_date=${start}&to_date=${end}`, managementPreviewSchema);
      // 확정 손익·수당 확정으로 표시된 응답은 이 화면이 보여 줄 수 없다(Python 클라이언트와 같은 방어).
      if (preview.is_final_profit || preview.staff_basis_is_commission) throw new Error('unexpected finalization');
      setResult(preview);
    } catch (failure) {
      setResult(null);
      setError((failure as { status?: number }).status === 403 ? '관리자만 조회할 수 있습니다.' : '조회하지 못했습니다. 서버와 036 SQL 적용 상태를 확인하고 다시 시도하세요.');
    } finally { setLoading(false); }
  }, [api, organizationId]);

  // 화면을 열거나 조직이 바뀔 때 기본 기간으로 한 번 조회한다. 기간을 바꾼 뒤에는 조회 버튼으로 다시 조회한다.
  useEffect(() => {
    if (!readOnly) void refresh(from, to);
  }, [readOnly, organizationId]);

  if (readOnly) {
    return (
      <section className="management-page">
        <div className="page-toolbar"><div><h1>운영 수지 · 담당 매출 근거</h1></div></div>
        <p role="alert" className="form-error">관리자(소유자·관리자)만 조회할 수 있습니다.</p>
      </section>
    );
  }

  return (
    <section className="management-page">
      <div className="page-toolbar"><div><h1>운영 수지 · 담당 매출 근거</h1><p className="muted">기록된 원장 기준의 읽기 전용 미리보기입니다.</p></div></div>
      <div className="management-filters">
        <label>시작일<DateField aria-label="시작일" value={from} onChange={setFrom} /></label>
        <label>종료일<DateField aria-label="종료일" value={to} onChange={setTo} /></label>
        <button type="button" className="primary-button" disabled={loading} onClick={() => void refresh(from, to)}>조회</button>
      </div>
      <p className="management-warning">관리손익 최종치가 아닙니다. 재고 원가·직원 수당·세금은 계산에 포함되지 않습니다. 담당 매출은 할인·환불 배분 전 판매 항목 총액이며 수당 확정액이 아닙니다.</p>
      {periodError && <p role="alert" className="form-error">{periodError}</p>}
      {error && <ErrorState message={error} onRetry={() => void refresh(from, to)} />}
      {loading && <LoadingState label="기록된 수지를 조회하는 중…" />}
      {result && !loading && (
        <>
          <p className="management-summary">기록된 수입 {formatWon(result.recorded_income)} · 지출 {formatWon(result.recorded_expense)} · 순액 {formatWon(result.recorded_net)}</p>
          <p className="management-summary">방문 수납 {formatWon(result.visit_receipts)} · 방문 환불 {formatWon(result.visit_refunds)} · 원장 거래 {result.transaction_count}건</p>
          <DataGrid rows={result.staff_sales_basis} columns={columns} rowKey={(row) => `${row.staff_id ?? 'none'}:${row.staff_name_snapshot}`} ariaLabel="담당자별 판매 근거" emptyText="해당 기간에 담당자별 판매 항목이 없습니다." />
          <p className="muted">조회 완료 · 해당 기간에 기록된 원장 기준{result.excluded_costs.length ? ` · 제외 항목: ${result.excluded_costs.join(', ')}` : ''}</p>
        </>
      )}
    </section>
  );
}
