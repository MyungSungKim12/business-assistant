import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DateField, Select, confirm, notify } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { salesApi, type TransactionInput } from './api';
import { ExportButton } from '../../lib/io/ExportButton';
import { transactionExportColumns } from '../../lib/io/domainColumns';
import { errorMessage, formatWon, isDefinitive, kst, moneyText, monthClosedMessage, newOperationId, today, wholeAmount } from './format';
import { LedgerTable, LedgerTotals } from './LedgerTable';
import { activeClosings, closedMonthNotice, closingForDate, defaultLedgerSort, searchTransactions, sortTransactions, summarizeLedger, type LedgerSort } from './ledger';
import { MonthClosePanel } from './MonthClosePanel';
import type { FinanceSummary, MonthClosing, Settlement, Transaction } from './types';
import './sales.css';

type Tab = 'ledger' | 'month' | 'settlement';
type TypeFilter = '' | 'income' | 'expense';
const blankForm = (): TransactionInput => ({ transaction_type: 'income', amount: '', transaction_date: today(), category: '', counterparty: '', memo: '', is_archived: false });
const toForm = (item: Transaction): TransactionInput => ({ transaction_type: item.transaction_type, amount: item.amount, transaction_date: item.transaction_date, category: item.category, counterparty: item.counterparty, memo: item.memo, is_archived: item.is_archived });
const sameForm = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b);

async function leave(dirty: boolean): Promise<boolean> {
  if (!dirty) return true;
  return confirm({ title: '저장하지 않은 변경', message: '저장하지 않은 변경 내용이 있습니다. 이동하시겠습니까?', confirmLabel: '이동', tone: 'danger' });
}

export function FinancePage({ api, organizationId, readOnly }: { api: ApiClient; organizationId: string; readOnly: boolean }) {
  const [tab, setTab] = useState<Tab>('ledger');
  const [dirty, setDirty] = useState(false);
  async function switchTab(next: Tab) { if (next !== tab && await leave(dirty)) { setDirty(false); setTab(next); } }
  return <section className="finance-page">
    <div className="page-toolbar"><div><p className="eyebrow">FINANCE</p><h1>수입·지출·정산</h1><p className="muted">수입·지출 내역, 월 단위 장부 마감, 일 매출 대사와 시재(일 마감)를 관리합니다.</p></div></div>
    {readOnly && <p className="permission-banner">조회 전용입니다. 등록·수정·마감은 관리자만 할 수 있습니다.</p>}
    <div className="sales-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={tab === 'ledger'} className={tab === 'ledger' ? 'is-active' : ''} onClick={() => void switchTab('ledger')}>수입·지출</button>
      <button type="button" role="tab" aria-selected={tab === 'month'} className={tab === 'month' ? 'is-active' : ''} onClick={() => void switchTab('month')}>월 마감</button>
      <button type="button" role="tab" aria-selected={tab === 'settlement'} className={tab === 'settlement' ? 'is-active' : ''} onClick={() => void switchTab('settlement')}>미수·일 마감</button>
    </div>
    {tab === 'ledger' && <LedgerPanel api={api} organizationId={organizationId} readOnly={readOnly} onDirty={setDirty} />}
    {tab === 'month' && <MonthClosePanel api={api} organizationId={organizationId} readOnly={readOnly} onDirty={setDirty} />}
    {tab === 'settlement' && <SettlementPanel api={api} organizationId={organizationId} readOnly={readOnly} onDirty={setDirty} />}
  </section>;
}

