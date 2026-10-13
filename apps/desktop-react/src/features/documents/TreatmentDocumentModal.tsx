import { useCallback, useEffect, useState } from 'react';
import { Modal, confirm, notify } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { documentApi } from './api';
import { ConsentModal } from './ConsentModal';
import { exportConsentPdf } from './documentPdf';
import { PdfExportButton } from './PdfExportButton';
import { formatTime, isDefinitive, messageFor, newOperationId, statusOf } from './errors';
import { FIELD_NAMES, type DocumentTemplate, type IssuedDocument, type Scope, type TreatmentPreview } from './schemas';

type Issue = { template_id: string; operation_id: string; expected_preview: Record<string, unknown> };

export function sourceLabel(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== 'object') return '원본 정보 표시 불가';
  const { customer, treatment } = snapshot as { customer?: Record<string, unknown>; treatment?: Record<string, unknown> };
  if (!customer || typeof customer !== 'object' || !treatment || typeof treatment !== 'object') return '원본 정보 표시 불가';
  const show = (value: unknown) => (typeof value === 'string' && value ? value : '미등록');
  return `고객 ${show(customer.name)} · 연락처 ${show(customer.phone)}\n시술 ${show(treatment.name)} · 시술일 ${show(treatment.date)}`;
}

const issueMessages: Partial<Record<number, string>> = {
  401: '로그인이 만료되었습니다. 다시 로그인한 뒤 확인하세요.',
  403: '문서 또는 고객·시술 접근 권한이 없습니다.',
  404: '고객·시술 또는 서식이 없습니다. 최신 목록을 확인하세요.',
  409: '검토 중 원본 정보나 서식이 바뀌었습니다. 미리보기를 다시 불러와 검토하세요.',
  422: '서식의 게시 상태, 누락 항목과 자동 채움 표시를 확인하세요.',
};

