import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorState, LoadingState, Modal, Select, confirm } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { treatmentApi } from './api';
import { CONSENT_LABELS, errorStatus, localTime, newOperationId } from './logic';
import type { IssuedDocument, SaleDraft, SalePreview, SaleValues, Treatment } from './schemas';
import { useStable } from './useStable';
import './treatments.css';

const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const text = (value: unknown) => (value === null || value === undefined ? '' : String(value));

/** 전달된 초안의 읽기 전용 요약. 수납·매출 확정이 아님을 항상 함께 보여준다. */
export function DraftSummary({ draft }: { draft: SaleDraft }) {
  const snapshot = record(draft.source_snapshot);
  const customer = record(snapshot.customer);
  const treatment = record(snapshot.treatment);
  const consent = record(snapshot.consent);
  const rows: [string, string][] = [
    ['고객', text(customer.name)], ['청구 항목', draft.description], ['검토 금액', draft.amount], ['담당자', text(treatment.practitioner)],
    ['시술 버전', text(treatment.version)], ['동의 상태(전달 당시)', CONSENT_LABELS[text(consent.status)] ?? '기록 확인 필요'],
    ['서식 버전', text(consent.template_version) || '미연결'], ['예외 사유', text(snapshot.exception_reason)], ['중단·부분 청구 사유', text(snapshot.partial_reason)],
    ['작성 시각', localTime(draft.created_at)], ['초안 ID', draft.id],
  ];
  return (
    <div className="treatment-draft" aria-label="결제 초안">
      <strong>결제 초안 · 미수납</strong>
      <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || '—'}</dd></div>)}</dl>
      <p className="muted">아직 수납하거나 매출로 확정한 거래가 아닙니다. 전달 후 원본 변경은 자동 반영되지 않습니다.</p>
    </div>
  );
}

const MESSAGES: Record<number, string> = {
  409: '원본이 변경되었거나 이미 초안이 있습니다. 새로고침 후 다시 확인하세요.',
  403: '고객·문서·결제 접근 권한을 확인하세요.',
  422: '완료/중단 상태, 금액, 부분 수행 사유와 동의 예외 사유를 확인하세요.',
};
const FINAL_STATUSES = new Set([400, 401, 403, 404, 409, 422]);

type Props = { api: ApiClient; organizationId: string; treatment: Treatment; readOnly: boolean; onClose: () => void };

