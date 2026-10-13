import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DateField, Modal, Select, notify } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import type { Customer } from '../../api/schemas';
import { ApiError } from '../../api/errors';
import { exportTable, type ExportFormat } from '../../lib/io/exportTable';
import '../../lib/io/io.css';
import { salesApi } from './api';
import { formatWon, kst, methodLabel } from './format';
import {
  PAGE_SIZE, blankHistoryForm, collectAllRows, defaultSort, kindLabel, kindOptions, methodOptions, nextSort, referenceText, salePaymentExportColumns,
  serverSortOf, sortHistoryRows, toSearchFilter, type HistoryForm, type HistorySort,
} from './paymentHistory';
import type { SalePayment, SalePaymentsPage } from './types';

interface Props {
  api: ApiClient;
  organizationId: string;
  /** 행의 방문 장바구니를 장바구니 탭에서 연다 */
  onOpenVisit: (row: SalePayment) => void;
}

const sortHeaders: Array<{ key: HistorySort['key']; label: string }> = [
  { key: 'occurred_at', label: '일시' }, { key: 'customer_name', label: '고객' }, { key: 'kind', label: '유형' }, { key: 'method', label: '수단' }, { key: 'amount', label: '금액' },
];

function failureText(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) return '매출 내역을 볼 권한이 없습니다.';
  if (error instanceof ApiError && (error.status === 400 || error.status === 422)) return '검색 조건을 확인하세요.';
  return '매출 내역을 불러오지 못했습니다. 다시 시도하세요.';
}