function LedgerPanel({ api, organizationId, readOnly, onDirty }: { api: ApiClient; organizationId: string; readOnly: boolean; onDirty: (dirty: boolean) => void }) {
  const [type, setType] = useState<TypeFilter>('');
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [rows, setRows] = useState<Transaction[]>([]);
  const [closings, setClosings] = useState<MonthClosing[]>([]);
  const [text, setText] = useState('');
  const [sort, setSort] = useState<LedgerSort>(defaultLedgerSort);
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Transaction | null>(null);
  const [form, setForm] = useState<TransactionInput>(blankForm);
  const [baseline, setBaseline] = useState<TransactionInput>(form);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const dirty = !sameForm(form, baseline);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  const ticket = useRef(0);

  const load = useCallback(async () => {
    if (from && to && from > to) { setError('조회 시작일은 종료일보다 늦을 수 없습니다.'); return; }
    const mine = ++ticket.current;
    setLoading(true);
    setError('');
    try {
      const filter = { type: type || undefined, from: from ?? undefined, to: to ?? undefined };
      // 월 마감 목록은 안내용이라 실패해도 거래 목록은 보여 준다(서버가 마감된 달의 저장을 막는다).
      const [list, totals, closed] = await Promise.all([
        salesApi.transactions(api, organizationId, filter), salesApi.summary(api, organizationId, { from: filter.from, to: filter.to }),
        salesApi.monthClosings(api, organizationId).catch(() => null),
      ]);
      if (mine !== ticket.current) return;
      setRows(list);
      setSummary(totals);
      if (closed) setClosings(closed);
    } catch (e) {
      if (mine !== ticket.current) return;
      setRows([]);
      setSummary(null);
      setError(e instanceof ApiError && e.status === 403 ? '재무 접근 권한이 없습니다.' : '재무 내역을 불러오지 못했습니다.');
    } finally { if (mine === ticket.current) setLoading(false); }
  }, [api, organizationId, type, from, to]);
  useEffect(() => { void load(); }, [load]);

  function reset(next: Transaction | null) {
    const value = next ? toForm(next) : blankForm();
    setSelected(next);
    setForm(value);
    setBaseline(value);
    setFormError('');
  }
  async function select(next: Transaction | null) {
    if ((next?.id ?? null) === (selected?.id ?? null) && !(next === null && dirty)) return;
    if (!await leave(dirty)) return;
    reset(next);
  }

  async function save() {
    const amount = form.amount.trim();
    const category = form.category.trim();
    if (!['income', 'expense'].includes(form.transaction_type) || !moneyText.test(amount) || Number(amount) <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(form.transaction_date) || !category || category.length > 200 || form.counterparty.length > 5000 || form.memo.length > 5000) {
      setFormError('유형, 일자, 금액(0보다 크고 소수 둘째 자리까지), 분류(200자 이하)를 확인하세요.');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      const input = { ...form, amount, category };
      const saved = selected ? await salesApi.updateTransaction(api, organizationId, selected.id, input) : await salesApi.createTransaction(api, organizationId, input);
      reset(selected ? saved : null);
      notify.success(selected ? '거래를 수정했습니다.' : '거래를 등록했습니다.');
      await load();
    } catch (e) {
      setFormError(isDefinitive(e) ? errorMessage(e) : '저장하지 못했습니다. 작성 내용은 유지됩니다.');
      if (monthClosedMessage(e)) void load();
    } finally { setSaving(false); }
  }
  async function toggleArchive() {
    if (!selected) return;
    const next = !selected.is_archived;
    if (!await confirm({ title: next ? '거래 보관' : '보관 해제', message: next ? '이 거래를 합계에서 제외하도록 보관할까요?' : '이 거래를 다시 합계에 포함할까요?', confirmLabel: next ? '보관' : '해제' })) return;
    setSaving(true);
    try {
      const saved = await salesApi.updateTransaction(api, organizationId, selected.id, { is_archived: next });
      reset(saved);
      await load();
    } catch (e) {
      setFormError(errorMessage(e, '보관 변경'));
      if (monthClosedMessage(e)) void load();
    } finally { setSaving(false); }
  }

  const visible = useMemo(() => sortTransactions(searchTransactions(rows, text), sort), [rows, text, sort]);
  const visibleSummary = useMemo(() => summarizeLedger(visible), [visible]);
  const closedMonths = useMemo(() => new Set(activeClosings(closings).keys()), [closings]);
  // 거래를 옮기는 수정은 원래 달과 새 달이 모두 열려 있어야 한다.
  const blocked = closingForDate(closings, form.transaction_date) ?? (selected ? closingForDate(closings, selected.transaction_date) : null);
  const blockedDate = closingForDate(closings, form.transaction_date) ? form.transaction_date : selected?.transaction_date ?? form.transaction_date;

  return <div className="finance-layout">
    <div className="finance-main finance-main--ledger">
      <div className="sales-filters">
        <label>조회 유형<Select aria-label="조회 유형" value={type} onChange={setType} options={[{ value: '', label: '전체' }, { value: 'income', label: '수입' }, { value: 'expense', label: '지출' }]} /></label>
        <label>시작일<DateField aria-label="시작일" value={from} onChange={setFrom} /></label>
        <label>종료일<DateField aria-label="종료일" value={to} onChange={setTo} /></label>
        <button type="button" onClick={() => void load()}>조회</button>
        <label>검색<input aria-label="거래 검색" placeholder="분류·거래처·메모" value={text} onChange={(e) => setText(e.target.value)} /></label>
        <ExportButton title="수입지출 내역" columns={transactionExportColumns} rows={visible} disabled={loading} />
      </div>
      {summary && <div className="sales-cards" data-testid="finance-summary">
        <div className="sales-card">수입 {formatWon(summary.income_total)}</div>
        <div className="sales-card">지출 {formatWon(summary.expense_total)}</div>
        <div className="sales-card">순액 {formatWon(summary.net_total)}</div>
        <div className="sales-card">거래 {summary.transaction_count}건</div>
      </div>}
      {error && <div role="alert" className="form-error">{error} <button type="button" onClick={() => void load()}>다시 시도</button></div>}
      {loading ? <p role="status" className="muted">재무 내역을 불러오는 중…</p> : <>
        <LedgerTotals summary={visibleSummary} filtered={text.trim() !== ''} />
        <LedgerTable rows={visible} sort={sort} onSort={setSort} selectedId={selected?.id ?? null} onSelect={(row) => void select(row)} closedMonths={closedMonths}
          emptyText={error ? '' : rows.length > 0 ? '검색 조건에 맞는 거래가 없습니다.' : '조회된 거래가 없습니다.'} />
      </>}
    </div>
    {!readOnly && <aside className="editor-panel">
      <h2>{selected ? '거래 수정' : '수입·지출 등록'}</h2>
      <label>거래 유형<Select aria-label="거래 유형" value={form.transaction_type} onChange={(value) => setForm({ ...form, transaction_type: value })} options={[{ value: 'income', label: '수입' }, { value: 'expense', label: '지출' }]} /></label>
      <label>일자<DateField aria-label="거래 일자" value={form.transaction_date || null} onChange={(value) => setForm({ ...form, transaction_date: value ?? '' })} /></label>
      <label>금액<input inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
      <label>분류<input maxLength={200} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></label>
      <label>거래처<input value={form.counterparty} onChange={(e) => setForm({ ...form, counterparty: e.target.value })} /></label>
      <label>메모<textarea value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} /></label>
      {blocked && <p role="alert" className="form-error" data-testid="closed-month-notice">{closedMonthNotice(blockedDate)}</p>}
      {formError && <p role="alert" className="form-error">{formError}</p>}
      <div className="sales-actions">
        <button type="button" className="primary-button" disabled={saving || blocked !== null} onClick={() => void save()}>{saving ? '저장 중…' : selected ? '수정 저장' : '등록'}</button>
        {selected && <button type="button" disabled={saving || blocked !== null} onClick={() => void toggleArchive()}>{selected.is_archived ? '보관 해제' : '보관'}</button>}
        {selected && <button type="button" disabled={saving} onClick={() => void select(null)}>새 거래</button>}
      </div>
    </aside>}
  </div>;
}