/** 완료·중단된 시술의 실제 청구 내용을 검토하고 결제 초안으로 한 번만 전달한다(TRT-003). */
export function SaleDraftDialog({ api, organizationId, treatment, readOnly, onClose }: Props) {
  const onModalClose = useStable(() => void requestClose());
  const completed = treatment.status === 'completed';
  const initial = { description: completed ? treatment.treatment_name : '', amount: completed && treatment.amount !== null ? treatment.amount : '', consent: '', exception: '', partial: '' };
  const [description, setDescription] = useState(initial.description);
  const [amount, setAmount] = useState(initial.amount);
  const [consent, setConsent] = useState(initial.consent);
  const [exception, setException] = useState(initial.exception);
  const [partial, setPartial] = useState(initial.partial);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [existing, setExisting] = useState<SaleDraft | null>(null);
  const [documents, setDocuments] = useState<IssuedDocument[]>([]);
  const [documentsFailed, setDocumentsFailed] = useState(false);
  const [preview, setPreview] = useState<SalePreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState<{ operation_id: string; expected_preview: SalePreview } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const sequence = useRef(0);

  const load = useCallback(async () => {
    const current = ++sequence.current;
    setLoadState('loading');
    setMessage('기존 결제 초안과 발행 문서를 불러오는 중…');
    try {
      const drafts = await treatmentApi.saleDrafts(api, organizationId, treatment.customer_id, treatment.id);
      if (current !== sequence.current) return;
      setExisting(drafts[0] ?? null);
      setLoadState('ready');
      setMessage(drafts.length ? '기존 초안이 있습니다. 내용을 확인하세요.' : '실제 청구할 내용을 입력하고 검토하세요.');
    } catch { if (current === sequence.current) { setLoadState('error'); setMessage(''); } return; }
    try {
      const rows = await treatmentApi.issuedDocuments(api, organizationId, treatment.customer_id, treatment.id);
      if (current === sequence.current) { setDocuments(rows); setDocumentsFailed(false); }
    } catch { if (current === sequence.current) setDocumentsFailed(true); }
  }, [api, organizationId, treatment.customer_id, treatment.id]);
  useEffect(() => { void load(); return () => { sequence.current += 1; }; }, [load]);

  const values = (): SaleValues => ({ description: description.trim(), amount: amount.trim(), consent_document_id: consent || null, exception_reason: exception.trim(), partial_reason: partial.trim() });
  const dirty = !readOnly && !existing && (description !== initial.description || amount !== initial.amount || consent !== '' || exception !== '' || partial !== '');
  const editable = loadState === 'ready' && !readOnly && !busy && !pending && !existing;
  const edited = <T,>(setter: (value: T) => void) => (value: T) => { setter(value); setPreview(null); setConfirmed(false); };

  const requestClose = async () => {
    if (busy) { setMessage('처리 후 닫아주세요.'); return; }
    if (pending || dirty) {
      const note = pending ? '\n전달 결과가 불명확합니다. 같은 요청 재시도로 확인할 수 있습니다.' : '';
      if (!await confirm({ title: '작성 중인 결제 초안', message: `저장하지 않은 청구 내용을 버리시겠습니까?${note}`, confirmLabel: '버리고 닫기', tone: 'danger' })) return;
    }
    onClose();
  };

  async function runPreview() {
    if (!editable) return;
    const v = values();
    if (!v.description || v.description.length > 200 || !/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/.test(v.amount) || v.exception_reason.length > 2000 || v.partial_reason.length > 2000 || (treatment.status === 'cancelled' && !v.partial_reason)) {
      setMessage('청구 항목과 금액을 확인하세요. 중단 시 부분 수행 사유가 필요합니다. 사유는 2,000자 이내입니다.');
      return;
    }
    setPreview(null);
    setConfirmed(false);
    setBusy(true);
    setMessage('최신 원본과 동의 상태를 확인하는 중…');
    try {
      setPreview(await treatmentApi.previewSaleDraft(api, organizationId, treatment.customer_id, treatment.id, v));
      setMessage('실제 청구 내용과 동의 상태를 확인하고 체크하세요.');
    } catch (error) { setMessage(MESSAGES[errorStatus(error) ?? 0] ?? '요청을 완료하지 못했습니다. 입력은 유지됩니다. 다시 시도하세요.'); }
    finally { setBusy(false); }
  }

  async function send(request: { operation_id: string; expected_preview: SalePreview }) {
    setBusy(true);
    setMessage('결제 초안으로 전달하는 중…');
    try {
      const saved = await treatmentApi.createSaleDraft(api, organizationId, treatment.customer_id, treatment.id, { ...request, confirmed: true });
      setExisting(saved); setPending(null); setPreview(null); setConfirmed(false);
      setMessage('초안을 전달했습니다. 매출·지출 메뉴의 시술 결제 초안에서 확인할 수 있습니다.');
    } catch (error) {
      const status = errorStatus(error) ?? 0;
      if (FINAL_STATUSES.has(status)) { setPending(null); setPreview(null); setConfirmed(false); }
      setMessage(MESSAGES[status] ?? '요청을 완료하지 못했습니다. 입력은 유지됩니다. 다시 시도하세요.');
    } finally { setBusy(false); }
  }

  // 같은 operation_id와 미리보기를 보존해 응답 유실 후 재시도해도 초안이 중복되지 않게 한다.
  const create = () => {
    if (!editable || !preview || !confirmed) return;
    const request = { operation_id: newOperationId(), expected_preview: preview };
    setPending(request);
    void send(request);
  };

  const line = preview?.line;
  const snapshotCustomer = record(record(preview?.source_snapshot).customer);
  return (
    <Modal title="시술 명세 → 결제 초안" size="lg" onClose={onModalClose}>
      <div className="treatment-dialog">
        <p className="muted">초안 전달은 수납·매출 확정이 아닙니다. 같은 시술에서는 하나의 초안만 생성됩니다.</p>
        {loadState === 'error' && <ErrorState message="기존 결제 초안을 불러오지 못했습니다." onRetry={() => void load()} />}
        {loadState === 'loading' && <LoadingState label="기존 결제 초안을 불러오는 중…" />}
        {loadState === 'ready' && existing && <DraftSummary draft={existing} />}
        {loadState === 'ready' && !readOnly && !existing && (
          <>
            <div className="treatment-dialog__grid">
              <label>청구 항목<input value={description} maxLength={200} disabled={!editable} onChange={(event) => edited(setDescription)(event.target.value)} /></label>
              <label>검토 금액<input value={amount} inputMode="decimal" placeholder="실제 청구 검토 금액 · 0 가능" disabled={!editable} onChange={(event) => edited(setAmount)(event.target.value)} /></label>
              <label>연결할 발행본
                <Select value={consent} disabled={!editable} onChange={edited(setConsent)} placeholder="동의 문서 미연결"
                  options={documents.map((document) => ({ value: document.id, label: `${document.title}${document.template_version !== undefined ? ` · v${document.template_version}` : ''}` }))} />
              </label>
              {documentsFailed && <p className="muted">발행 문서 목록을 불러오지 못했습니다. 문서 없이 진행하거나 새로고침하세요.</p>}
              <label className="full">동의 예외 사유<textarea value={exception} maxLength={2000} disabled={!editable} placeholder="유효한 서명 문서가 없으면 예외 사유를 기록하세요." onChange={(event) => edited(setException)(event.target.value)} /></label>
              <label className="full">부분 수행·청구 사유<textarea value={partial} maxLength={2000} disabled={!editable} placeholder="중단 시 실제 수행 범위와 청구 사유 필수" onChange={(event) => edited(setPartial)(event.target.value)} /></label>
            </div>
            <button type="button" disabled={!editable} onClick={() => void runPreview()}>최신 시술·동의 상태로 검토</button>
            {preview && line && (
              <div className="treatment-draft" aria-label="검토 결과">
                <div>고객: {text(snapshotCustomer.name) || '—'}</div>
                <div>항목: {line.description} · 수량: {line.quantity}</div>
                <div>검토 금액: {preview.total_amount} · 담당: {line.practitioner || '—'}</div>
                <div>동의 상태: {CONSENT_LABELS[preview.consent_status] ?? preview.consent_status}</div>
                {preview.warnings.map((warning) => <div key={warning}>{warning}</div>)}
                <p className="muted">아직 미수납인 결제 초안입니다.</p>
              </div>
            )}
            <label className="treatment-check">
              <input type="checkbox" checked={confirmed} disabled={!editable || !preview} onChange={(event) => setConfirmed(event.target.checked)} />
              실제 수행 항목·검토 금액·동의 상태와 예외 사유를 확인했습니다.
            </label>
          </>
        )}
        {loadState === 'ready' && readOnly && !existing && <p className="empty-state">전달된 결제 초안이 없습니다. 초안 전달은 관리자만 할 수 있습니다.</p>}
        <p role="status" className="muted">{message}</p>
        <div className="ba-actions">
          <button type="button" disabled={busy || !!pending} onClick={() => void load()}>기존 초안·문서 새로고침</button>
          {pending && <button type="button" disabled={busy} onClick={() => void send(pending)}>같은 요청 재시도</button>}
          <button type="button" onClick={() => void requestClose()}>닫기</button>
          {!readOnly && !existing && <button type="button" className="primary-button" disabled={!editable || !preview || !confirmed} onClick={create}>결제 초안으로 전달</button>}
        </div>
      </div>
    </Modal>
  );
}