/** 시술 한 건의 문서 발행(미리보기 검토 → 발행)과 발행 이력, 발행본별 서명·교부·철회로 이어지는 창. */
export function TreatmentDocumentModal({ api, organizationId, customerId, treatmentId, readOnly, onClose }: { api: ApiClient; organizationId: string; customerId: string; treatmentId: string; readOnly: boolean; onClose: () => void }) {
  const scope: Scope = { organizationId, customerId, treatmentId };
  const [templates, setTemplates] = useState<DocumentTemplate[]>([]);
  const [issued, setIssued] = useState<IssuedDocument[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [templateId, setTemplateId] = useState('');
  const [preview, setPreview] = useState<TreatmentPreview | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [pending, setPending] = useState<Issue | null>(null);
  const [status, setStatus] = useState('게시된 서식과 발행 이력을 불러오는 중…');
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<'review' | 'history'>('review');
  const [selected, setSelected] = useState('');
  const [consent, setConsent] = useState<IssuedDocument | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setReady(false);
    setStatus('게시된 서식과 발행 이력을 불러오는 중…');
    try {
      const s: Scope = { organizationId, customerId, treatmentId };
      const [rows, history] = await Promise.all([documentApi.listTemplates(api, organizationId), documentApi.listIssued(api, s)]);
      const published = rows.filter((row) => row.status === 'published');
      setTemplates(published);
      setIssued(history);
      setReady(true);
      setFailed(false);
      setStatus(published.length === 0 ? '게시된 서식이 없습니다. 문서 메뉴에서 서식을 게시하세요.' : '발행할 서식을 선택하세요.');
    } catch (error) {
      setFailed(true);
      setStatus(messageFor(error, issueMessages, '서식·이력을 불러오지 못했습니다. 새로고침으로 다시 시도하세요.'));
    } finally { setBusy(false); }
  }, [api, organizationId, customerId, treatmentId]);
  useEffect(() => { void load(); }, [load]);

  const choose = (id: string) => { setTemplateId(id); setPreview(null); setReviewed(false); };
  const loadPreview = async () => {
    if (!templateId || busy || pending) return;
    setBusy(true);
    setPreview(null);
    setReviewed(false);
    setStatus('최신 고객·시술 정보로 문서를 준비하는 중…');
    try {
      const result = await documentApi.preview(api, scope, templateId);
      setPreview(result);
      setFailed(false);
      setStatus(result.missing_fields.length ? '원본 정보나 서식을 보완한 뒤 다시 미리보기 하세요.' : '표시된 내용과 고객·시술 정보를 확인하세요.');
    } catch (error) {
      setFailed(true);
      setStatus(messageFor(error, issueMessages, '미리보기를 불러오지 못했습니다. 다시 시도하세요.'));
    } finally { setBusy(false); }
  };

  const send = async (request: Issue) => {
    setBusy(true);
    setStatus('검토한 내용으로 발행본을 저장하는 중…');
    try {
      const saved = await documentApi.issue(api, scope, request);
      setPending(null);
      setPreview(null);
      setReviewed(false);
      setIssued((old) => [saved, ...old.filter((row) => row.id !== saved.id)]);
      setSelected(saved.id);
      setTab('history');
      setFailed(false);
      setStatus('발행 당시의 내용과 서식 버전을 보관했습니다. 서명은 아직 확인되지 않았습니다.');
      notify.success('문서를 발행했습니다.');
    } catch (error) {
      const code = statusOf(error);
      setFailed(true);
      if (isDefinitive(code)) { setPending(null); setPreview(null); setReviewed(false); }
      setStatus(messageFor(error, issueMessages, '발행 결과를 확인하지 못했습니다. 같은 요청 재시도로 중복 없이 확인하세요.'));
    } finally { setBusy(false); }
  };
  const issue = () => {
    if (readOnly || busy || pending || !preview || preview.missing_fields.length || !reviewed) return;
    const request: Issue = { template_id: templateId, operation_id: newOperationId(), expected_preview: preview };
    setPending(request);
    void send(request);
  };

  const close = async () => {
    if (busy) return setStatus('요청이 끝난 뒤 닫아주세요.');
    if (pending || (!readOnly && reviewed)) {
      const message = pending ? '발행 결과가 아직 확인되지 않았습니다. 재시도하면 중복 없이 확인할 수 있습니다. 닫으시겠습니까?' : '검토한 문서를 발행하지 않고 닫으시겠습니까?';
      if (!(await confirm({ title: '문서 발행', message, confirmLabel: '닫기', tone: 'danger' }))) return;
    }
    onClose();
  };

  const unlocked = !busy && pending === null;
  const valid = preview !== null && preview.missing_fields.length === 0;
  const current = issued.find((row) => row.id === selected);

  // 동의 창이 열린 동안에는 이 창을 숨겨 Esc·포커스가 한 창에만 적용되게 한다(상태는 유지).
  if (consent) return <ConsentModal api={api} scope={scope} document={consent} readOnly={readOnly} onClose={() => setConsent(null)} />;

  return (
    <Modal title="시술 문서 · 발행 및 이력" size="lg" onClose={() => void close()}>
      <div className="doc-issue">
        <p className="muted">고객 정보와 시술 내용을 검토하고 발행 당시의 문서를 보관하세요. 발행만으로 동의가 완료되지는 않습니다. 서명 상태는 발행본별 이력에서 확인하세요.</p>
        <div role="tablist" className="doc-tabs">
          <button type="button" role="tab" aria-selected={tab === 'review'} onClick={() => setTab('review')}>발행 전 검토</button>
          <button type="button" role="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}>발행 이력</button>
        </div>
        {tab === 'review' && <div role="tabpanel" className="doc-form">
          <div className="doc-row">
            <label className="doc-grow">서식<select value={templateId} disabled={!unlocked || !ready} onChange={(e) => choose(e.target.value)}>
              <option value="">게시된 서식 선택</option>
              {templates.map((row) => <option key={row.id} value={row.id}>{row.name} · v{row.version}</option>)}
            </select></label>
            <button type="button" disabled={!unlocked || !ready || !templateId} onClick={() => void loadPreview()}>최신 정보로 미리보기</button>
          </div>
          {preview ? <>
            <p className="doc-preview-info">{`${preview.title} · 서식 v${preview.template_version}\n${sourceLabel(preview.source_snapshot)}${preview.missing_fields.length ? `\n발행 불가 · 누락/미지원 항목: ${preview.missing_fields.map((key) => FIELD_NAMES[key] ?? key).join(', ')}` : ''}`}</p>
            <pre className="doc-body" aria-label="발행 전 미리보기">{preview.content}</pre>
          </> : <p className="muted">서식을 선택한 후 최신 정보로 미리보기를 눌러주세요.</p>}
          {!readOnly && <>
            <label className="doc-check"><input type="checkbox" disabled={!unlocked || !valid} checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />고객·시술 정보와 문서 내용을 확인했습니다.</label>
            <button type="button" className="primary-button" disabled={!unlocked || !valid || !reviewed} onClick={issue}>검토한 내용으로 발행</button>
          </>}
        </div>}
        {tab === 'history' && <div role="tabpanel" className="doc-history">
          <ul className="doc-list" aria-label="발행 이력">
            {issued.map((row) => <li key={row.id}><button type="button" aria-pressed={selected === row.id} onClick={() => setSelected(row.id)}>{row.title} · v{row.template_version} · {formatTime(row.issued_at)}</button></li>)}
            {ready && issued.length === 0 && <li className="muted">이 시술에 발행한 문서가 없습니다.</li>}
          </ul>
          {current && <>
            <p className="doc-preview-info">{`${current.title} · 서식 v${current.template_version} · 발행본 · 서명 상태 별도 확인\n발행일 ${formatTime(current.issued_at)} · 발행자 ID ${current.issued_by}\n${sourceLabel(current.source_snapshot)}`}</p>
            <pre className="doc-body" aria-label="발행본 내용">{current.content}</pre>
            <div className="doc-actions">
              <button type="button" disabled={busy || pending !== null} onClick={() => setConsent(current)}>선택한 발행본 · 서명·교부·철회</button>
              <PdfExportButton disabled={busy || pending !== null} onExport={() => exportConsentPdf(api, scope, current)} />
            </div>
          </>}
        </div>}
        <p role={failed ? 'alert' : 'status'} className={failed ? 'form-error' : 'muted'}>{status}</p>
        <div className="doc-actions">
          <button type="button" disabled={!unlocked} onClick={() => void load()}>서식·이력 새로고침</button>
          {pending && <button type="button" disabled={busy} onClick={() => void send(pending)}>같은 발행 요청 재시도</button>}
          <span className="doc-spacer" />
          <button type="button" onClick={() => void close()}>닫기</button>
        </div>
      </div>
    </Modal>
  );
}
