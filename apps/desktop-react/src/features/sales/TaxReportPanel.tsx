import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DateField } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { ExportButton } from '../../lib/io/ExportButton';
import { errorMessage, today } from './format';
import { wonOf } from '../dashboard/dashboardMetrics';
import { salesApi } from './api';
import { byCategory, byMonth, categoryExportColumns, monthExportColumns, taxDetailColumns, taxDetailRows, totalsOf } from './taxReport';
import type { Transaction } from './types';
import './sales.css';

/** 분류별·월별 요약과 세무 자료 내보내기(FIN-11). 기간의 수입·지출을 한 번 읽어 화면에서 계산하며, 보관된 거래는 제외한다. */
export function TaxReportPanel({ api, organizationId }: { api: ApiClient; organizationId: string }) {
  const year = today().slice(0, 4);
  const [from, setFrom] = useState<string | null>(`${year}-01-01`);
  const [to, setTo] = useState<string | null>(today());
  const [rows, setRows] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const ticket = useRef(0);

  const load = useCallback(async () => {
    if (from && to && from > to) { setError('시작일은 종료일보다 늦을 수 없습니다.'); return; }
    const mine = ++ticket.current;
    setLoading(true); setError('');
    try {
      const list = await salesApi.transactions(api, organizationId, { from: from ?? undefined, to: to ?? undefined });
      if (mine !== ticket.current) return;
      setRows(list);
    } catch (e) {
      if (mine !== ticket.current) return;
      setRows([]); setError(errorMessage(e, '조회'));
    } finally { if (mine === ticket.current) setLoading(false); }
  }, [api, organizationId, from, to]);
  useEffect(() => { void load(); }, [load]);

  const totals = useMemo(() => totalsOf(rows, from, to), [rows, from, to]);
  const categories = useMemo(() => byCategory(rows, from, to), [rows, from, to]);
  const months = useMemo(() => byMonth(rows, from, to), [rows, from, to]);
  const detail = useMemo(() => taxDetailRows(rows, from, to), [rows, from, to]);
  const topExpense = categories.reduce((max, row) => (row.expense > max ? row.expense : max), 0n);

  return <div className="tax-report">
    <div className="sales-filters">
      <label>시작일<DateField aria-label="시작일" value={from} onChange={setFrom} /></label>
      <label>종료일<DateField aria-label="종료일" value={to} onChange={setTo} /></label>
      <button type="button" onClick={() => void load()}>조회</button>
      <ExportButton title="분류별 수입지출" label="분류별 내보내기" columns={categoryExportColumns} rows={categories} disabled={loading || categories.length === 0} />
      <ExportButton title="월별 수입지출" label="월별 내보내기" columns={monthExportColumns} rows={months} disabled={loading || months.length === 0} />
      <ExportButton title="세무용 거래 상세" label="세무용 상세 내보내기" columns={taxDetailColumns} rows={detail} disabled={loading || detail.length === 0}
        description={`보관된 거래를 뺀 ${detail.length.toLocaleString('ko-KR')}건을 거래일 순으로 저장합니다. 세무사에게 전달하는 참고 자료이며 부가세·원천세는 계산하지 않습니다.`} />
    </div>
    {error && <div role="alert" className="form-error">{error} <button type="button" onClick={() => void load()}>다시 시도</button></div>}
    {loading ? <p role="status" className="muted">수입·지출을 불러오는 중…</p> : <>
      <div className="sales-cards" data-testid="tax-totals">
        <div className="sales-card">수입 {wonOf(totals.income)}</div>
        <div className="sales-card">지출 {wonOf(totals.expense)}</div>
        <div className="sales-card">순액 {wonOf(totals.net)}</div>
        <div className="sales-card">거래 {totals.count}건</div>
      </div>
      <div className="tax-report__grid">
        <div className="data-surface">
          <table>
            <caption>분류별 합계</caption>
            <thead><tr><th>분류</th><th>수입</th><th>지출</th><th>순액</th><th>건수</th><th aria-hidden="true">지출 비중</th></tr></thead>
            <tbody>
              {categories.map((row) => (
                <tr key={row.category}>
                  <td>{row.category}</td><td>{wonOf(row.income)}</td><td>{wonOf(row.expense)}</td><td>{wonOf(row.net)}</td><td>{row.count}</td>
                  <td aria-hidden="true"><i className="tax-bar" style={{ width: `${topExpense > 0n ? Number((row.expense * 100n) / topExpense) : 0}%` }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {categories.length === 0 && <p className="empty-state">이 기간에 거래가 없습니다.</p>}
        </div>
        <div className="data-surface">
          <table>
            <caption>월별 합계</caption>
            <thead><tr><th>월</th><th>수입</th><th>지출</th><th>순액</th><th>건수</th></tr></thead>
            <tbody>{months.map((row) => <tr key={row.month}><td>{row.month}</td><td>{wonOf(row.income)}</td><td>{wonOf(row.expense)}</td><td>{wonOf(row.net)}</td><td>{row.count}</td></tr>)}</tbody>
          </table>
          {months.length === 0 && <p className="empty-state">이 기간에 거래가 없습니다.</p>}
        </div>
      </div>
    </>}
  </div>;
}