/** 조직 전체의 미수납 시술 결제 초안 목록(수납함). 매출 화면 등에서 열 수 있다. */
export function SaleDraftInboxDialog({ api, organizationId, onClose: close }: { api: ApiClient; organizationId: string; onClose: () => void }) {
  const onClose = useStable(close);
  const [rows, setRows] = useState<SaleDraft[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const current = ++sequence.current;
    setFailed(false); setRows(null);
    try { const result = await treatmentApi.allSaleDrafts(api, organizationId); if (current === sequence.current) setRows(result); }
    catch { if (current === sequence.current) setFailed(true); }
  }, [api, organizationId]);
  useEffect(() => { void load(); return () => { sequence.current += 1; }; }, [load]);
  const active = rows?.find((row) => row.id === selected);
  return (
    <Modal title="시술 결제 초안 · 미수납" size="lg" onClose={onClose}>
      <div className="treatment-dialog">
        <p className="muted">시술에서 전달한 검토 초안입니다. 수입 합계와 수납 실적에는 포함하지 않습니다.</p>
        {failed && <ErrorState message="결제 초안을 불러오지 못했습니다. 권한과 연결을 확인하고 다시 시도하세요." onRetry={() => void load()} />}
        {!failed && rows === null && <LoadingState label="초안을 불러오는 중…" />}
        {rows && (
          <div className="treatment-inbox">
            <ul aria-label="미수납 결제 초안">
              {rows.map((row) => (
                <li key={row.id}><button type="button" aria-pressed={row.id === selected} onClick={() => setSelected(row.id)}>{text(record(record(row.source_snapshot).customer).name)} · {row.description} · {row.amount}</button></li>
              ))}
            </ul>
            <div>{active ? <DraftSummary draft={active} /> : <p className="empty-state">{rows.length ? '초안을 선택하세요.' : '미수납 결제 초안이 없습니다.'}</p>}</div>
          </div>
        )}
        {rows && <p className="muted">미수납 결제 초안 {rows.length}건</p>}
        <div className="ba-actions"><button type="button" onClick={onClose}>닫기</button></div>
      </div>
    </Modal>
  );
}
