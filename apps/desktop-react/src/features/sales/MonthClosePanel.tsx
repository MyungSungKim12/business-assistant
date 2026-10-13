import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { confirm, notify } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { salesApi } from './api';
import { errorMessage, formatWon, isDefinitive, kst, today } from './format';
import { activeClosings, isMonthKey, monthFirstDay, monthLastDay, previousMonth } from './ledger';
import type { FinanceSummary, MonthClosing } from './types';

interface Props {
  api: ApiClient;
  organizationId: string;
  /** 조회 전용이면 마감·재오픈 버튼을 숨긴다(서버도 owner/admin만 허용한다) */
  readOnly: boolean;
  onDirty: (dirty: boolean) => void;
}

const SERVER_CODES = new Set(['FINANCE_MONTH_ALREADY_CLOSED', 'FINANCE_MONTH_NOT_CLOSED']);

/** 서버가 한국어로 준 월 마감 안내는 그대로, 나머지는 공통 문구로 보여 준다. */
export function monthActionMessage(error: unknown): string {
  if (error instanceof ApiError && SERVER_CODES.has(error.code)) return error.message;
  if (isDefinitive(error)) return errorMessage(error);
  return '결과를 확인하지 못했습니다. 새로고침해 마감 상태를 확인한 뒤 다시 시도하세요.';
}

/**
 * 재무 월 마감(장부 잠금). 영업일 시재를 맞추는 ‘일 마감’과 별개다.
 * 마감된 달은 그 달 날짜의 수입·지출 등록·수정(보관 포함)이 막히고, 관리자가 사유를 남겨 재오픈할 수 있다.
 */