function SettlementPanel({ api, organizationId, readOnly, onDirty }: { api: ApiClient; organizationId: string; readOnly: boolean; onDirty: (dirty: boolean) => void }) {
  const [date, setDate] = useState<string>(today());
  const [data, setData] = useState<Settlement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cash, setCash] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const operation = useRef<{ id: string; signature: string } | null>(null);
  const ticket = useRef(0);
  const dirty = reason.trim() !== '' || (data?.close ? cash !== data.close.counted_cash : cash !== '');
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  const load = useCallback(async (day: string) => {
    const mine = ++ticket.current;
    setLoading(true);
    setError('');
    try {
      const result = await salesApi.settlement(api, organizationId, day);
      if (mine !== ticket.current) return;
      setData(result);
      setCash(result.close?.counted_cash ?? '');
      setReason('');
    } catch (e) {
      if (mine !== ticket.current) return;
      setData(null);
      setError(e instanceof ApiError && e.status === 403 ? '정산 조회 권한이 없습니다.' : '정산 내역을 불러오지 못했습니다. 다시 시도하세요.');
    } finally { if (mine === ticket.current) setLoading(false); }
  }, [api, organizationId]);
  useEffect(() => { void load(date); }, [load, date]);

  async function changeDate(next: string | null) {
    if (!next || next === date || !await leave(dirty)) return;
    operation.current = null;
    setMessage('');
    setDate(next);
  }

  async function save() {
    if (!data || saving) return;
    const counted = cash.trim();
    const why = reason.trim();
    if (!wholeAmount.test(counted)) { setMessage('실제 시재는 0원 이상의 정수 숫자(12자리 이하)로 입력하세요.'); return; }
    if (!why || why.length > 1000) { setMessage('마감 또는 정정 사유를 입력하세요.'); return; }
    const adjusting = data.close !== null;
    const action = adjusting ? '마감 정정' : '일 마감';
    if (!await confirm({ title: `${action} 확인`, message: `${date} 정산을 ${action}하시겠습니까? 저장 후에는 변경 이력으로 남습니다.`, confirmLabel: action })) return;
    const signature = JSON.stringify([date, counted, why, adjusting ? data.close!.version : 0]);
    if (operation.current?.signature !== signature) operation.current = { id: newOperationId(), signature };
    setSaving(true);
    setMessage('');
    try {
      const body = { operation_id: operation.current.id, counted_cash: counted, reason: why, confirmed: true as const };
      const result = adjusting
        ? await salesApi.adjustClose(api, organizationId, date, { ...body, expected_version: data.close!.version })
        : await salesApi.closeDay(api, organizationId, date, body);
      operation.current = null;
      setData(result);
      setCash(result.close?.counted_cash ?? '');
      setReason('');
      notify.success(`${action}을 저장했습니다.`);
    } catch (e) {
      if (isDefinitive(e)) operation.current = null;
      setMessage(isDefinitive(e) ? errorMessage(e) : '저장 결과를 확인하지 못했습니다. 같은 내용으로 다시 저장하거나 새로고침 후 상태를 확인하세요.');
    } finally { setSaving(false); }
  }

  return <div className="settlement-panel">
    <div className="sales-filters">
      <label>영업일<DateField aria-label="영업일" value={date} onChange={(value) => void changeDate(value)} /></label>
      <button type="button" disabled={loading || saving} onClick={() => void load(date)}>새로고침</button>
    </div>
    <p className="muted">영업일 시재(현금)를 맞추는 일 마감입니다. 한 달 장부를 잠그는 월 마감은 '월 마감' 탭에서 합니다.</p>
    {error && <div role="alert" className="form-error">{error} <button type="button" onClick={() => void load(date)}>다시 시도</button></div>}
    {loading && <p role="status" className="muted">정산 내역을 불러오는 중…</p>}
    {data && !loading && <>
      <div className="sales-cards" data-testid="settlement-summary">
        <div className="sales-card">현금 수납 {formatWon(data.cash_received)} / 환불 {formatWon(data.cash_refunded)}</div>
        <div className="sales-card">카드 수납 {formatWon(data.card_received)} / 환불 {formatWon(data.card_refunded)}</div>
        <div className="sales-card">이체 수납 {formatWon(data.transfer_received)} / 환불 {formatWon(data.transfer_refunded)}</div>
        <div className="sales-card">예상 시재 {formatWon(data.expected_cash)}</div>
      </div>
      <p data-testid="close-status">{data.close ? `마감 완료 · 정정 ${Math.max(data.close.version - 1, 0)}회 · 차이 ${formatWon(data.close.variance)} · ${kst(data.close.closed_at)}` : '마감 전'}</p>
      <div className="data-surface"><table><caption>미수 고객</caption><thead><tr><th>고객</th><th>총액</th><th>수납액</th><th>미수금</th></tr></thead>
        <tbody>{data.receivables.map((item) => <tr key={item.cart_id}><td>{item.customer_name}</td><td>{formatWon(item.total_amount)}</td><td>{formatWon(item.received_amount)}</td><td>{formatWon(item.due_amount)}</td></tr>)}</tbody></table>
        {data.receivables.length === 0 && <p className="empty-state">미수 고객이 없습니다.</p>}
      </div>
      {data.close && data.close.adjustments.length > 0 && <details><summary>정정 이력 {data.close.adjustments.length}건</summary><ul>{data.close.adjustments.map((item) => <li key={item.version}>{kst(item.adjusted_at)} · {formatWon(item.previous_counted_cash)} → {formatWon(item.counted_cash)} · {item.reason}</li>)}</ul></details>}
      {!readOnly && <div className="editor-panel">
        <h2>{data.close ? '마감 정정' : '마감 입력'}</h2>
        <p className="muted">실제 시재와 사유를 입력해 마감하세요. 마감 후 정정은 별도 이력으로 남습니다.</p>
        <label>실제 현금 시재<input inputMode="numeric" maxLength={12} placeholder="실제 현금 시재 (원)" value={cash} onChange={(e) => setCash(e.target.value)} /></label>
        <label>사유<input maxLength={1000} placeholder="마감 또는 정정 사유" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        {message && <p role="alert" className="form-error">{message}</p>}
        <div className="sales-actions"><button type="button" className="primary-button" disabled={saving} onClick={() => void save()}>{data.close ? '마감 정정' : '마감 저장'}</button></div>
      </div>}
    </>}
  </div>;
}
