import { usePrivacy } from '../../lib/privacy';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DataGrid, DateField, ErrorState, LoadingState, Modal, Select, confirm, notify, type Column } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import type { Customer } from '../../api/schemas';
import { treatmentApi } from './api';
import { useStable } from './useStable';
import { ConsultationDialog } from './ConsultationDialog';
import { EventsDialog } from './EventsDialog';
import { SaleDraftDialog } from './SaleDraftDialog';
import { TreatmentPhotos } from './TreatmentPhotos';
import {
  ALL_CATEGORIES, consultationReady, emptyForm, errorStatus, filterCustomers, filterRecords, formDirty, formFromRecord, isLocked, localTime, newOperationId,
  sortRecords, statusLabel, todayIso, validateForm, type FormState, type RecordFilters,
} from './logic';
import type { MutationBody, Treatment, TreatmentAction } from './schemas';
import './treatments.css';

export type DocumentsPanelContext = { organizationId: string; customerId: string; treatmentId: string; readOnly: boolean; onClose: () => void };
export type TreatmentPageProps = {
  api: ApiClient; organizationId: string; readOnly: boolean;
  /** 고객관리 등에서 특정 고객으로 열 때 지정한다. */
  initialCustomerId?: string;
  /** 작성 중인 내용이 있는지 알려 메뉴 이동 보호에 쓴다. */
  onDirtyChange?: (dirty: boolean) => void;
  /** 문서 발행·이력 화면(다른 모듈)을 연결하면 '문서 발행·이력' 버튼이 나타난다. */
  documentsPanel?: (context: DocumentsPanelContext) => ReactNode;
};
type Message = { tone: 'info' | 'error'; text: string };
type Dialog = null | 'consult' | 'events' | 'sale' | 'documents' | 'cancel';

const columns: Column<Treatment>[] = [
  { key: 'date', header: '시술일', value: (r) => r.treatment_date, width: 96 },
  { key: 'name', header: '시술명', value: (r) => r.treatment_name, title: (r) => r.notes || r.treatment_name },
  { key: 'practitioner', header: '담당자', value: (r) => r.practitioner || '-' },
  { key: 'status', header: '상태', value: (r) => statusLabel(r.status), width: 80 },
];

async function confirmLeave(dirty: boolean): Promise<boolean> {
  if (!dirty) return true;
  return confirm({ title: '작성 중인 시술 기록', message: '저장하지 않은 변경 내용이 있습니다. 버리고 이동하시겠습니까?', confirmLabel: '버리고 이동', tone: 'danger' });
}