export function MonthClosePanel({ api, organizationId, readOnly, onDirty }: Props) {
  const todayKey = today();
  const currentMonth = todayKey.slice(0, 7);
  const [month, setMonth] = useState(() => previousMonth(todayKey));
  const [closings, setClosings] = useState<MonthClosing[]>([]);
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const ticket = useRef(0);
  useEffect(() => onDirty(note.trim() !== ''), [note, onDirty]);

  const load = useCallback(async () => {
    if (!isMonthKey(month)) { setError('마감 월을 선택하세요.'); setSummary(null); setLoading(false); return; }
    const mine = ++ticket.current;
    setLoading(true);
    setError('');
    try {
      const [list, totals] = await Promise.all([
        salesApi.monthClosings(api, organizationId),
        salesApi.summary(api, organizationId, { from: monthFirstDay(month), to: monthLastDay(month) }),
      ]);
      if (mine !== ticket.current) return;
      setClosings(list);
      setSummary(totals);
    } catch (e) {
      if (mine !== ticket.current) return;
      setSummary(null);
      setError(e instanceof ApiError && e.status === 403 ? '재무 접근 권한이 없습니다.' : '월 마감 정보를 불러오지 못했습니다.');
    } finally { if (mine === ticket.current) setLoading(false); }
  }, [api, organizationId, month]);
  useEffect(() => { void load(); }, [load]);

  const active = useMemo(() => activeClosings(closings), [closings]);
  const current = active.get(month) ?? null;
  const future = isMonthKey(month) && month > currentMonth;
  const history = useMemo(() => [...closings].sort((a, b) => b.month.localeCompare(a.month) || b.closed_at.localeCompare(a.closed_at)), [closings]);

  async function submit() {
    if (saving || !isMonthKey(month)) return;
    const why = note.trim();
    if (!why || why.length > 1000) { setMessage(current ? '재오픈 사유를 입력하세요(1,000자 이하).' : '마감 메모를 입력하세요(1,000자 이하).'); return; }
    if (!current && future) { setMessage('아직 시작되지 않은 달은 마감할 수 없습니다.'); return; }
    const reopening = current !== null;
    const warning = month === currentMonth && !reopening ? ' 이번 달을 마감하면 오늘 날짜로 기록되는 수납·환불도 거절됩니다.' : '';
    const ok = await confirm(reopening
      ? { title: '월 마감 재오픈', message: `${month} 월 마감을 재오픈할까요? 재오픈하면 이 달 날짜의 거래를 다시 등록·수정할 수 있고, 사유가 이력으로 남습니다.`, confirmLabel: '재오픈', tone: 'danger' }
      : { title: '월 마감 확인', message: `${month} 수입·지출 장부를 마감할까요? 마감하면 이 달 날짜의 거래 등록·수정·보관이 막힙니다.${warning} 관리자가 사유를 남겨 재오픈할 수 있습니다. (영업일 시재를 맞추는 일 마감과는 별개입니다.)`, confirmLabel: '월 마감' });
    if (!ok) return;
    setSaving(true);
    setMessage('');
    try {
      if (reopening) await salesApi.reopenMonth(api, organizationId, monthFirstDay(month), why);
      else await salesApi.closeMonth(api, organizationId, monthFirstDay(month), why);
      setNote('');
      notify.success(reopening ? `${month} 월 마감을 재오픈했습니다.` : `${month} 장부를 마감했습니다.`);
      await load();
    } catch (e) {
      setMessage(monthActionMessage(e));
      if (!isDefinitive(e) || (e instanceof ApiError && SERVER_CODES.has(e.code))) await load();
    } finally { setSaving(false); }
  }

  return <div className="month-close-panel">
    <p className="muted">월 마감은 한 달의 수입·지출 장부를 잠급니다. 영업일 시재(현금)를 맞추는 ‘미수·일 마감’과는 별개입니다.</p>
    <div className="sales-filters">
      <label>마감 월<input type="month" aria-label="마감 월" value={month} onChange={(e) => { setMessage(''); setMonth(e.target.value); }} /></label>
      <button type="button" disabled={loading || saving} onClick={() => void load()}>새로고침</button>
    </div>
    {error && <div role="alert" className="form-error">{error} <button type="button" onClick={() => void load()}>다시 시도</button></div>}
    {loading && !error && <p role="status" className="muted">월 마감 정보를 불러오는 중…</p>}
    {!loading && !error && summary && <>
      <div className="sales-cards" data-testid="month-summary">
        <div className="sales-card">수입 {formatWon(summary.income_total)}</div>
        <div className="sales-card">지출 {formatWon(summary.expense_total)}</div>
        <div className="sales-card">순액 {formatWon(summary.net_total)}</div>
        <div className="sales-card">거래 {summary.transaction_count}건</div>
      </div>
      <p className="month-close__status" data-testid="month-status">
        {current ? `${month} 마감됨 · ${kst(current.closed_at)} · 메모: ${current.note}` : future ? `${month}은(는) 아직 시작되지 않은 달입니다.` : `${month} 열림(마감 전)`}
      </p>
      {!readOnly && <div className="editor-panel month-close">
        <h2>{current ? '월 마감 재오픈' : '월 마감'}</h2>
        <div className="month-close__row">
          <label className="month-close__reason">{current ? '재오픈 사유' : '마감 메모'}<input maxLength={1000} placeholder={current ? '재오픈하는 이유' : '예: 10월 결산 확인 완료'} value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <button type="button" data-testid="month-close-submit" className={current ? 'danger-button' : 'primary-button'} disabled={saving || (!current && future)} onClick={() => void submit()}>{saving ? '처리 중…' : current ? '월 마감 재오픈' : '월 마감'}</button>
        </div>
        {message && <p role="alert" className="form-error">{message}</p>}
      </div>}
    </>}
    <div className="data-surface month-close__table">
      <table><caption>월 마감 이력</caption>
        <thead><tr><th>월</th><th>상태</th><th>마감 일시</th><th>마감 메모</th><th>재오픈</th></tr></thead>
        <tbody>{history.map((item) => <tr key={item.id}>
          <td><button type="button" className="sales-link" onClick={() => { setMessage(''); setMonth(item.month.slice(0, 7)); }}>{item.month.slice(0, 7)}</button></td>
          <td>{item.reopened_at === null ? '마감' : '재오픈됨'}</td><td>{kst(item.closed_at)}</td><td title={item.note}>{item.note}</td>
          <td title={item.reopen_reason ?? ''}>{item.reopened_at === null ? '' : `${kst(item.reopened_at)} · ${item.reopen_reason ?? ''}`}</td>
        </tr>)}</tbody>
      </table>
      {!loading && history.length === 0 && <p className="empty-state">월 마감 이력이 없습니다.</p>}
    </div>
  </div>;
}