/** 수납·환불·반품 내역을 조건으로 검색하고 합계를 보여 준다. 읽기 전용이다. */
export function PaymentHistoryPanel({ api, organizationId, onOpenVisit }: Props) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [form, setForm] = useState<HistoryForm>(blankHistoryForm);
  const [applied, setApplied] = useState<HistoryForm>(blankHistoryForm);
  const [sort, setSort] = useState<HistorySort>(defaultSort);
  const [rows, setRows] = useState<SalePayment[]>([]);
  const [totals, setTotals] = useState<SalePaymentsPage['totals'] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const ticket = useRef(0);

  useEffect(() => {
    let live = true;
    api.listCustomers(organizationId).then((list) => { if (live) setCustomers(list); }, () => { if (live) setMessage('고객 목록을 불러오지 못해 고객 조건은 쓸 수 없습니다.'); });
    return () => { live = false; };
  }, [api, organizationId]);

  const searchFilter = useMemo(() => toSearchFilter(applied), [applied]);
  const serverSort = serverSortOf(sort);

  const load = useCallback(async () => {
    if (!searchFilter.ok) return;
    const mine = ++ticket.current;
    setLoading(true);
    setError('');
    try {
      const page = await salesApi.salePayments(api, organizationId, { ...searchFilter.filter, sort: serverSort, limit: PAGE_SIZE });
      if (mine !== ticket.current) return;
      setRows(page.rows);
      setTotals(page.totals);
      setCursor(page.next_cursor);
    } catch (e) {
      if (mine !== ticket.current) return;
      setRows([]);
      setTotals(null);
      setCursor(null);
      setError(failureText(e));
    } finally { if (mine === ticket.current) setLoading(false); }
  }, [api, organizationId, searchFilter, serverSort]);
  useEffect(() => { void load(); }, [load]);

  async function loadMore() {
    if (!cursor || more || !searchFilter.ok) return;
    const mine = ticket.current;
    setMore(true);
    try {
      const page = await salesApi.salePayments(api, organizationId, { ...searchFilter.filter, sort: serverSort, limit: PAGE_SIZE, cursor });
      if (mine !== ticket.current) return;
      setRows((old) => { const known = new Set(old.map((item) => item.id)); return [...old, ...page.rows.filter((item) => !known.has(item.id))]; });
      setTotals(page.totals);
      setCursor(page.next_cursor);
    } catch (e) { notify.error(failureText(e)); } finally { setMore(false); }
  }

  function search() {
    const result = toSearchFilter(form);
    if (!result.ok) { setMessage(result.message); return; }
    setMessage('');
    setApplied(form);
  }
  function reset() {
    setMessage('');
    setForm(blankHistoryForm());
    setApplied(blankHistoryForm());
  }

  async function runExport(format: ExportFormat) {
    if (!searchFilter.ok || exporting) return;
    setExporting(true);
    try {
      const { rows: all, tooMany } = await collectAllRows((next) => salesApi.salePayments(api, organizationId, { ...searchFilter.filter, sort: serverSort, limit: 200, cursor: next }));
      if (tooMany) { notify.error('조건에 맞는 내역이 너무 많습니다. 기간이나 조건을 좁혀 다시 시도하세요.'); return; }
      const saved = await exportTable({ title: '매출 내역', columns: salePaymentExportColumns, rows: sortHistoryRows(all, sort), format });
      if (saved) { notify.success(`${all.length.toLocaleString('ko-KR')}건을 ${format === 'xlsx' ? '엑셀' : 'CSV'} 파일로 저장했습니다.`); setExportOpen(false); }
    } catch (e) {
      notify.error(e instanceof ApiError ? failureText(e) : e instanceof Error ? e.message : '내보내기에 실패했습니다.');
    } finally { setExporting(false); }
  }

  const shown = useMemo(() => sortHistoryRows(rows, sort), [rows, sort]);
  const customerOptions = useMemo(() => [{ value: '', label: '전체 고객' }, ...[...customers].sort((a, b) => a.name.localeCompare(b.name, 'ko')).map((item) => ({ value: item.id, label: item.name }))], [customers]);
  const ariaSort = (key: HistorySort['key']) => (sort.key === key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none');
  const clientSorted = sort.key !== 'occurred_at' && cursor !== null;

  return <div className="history-panel">
    <div className="sales-filters" role="search" aria-label="매출 내역 검색">
      <label>시작일<DateField aria-label="시작일" value={form.from} onChange={(from) => setForm({ ...form, from })} /></label>
      <label>종료일<DateField aria-label="종료일" value={form.to} onChange={(to) => setForm({ ...form, to })} /></label>
      <label>고객<Select aria-label="고객 조건" value={form.customerId} onChange={(customerId) => setForm({ ...form, customerId })} options={customerOptions} /></label>
      <label>수단<Select aria-label="수단" value={form.method} onChange={(method) => setForm({ ...form, method })} options={[...methodOptions]} /></label>
      <label>유형<Select aria-label="유형" value={form.kind} onChange={(kind) => setForm({ ...form, kind })} options={[...kindOptions]} /></label>
      <label>최소 금액<input aria-label="최소 금액" inputMode="numeric" maxLength={14} placeholder="원" value={form.minAmount} onChange={(e) => setForm({ ...form, minAmount: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') search(); }} /></label>
      <label>최대 금액<input aria-label="최대 금액" inputMode="numeric" maxLength={14} placeholder="원" value={form.maxAmount} onChange={(e) => setForm({ ...form, maxAmount: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') search(); }} /></label>
      <button type="button" className="primary-button" disabled={loading} onClick={search}>검색</button>
      <button type="button" disabled={loading} onClick={reset}>조건 초기화</button>
      <button type="button" disabled={loading || error !== '' || !totals} onClick={() => setExportOpen(true)}>내보내기</button>
    </div>
    {message && <p role="alert" className="form-error">{message}</p>}
    {totals && <div className="sales-cards" data-testid="history-totals">
      <div className="sales-card">수납 {formatWon(totals.payment_total)} ({totals.payment_count}건)</div>
      <div className="sales-card">환불·반품 {formatWon(totals.refund_total)} ({totals.refund_count}건)</div>
      <div className="sales-card">순매출 {formatWon(totals.net_total)}</div>
    </div>}
    {error && <div role="alert" className="form-error">{error} <button type="button" onClick={() => void load()}>다시 시도</button></div>}
    {loading ? <p role="status" className="muted">매출 내역을 불러오는 중…</p> : <div className="data-surface history-table">
      <table><caption>수납·환불·반품 내역</caption>
        <thead><tr>
          {sortHeaders.map((header) => <th key={header.key} aria-sort={ariaSort(header.key)}>
            <button type="button" className="sales-link history-sort" onClick={() => setSort(nextSort(sort, header.key))}>{header.label}{sort.key === header.key ? (sort.direction === 'asc' ? ' ▲' : ' ▼') : ''}</button>
          </th>)}
          <th>참조·사유</th><th>방문</th>
        </tr></thead>
        <tbody>{shown.map((row) => <tr key={row.id} className={row.kind === 'payment' ? '' : 'history-negative'}>
          <td>{kst(row.occurred_at)}</td><td>{row.customer_name}</td><td>{kindLabel[row.kind]}</td><td>{methodLabel[row.method]}</td>
          <td className="history-amount">{row.kind === 'payment' ? '' : '-'}{formatWon(row.amount)}</td>
          <td title={referenceText(row)}>{referenceText(row)}</td>
          <td><button type="button" className="sales-link" aria-label={`방문 장바구니 열기 ${row.customer_name}`} onClick={() => onOpenVisit(row)}>장바구니</button></td>
        </tr>)}</tbody>
      </table>
      {!error && rows.length === 0 && <p className="empty-state">조건에 맞는 내역이 없습니다.</p>}
    </div>}
    {!loading && totals && <div className="history-footer">
      <span className="muted" data-testid="history-count">{rows.length.toLocaleString('ko-KR')}건 표시 / 조건에 맞는 전체 {totals.row_count.toLocaleString('ko-KR')}건{clientSorted ? ' · 시각 외 열 정렬은 표시된 건 기준입니다.' : ''}</span>
      {cursor && <button type="button" disabled={more} onClick={() => void loadMore()}>{more ? '불러오는 중…' : '더 보기'}</button>}
    </div>}
    {exportOpen && <Modal title="매출 내역 내보내기" size="sm" onClose={() => { if (!exporting) setExportOpen(false); }}>
      <p className="io-note">현재 검색 조건에 맞는 전체 {(totals?.row_count ?? 0).toLocaleString('ko-KR')}건(화면에 표시된 쪽수와 무관)을 저장합니다.</p>
      <div className="ba-actions">
        <button type="button" disabled={exporting} onClick={() => void runExport('csv')}>CSV (.csv)</button>
        <button type="button" className="ba-primary" disabled={exporting} onClick={() => void runExport('xlsx')}>{exporting ? '저장 중…' : '엑셀 (.xlsx)'}</button>
      </div>
    </Modal>}
  </div>;
}