export function TreatmentPage({ api, organizationId, readOnly, initialCustomerId, onDirtyChange, documentsPanel }: TreatmentPageProps) {
  const privacy = usePrivacy();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customersState, setCustomersState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [customerQuery, setCustomerQuery] = useState('');
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [records, setRecords] = useState<Treatment[]>([]);
  const [recordsState, setRecordsState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [recordId, setRecordId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(() => emptyForm());
  const [baseline, setBaseline] = useState<FormState>(() => emptyForm());
  const [copied, setCopied] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [reason, setReason] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [filters, setFilters] = useState<RecordFilters>({ query: '', from: '', to: '', category: ALL_CATEGORIES });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [consultation, setConsultation] = useState<{ customer: Customer; record: Treatment } | null>(null);
  const [opening, setOpening] = useState(false);
  const generation = useRef(0);
  const pending = useRef<{ fingerprint: string; operationId: string } | null>(null);

  const writable = !readOnly;
  const customer = customers.find((item) => item.id === customerId) ?? null;
  const record = records.find((item) => item.id === recordId);
  const locked = isLocked(record);
  const dirty = writable && (formDirty(form, baseline) || correcting);
  const busy = saving || recordsState === 'loading' || opening;
  const fieldsReadOnly = !writable || (locked && !correcting);
  const reportDirty = useStable((value: boolean) => onDirtyChange?.(value));
  useEffect(() => { reportDirty(dirty); }, [dirty, reportDirty]);
  useEffect(() => () => reportDirty(false), [reportDirty]);
  const closeDialog = useStable(() => setDialog(null));

  const populate = useCallback((next: FormState) => { setForm(next); setBaseline(next); }, []);
  const resetEditor = useCallback(() => {
    pending.current = null;
    setConflicted(false); setCorrecting(false); setReason(''); setCopied(false);
  }, []);

  const loadRecords = useCallback(async (targetCustomer: string, keepRecordId: string | null) => {
    const current = ++generation.current;
    setRecordsState('loading');
    setMessage({ tone: 'info', text: '시술 이력을 불러오는 중…' });
    try {
      const rows = sortRecords(await treatmentApi.list(api, organizationId, targetCustomer));
      if (current !== generation.current) return;
      setRecords(rows);
      resetEditor();
      const kept = rows.find((item) => item.id === keepRecordId);
      setRecordId(kept?.id ?? null);
      populate(kept ? formFromRecord(kept) : emptyForm());
      setRecordsState('ready');
      setMessage({ tone: 'info', text: rows.length ? '시술 이력을 불러왔습니다.' : '아직 시술 기록이 없습니다.' });
    } catch {
      if (current !== generation.current) return;
      setRecordsState('error');
      setMessage({ tone: 'error', text: '조회 실패 · 새로고침으로 재시도하세요.' });
    }
  }, [api, organizationId, populate, resetEditor]);

  const selectCustomer = useCallback((id: string) => {
    setCustomerId(id);
    setRecords([]); setRecordId(null); resetEditor(); populate(emptyForm());
    void loadRecords(id, null);
  }, [loadRecords, populate, resetEditor]);

  const loadCustomers = useCallback(async () => {
    setCustomersState('loading');
    try {
      const rows = await api.listCustomers(organizationId);
      setCustomers(rows);
      setCustomersState('ready');
      const first = rows.find((item) => item.id === initialCustomerId) ?? rows[0];
      if (first) selectCustomer(first.id);
    } catch { setCustomersState('error'); }
  }, [api, organizationId, initialCustomerId, selectCustomer]);
  useEffect(() => { void loadCustomers(); return () => { generation.current += 1; }; }, [loadCustomers]);

  const openCustomer = async (id: string) => {
    if (id === customerId || saving) return;
    if (!await confirmLeave(dirty)) return;
    selectCustomer(id);
  };
  const reload = async () => {
    if (!await confirmLeave(dirty)) return;
    if (customerId) await loadRecords(customerId, recordId); else await loadCustomers();
  };
  const selectRecord = async (row: Treatment) => {
    if (row.id === recordId || saving) return;
    if (!await confirmLeave(dirty)) return;
    resetEditor(); setRecordId(row.id); populate(formFromRecord(row));
  };
  const newRecord = async () => {
    if (!writable || !await confirmLeave(dirty)) return;
    resetEditor(); setRecordId(null); populate(emptyForm());
  };
  const copyRecord = async () => {
    if (!writable || !record || !await confirmLeave(dirty)) return;
    resetEditor(); setRecordId(null); setCopied(true);
    setForm({ ...formFromRecord(record), treatment_date: todayIso(), next_visit_date: '' });
    setBaseline(emptyForm());
  };

  function applySaved(saved: Treatment, text: string) {
    pending.current = null;
    setConflicted(false); setCorrecting(false); setReason(''); setCopied(false);
    setRecords((rows) => sortRecords([...rows.filter((item) => item.id !== saved.id), saved]));
    setRecordId(saved.id);
    populate(formFromRecord(saved));
    setMessage({ tone: 'info', text });
    notify.success(text);
  }
  function saveFailed(error: unknown) {
    const status = errorStatus(error);
    if (status === 409) {
      setConflicted(true);
      setMessage({ tone: 'error', text: '다른 변경 또는 상태 충돌이 있습니다. 입력은 유지됩니다. 새로고침 후 비교하세요.' });
    } else if (status === 403) setMessage({ tone: 'error', text: '시술 기록을 변경할 권한이 없습니다. 입력은 유지됩니다.' });
    else if (status === 422) setMessage({ tone: 'error', text: '서버가 입력값을 받아들이지 않았습니다. 값을 확인하세요. 입력은 유지됩니다.' });
    else setMessage({ tone: 'error', text: '저장 실패 · 입력은 유지됩니다. 이력을 확인한 뒤 재시도하세요.' });
  }

  /** 상태 전이와 수정·정정. 같은 내용의 재시도는 같은 operation_id를 써서 서버에서 한 번만 반영된다. */
  async function mutate(action: TreatmentAction, values: MutationBody['values'], reasonText: string, doneText: string) {
    if (!record || !customerId || saving) return;
    const fingerprint = JSON.stringify({ action, values, reasonText, version: record.version, record: record.id, customerId });
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, operationId: newOperationId() };
    setSaving(true);
    setMessage({ tone: 'info', text: '변경 사항을 저장하는 중…' });
    try {
      applySaved(await treatmentApi.mutate(api, organizationId, customerId, record.id, { action, expected_version: record.version, operation_id: pending.current.operationId, reason: reasonText, values }), doneText);
    } catch (error) { saveFailed(error); }
    finally { setSaving(false); }
  }

  async function save() {
    if (!writable || busy || conflicted || !customerId) return;
    const checked = validateForm(form);
    if ('error' in checked) { setMessage({ tone: 'error', text: checked.error }); return; }
    if (record) {
      if (locked && !correcting) { setMessage({ tone: 'error', text: '완료·중단 기록은 정정 버튼으로 변경하세요.' }); return; }
      const trimmed = reason.trim();
      if (correcting && !trimmed) { setMessage({ tone: 'error', text: '정정 사유를 입력하세요.' }); return; }
      await mutate(correcting ? 'correct' : 'edit', checked.values, correcting ? trimmed : '', correcting ? '정정 내용을 저장했습니다. 이전 내용은 변경 이력에 보존됩니다.' : '시술 기록을 저장했습니다.');
      return;
    }
    setSaving(true);
    setMessage({ tone: 'info', text: '저장 중…' });
    try { applySaved(await treatmentApi.create(api, organizationId, customerId, checked.values), '시술 기록을 저장했습니다.'); }
    catch (error) { saveFailed(error); }
    finally { setSaving(false); }
  }

  const beginCorrection = () => {
    if (!writable || busy || conflicted || !record || !['completed', 'cancelled', 'legacy'].includes(record.status)) return;
    setCorrecting(true);
    setMessage({ tone: 'info', text: '정정할 내용과 사유를 입력하세요. 이전 내용은 변경 이력에 보존됩니다.' });
  };
  const cancelCorrection = () => { setCorrecting(false); setReason(''); if (record) populate(formFromRecord(record)); setMessage(null); };

  const blockedByDraft = (what: string) => {
    if (!dirty) return false;
    setMessage({ tone: 'error', text: `작성 중인 내용을 먼저 저장한 뒤 ${what}`.trim() });
    return true;
  };
  async function transition(action: 'start' | 'complete' | 'cancel') {
    if (!writable || busy || conflicted || !record || blockedByDraft('상태를 변경하세요.')) return;
    const allowed = { start: ['draft'], complete: ['in_progress'], cancel: ['draft', 'in_progress'] }[action];
    if (!allowed.includes(record.status)) return;
    if (action === 'start' && (!customer || !consultationReady(record, customer))) {
      setMessage({ tone: 'error', text: '상담 기록에서 목표를 입력하고 고객 주의사항을 확인·저장하세요.' });
      return;
    }
    if (action === 'cancel') { setDialog('cancel'); return; }
    await mutate(action, null, '', action === 'start' ? '시술을 시작했습니다.' : '시술을 완료했습니다.');
  }
  async function submitCancel() {
    const trimmed = cancelReason.trim();
    if (!trimmed || trimmed.length > 2000) { setMessage({ tone: 'error', text: '중단 사유는 1~2,000자로 입력하세요.' }); return; }
    setDialog(null);
    await mutate('cancel', null, trimmed, '시술을 중단했습니다.');
  }

  /** 상담 창은 최신 고객 주의사항과 시술 버전을 다시 읽은 뒤 연다. */
  async function openConsultation() {
    if (!record || !customerId || busy || blockedByDraft('상담을 열어주세요.')) return;
    setOpening(true);
    setMessage({ tone: 'info', text: '최신 고객 주의사항과 상담을 불러오는 중…' });
    try {
      const [freshCustomers, freshRecords] = await Promise.all([api.listCustomers(organizationId), treatmentApi.list(api, organizationId, customerId)]);
      const freshCustomer = freshCustomers.find((item) => item.id === customerId);
      const freshRecord = freshRecords.find((item) => item.id === record.id);
      if (!freshCustomer || !freshRecord) throw new Error('missing');
      setCustomers(freshCustomers);
      setRecords((rows) => sortRecords(rows.map((item) => (item.id === freshRecord.id ? freshRecord : item))));
      if (!dirty) populate(formFromRecord(freshRecord));
      setConsultation({ customer: freshCustomer, record: freshRecord });
      setDialog('consult');
      setMessage(null);
    } catch { setMessage({ tone: 'error', text: '최신 고객·상담 정보를 불러오지 못했습니다. 다시 열어주세요.' }); }
    finally { setOpening(false); }
  }
  const consultationSaved = (saved: Treatment) => {
    pending.current = null;
    setConflicted(false);
    setRecords((rows) => sortRecords(rows.map((item) => (item.id === saved.id ? saved : item))));
    if (recordId === saved.id) populate(formFromRecord(saved));
    setMessage({ tone: 'info', text: '상담 기록과 시술 버전을 반영했습니다.' });
    notify.success('상담 기록을 저장했습니다.');
  };

  const categories = useMemo(() => [...new Set(records.map((item) => item.category).filter(Boolean))].sort(), [records]);
  const visibleCustomers = useMemo(() => filterCustomers(customers, customerQuery), [customers, customerQuery]);
  const rangeError = filters.from && filters.to && filters.from > filters.to ? '날짜 범위의 시작일이 종료일보다 늦습니다.' : '';
  const visibleRecords = useMemo(() => (rangeError ? records : filterRecords(records, filters)), [records, filters, rangeError]);

  const status = record?.status ?? 'new';
  const ready = writable && !busy && !conflicted && !correcting;
  const heading = correcting ? '기록 정정 · 원본 이력 보존' : copied ? '복사한 새 기록 · 저장 전' : record ? (writable ? '기록 수정' : '기록 조회 · 읽기 전용') : `${customer ? `${customer.name} · ` : ''}새 기록`;
  const setField = (key: keyof FormState) => (value: string | null) => setForm((old) => ({ ...old, [key]: value ?? '' }));
  const stateText = record
    ? `${statusLabel(record.status)} · 버전 ${record.version}${record.started_at ? `  |  시작 ${localTime(record.started_at)}` : ''}${record.ended_at ? `  |  종료 ${localTime(record.ended_at)}` : ''}`
    : '새 기록 · 저장 후 시술을 시작할 수 있습니다.';

  return (
    <section className="treatment-page">
      <div className="page-toolbar">
        <div><h1>시술관리</h1><p className="muted">고객별 상담부터 시술 완료까지, 하나의 기록으로 연결하세요.</p></div>
        {writable && <div className="row-actions">
          <button type="button" disabled={!ready || !customerId} onClick={() => void newRecord()}>새 기록</button>
          <button type="button" disabled={!ready || !record} onClick={() => void copyRecord()}>선택 기록 복사</button>
        </div>}
      </div>

      <div className="treatment-lifecycle" aria-label="시술 상태">
        <span className="treatment-lifecycle__state">{stateText}</span>
        <div className="row-actions">
          <button type="button" disabled={!record || busy} onClick={() => void openConsultation()}>상담 기록</button>
          {documentsPanel && <button type="button" disabled={!record || busy || dirty} onClick={() => !blockedByDraft('문서를 열어주세요.') && setDialog('documents')}>문서 발행·이력</button>}
          <button type="button" disabled={!record || busy || !locked || correcting || dirty} onClick={() => setDialog('sale')}>결제 초안</button>
          <button type="button" disabled={!record || busy} onClick={() => setDialog('events')}>변경 이력</button>
          {writable && <>
            <button type="button" disabled={!ready || status !== 'draft'} onClick={() => void transition('start')}>시작</button>
            <button type="button" disabled={!ready || status !== 'in_progress'} onClick={() => void transition('complete')}>완료</button>
            <button type="button" disabled={!ready || !['draft', 'in_progress'].includes(status)} onClick={() => void transition('cancel')}>중단</button>
            <button type="button" disabled={!ready || !['completed', 'cancelled', 'legacy'].includes(status)} onClick={beginCorrection}>정정</button>
          </>}
        </div>
      </div>

      <div className="treatment-layout">
        <aside className="data-surface treatment-customers">
          <h2>고객 선택</h2>
          <input aria-label="고객 검색" placeholder="이름 · 연락처 검색" value={customerQuery} onChange={(event) => setCustomerQuery(event.target.value)} />
          {customersState === 'loading' && <LoadingState label="고객 목록을 불러오는 중…" />}
          {customersState === 'error' && <ErrorState message="고객 목록을 불러오지 못했습니다." onRetry={() => void loadCustomers()} />}
          {customersState === 'ready' && !customers.length && <p className="empty-state">고객관리에서 고객을 먼저 등록하세요.</p>}
          <ul aria-label="고객 목록">
            {visibleCustomers.map((item) => (
              <li key={item.id}><button type="button" aria-pressed={item.id === customerId} onClick={() => void openCustomer(item.id)}><strong>{item.name}</strong><small>{privacy.phone(item.phone) || '연락처 미등록'}</small></button></li>
            ))}
          </ul>
          <div className="treatment-cautions" aria-label="고객 주의사항">
            {customer ? <>
              <div>피부 타입 · {customer.skin_type || '미등록'}</div>
              <div>알레르기 · 주의사항</div>
              <div>{customer.allergies || '미등록 · 상담 시 확인'}</div>
            </> : '고객을 선택하세요.'}
          </div>
        </aside>

        <section className="data-surface treatment-history">
          <h2>시술 이력</h2>
          <div className="treatment-filters">
            <input aria-label="시술 검색" placeholder="시술명 · 담당자 · 기록 검색" value={filters.query} onChange={(event) => setFilters({ ...filters, query: event.target.value })} />
            <DateField aria-label="시작일" value={filters.from || null} onChange={(value) => setFilters({ ...filters, from: value ?? '' })} />
            <DateField aria-label="종료일" value={filters.to || null} onChange={(value) => setFilters({ ...filters, to: value ?? '' })} />
            <Select aria-label="분류 필터" value={filters.category} placeholder="전체 분류" options={categories.map((value) => ({ value, label: value }))} onChange={(value) => setFilters({ ...filters, category: value })} />
          </div>
          <p className="muted" role="status">{rangeError || `전체 ${records.length}건 중 ${visibleRecords.length}건`}</p>
          {recordsState === 'error' && <ErrorState message="시술 이력을 불러오지 못했습니다." onRetry={() => customerId && void loadRecords(customerId, recordId)} />}
          <DataGrid columns={columns} rows={visibleRecords} rowKey={(row) => row.id} selectedKey={recordId} onSelect={(row) => void selectRecord(row)} loading={recordsState === 'loading'}
            emptyText={customerId ? '조건에 맞는 시술 기록이 없습니다.' : '고객을 선택하세요.'} ariaLabel="시술 이력" storageKey="treatment-grid" />
          <button type="button" disabled={saving || recordsState === 'loading'} onClick={() => void reload()}>새로고침</button>
        </section>

        <section className="editor-panel treatment-editor">
          <h2>{heading}</h2>
          <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <label>시술일 *<DateField value={form.treatment_date || null} disabled={fieldsReadOnly || !customerId} onChange={setField('treatment_date')} aria-label="시술일" /></label>
            <label>시술명 *<input value={form.treatment_name} maxLength={200} readOnly={fieldsReadOnly} disabled={!customerId} onChange={(event) => setField('treatment_name')(event.target.value)} /></label>
            <label>분류<input value={form.category} maxLength={100} readOnly={fieldsReadOnly} disabled={!customerId} onChange={(event) => setField('category')(event.target.value)} /></label>
            <label>담당자<input value={form.practitioner} maxLength={100} readOnly={fieldsReadOnly} disabled={!customerId} onChange={(event) => setField('practitioner')(event.target.value)} /></label>
            <label>예정 금액<input value={form.amount} inputMode="decimal" placeholder="미입력 가능 · 원" readOnly={fieldsReadOnly} disabled={!customerId} onChange={(event) => setField('amount')(event.target.value)} /></label>
            <label>다음 방문일<DateField value={form.next_visit_date || null} disabled={fieldsReadOnly || !customerId} onChange={setField('next_visit_date')} aria-label="다음 방문일" /></label>
            <label className="full">시술 내용 · 반응 · 다음 관리 계획<textarea value={form.notes} maxLength={10_000} placeholder="사용 제품, 시술 부위와 고객 반응 등을 기록하세요." readOnly={fieldsReadOnly} disabled={!customerId} onChange={(event) => setField('notes')(event.target.value)} /></label>
            {correcting && <label className="full">정정 사유 (필수)<input value={reason} maxLength={2000} placeholder="정정 사유를 입력하세요" onChange={(event) => setReason(event.target.value)} /></label>}
            <p className="muted full">예정 금액은 결제·매출에 반영되지 않습니다.</p>
            {writable && <div className="form-actions full">
              <button className="primary-button" disabled={busy || conflicted || !customerId || (locked && !correcting)}>{saving ? '저장 중…' : correcting ? '정정 내용 저장' : '시술 기록 저장'}</button>
              {correcting && <button type="button" disabled={saving} onClick={cancelCorrection}>정정 취소</button>}
            </div>}
          </form>
        </section>
      </div>

      <TreatmentPhotos api={api} organizationId={organizationId} customerId={customerId} customerName={customer?.name} treatmentDate={record?.treatment_date ?? null} treatmentId={record?.id ?? null} treatmentName={record?.treatment_name} readOnly={readOnly} />

      {message && <p role={message.tone === 'error' ? 'alert' : 'status'} className={message.tone === 'error' ? 'form-error' : 'muted'}>{message.text}</p>}

      {dialog === 'consult' && consultation && (
        <ConsultationDialog api={api} organizationId={organizationId} customer={consultation.customer} record={consultation.record} readOnly={!writable} onSaved={consultationSaved} onClose={closeDialog} />
      )}
      {dialog === 'events' && record && customerId && <EventsDialog api={api} organizationId={organizationId} customerId={customerId} treatmentId={record.id} onClose={closeDialog} />}
      {dialog === 'sale' && record && <SaleDraftDialog api={api} organizationId={organizationId} treatment={record} readOnly={!writable} onClose={closeDialog} />}
      {dialog === 'documents' && record && customerId && documentsPanel?.({ organizationId, customerId, treatmentId: record.id, readOnly: !writable, onClose: closeDialog })}
      {dialog === 'cancel' && (
        <Modal title="시술 중단" size="sm" onClose={closeDialog}>
          <div className="treatment-dialog">
            <label>중단 사유 (필수)<textarea value={cancelReason} maxLength={2000} onChange={(event) => setCancelReason(event.target.value)} placeholder="중단 사유와 실제 수행한 범위를 입력하세요." /></label>
            <div className="ba-actions">
              <button type="button" onClick={closeDialog}>취소</button>
              <button type="button" className="ba-danger" disabled={!cancelReason.trim()} onClick={() => void submitCancel()}>중단 확정</button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
