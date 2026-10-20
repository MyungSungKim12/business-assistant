import { useDraftProtection } from '../../app/DraftBoundary';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { confirm, notify } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { documentApi } from './api';
import { exportDocumentPdf } from './documentPdf';
import { formatTime, messageFor } from './errors';
import { PdfExportButton } from './PdfExportButton';
import { documentStatusLabel, type DocumentRecord, type DocumentTemplate } from './schemas';
import { TemplateManager } from './TemplateManager';
import { TreatmentDocumentModal } from './TreatmentDocumentModal';
import './documents.css';

type Tab = 'documents' | 'templates' | 'issue';
type Draft = { title: string; content: string; template_id: string; status: string };
const blank: Draft = { title: '', content: '', template_id: '', status: 'draft' };
const draftOf = (row: DocumentRecord | null): Draft => (row ? { title: row.title, content: row.content, template_id: row.template_id ?? '', status: row.status } : blank);

export interface DocumentPageProps { api: ApiClient; organizationId: string; readOnly: boolean }

/** 문서 목록·작성, 서식(동의서) 버전 관리, 시술 문서 발행·서명 진입을 한 화면에서 제공한다. */
export function DocumentPage({ api, organizationId, readOnly }: DocumentPageProps) {
  const [tab, setTab] = useState<Tab>('documents');
  const [templateStamp, setTemplateStamp] = useState(0);
  return (
    <section className="doc-page">
      <div className="page-toolbar"><div><p className="eyebrow">DOCUMENTS</p><h1>문서·동의</h1><p className="muted">서식을 게시하고 고객 문서를 작성·발행하며 서명·교부·철회 기록을 보관합니다.</p></div></div>
      <div role="tablist" className="doc-tabs">
        {([['documents', '문서'], ['templates', '서식 관리'], ['issue', '시술 문서 발행']] as Array<[Tab, string]>).map(([key, label]) =>
          <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>{label}</button>)}
      </div>
      {/* 작성 중인 입력이 탭 전환으로 사라지지 않도록 문서·서식 탭은 마운트한 채 숨긴다. */}
      <div hidden={tab !== 'documents'}><DocumentsTab api={api} organizationId={organizationId} readOnly={readOnly} reloadKey={templateStamp} /></div>
      <div hidden={tab !== 'templates'}><TemplateManager api={api} organizationId={organizationId} readOnly={readOnly} onChanged={() => setTemplateStamp((n) => n + 1)} /></div>
      {tab === 'issue' && <IssueTab api={api} organizationId={organizationId} readOnly={readOnly} />}
    </section>
  );
}

function DocumentsTab({ api, organizationId, readOnly, reloadKey }: DocumentPageProps & { reloadKey: number }) {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [templates, setTemplates] = useState<DocumentTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<DocumentRecord | null>(null);
  const [draft, setDraft] = useState<Draft>(blank);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [docs, tpls] = await Promise.all([documentApi.listDocuments(api, organizationId), documentApi.listTemplates(api, organizationId)]);
      setDocuments(docs);
      setTemplates(tpls);
      setError('');
    } catch (e) { setError(messageFor(e, { 403: '문서 접근 권한이 없습니다.' }, '문서를 불러오지 못했습니다.')); }
    finally { setLoading(false); }
  }, [api, organizationId]);
  useEffect(() => { void load(); }, [load, reloadKey]);

  const baseline = draftOf(selected);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  useDraftProtection(dirty, saving);
  const rows = useMemo(() => documents.filter((row) => row.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [documents, query]);
  const published = templates.filter((row) => row.status === 'published');
  const selectable = published.some((row) => row.id === draft.template_id) || !draft.template_id ? published : [...published, ...templates.filter((row) => row.id === draft.template_id)];

  const guard = async () => !dirty || confirm({ title: '작성 중인 문서', message: '저장하지 않은 문서 입력을 버리시겠습니까?', confirmLabel: '버리기', tone: 'danger' });
  const open = async (row: DocumentRecord | null) => {
    if (row?.id === selected?.id && row !== null) return;
    if (!(await guard())) return;
    setSelected(row);
    setDraft(draftOf(row));
    setFormError('');
  };
  const applyTemplate = (id: string) => {
    const template = templates.find((row) => row.id === id);
    setDraft((old) => ({ ...old, template_id: id, content: template && !old.content.trim() ? template.content : old.content }));
  };

  const save = async () => {
    if (readOnly || saving) return;
    const title = draft.title.trim();
    if (!title) return setFormError('문서 제목을 입력하세요.');
    if (draft.content.length > 100_000) return setFormError('본문은 100,000자 이하여야 합니다.');
    setSaving(true);
    setFormError('');
    try {
      let saved: DocumentRecord;
      if (selected) {
        const patch: Partial<{ title: string; content: string; template_id: string; status: string }> = {};
        if (title !== baseline.title) patch.title = title;
        if (draft.content !== baseline.content) patch.content = draft.content;
        if (draft.status !== baseline.status) patch.status = draft.status;
        if (draft.template_id && draft.template_id !== baseline.template_id) patch.template_id = draft.template_id;
        if (Object.keys(patch).length === 0) { setSaving(false); return; }
        saved = await documentApi.updateDocument(api, organizationId, selected.id, patch);
        setDocuments((old) => old.map((row) => (row.id === saved.id ? saved : row)));
      } else {
        saved = await documentApi.createDocument(api, organizationId, { title, content: draft.content, template_id: draft.template_id || null, status: draft.status });
        setDocuments((old) => [saved, ...old]);
      }
      setSelected(saved);
      setDraft(draftOf(saved));
      notify.success(selected ? '문서를 저장했습니다.' : '문서를 작성했습니다.');
    } catch (e) {
      setFormError(messageFor(e, { 403: '문서 작성 권한이 없습니다.', 404: '문서를 찾을 수 없습니다. 목록을 새로고침하세요.', 422: '입력 내용과 템플릿을 확인하세요.' }, '문서를 저장하지 못했습니다. 입력 내용은 유지됩니다.'));
    } finally { setSaving(false); }
  };

  return (
    <section className="doc-split" aria-label="문서 목록·작성">
      <div className="data-surface doc-side">
        <div className="doc-actions">
          <input aria-label="문서 검색" placeholder="제목 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button type="button" onClick={() => void load()}>새로고침</button>
          {!readOnly && <button type="button" onClick={() => void open(null)}>새 문서</button>}
        </div>
        {error && <p role="alert" className="form-error">{error} <button type="button" onClick={() => void load()}>다시 시도</button></p>}
        {loading ? <p className="muted">문서를 불러오는 중…</p> : <table aria-label="문서 목록">
          <thead><tr><th>문서</th><th>상태</th><th>수정일</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.id} aria-selected={selected?.id === row.id} onClick={() => void open(row)}>
            <td><button type="button" className="doc-link" onClick={(e) => { e.stopPropagation(); void open(row); }}>{row.title}</button></td>
            <td>{documentStatusLabel[row.status] ?? row.status}</td><td>{formatTime(row.updated_at)}</td></tr>)}</tbody>
        </table>}
        {!loading && !error && rows.length === 0 && <p className="empty-state">등록된 문서가 없습니다.</p>}
      </div>
      <div className="editor-panel doc-editor">
        <h2>{readOnly ? '문서 보기' : selected ? '문서 수정' : '새 문서 작성'}</h2>
        {readOnly && !selected ? <p className="muted">목록에서 문서를 선택하면 내용을 볼 수 있습니다.</p> : <>
          <label>제목<input maxLength={200} readOnly={readOnly} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
          <label>상태<select disabled={readOnly} value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>{Object.entries(documentStatusLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label>템플릿<select disabled={readOnly || Boolean(selected?.template_id)} value={draft.template_id} onChange={(e) => applyTemplate(e.target.value)}>
            <option value="">템플릿 없음</option>{selectable.map((row) => <option key={row.id} value={row.id}>{row.name} · v{row.version}</option>)}
          </select></label>
          <label>본문<textarea rows={12} readOnly={readOnly} value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} /></label>
          {formError && <p role="alert" className="form-error">{formError}</p>}
          <div className="doc-actions">
            {!readOnly && <button type="button" className="primary-button" disabled={saving || !draft.title.trim()} onClick={() => void save()}>{saving ? '저장 중…' : selected ? '저장' : '초안 작성'}</button>}
            {selected && <PdfExportButton disabled={!draft.title.trim()} onExport={() => exportDocumentPdf({ title: draft.title.trim(), content: draft.content, status: draft.status, updated_at: selected.updated_at })} />}
          </div>
        </>}
      </div>
    </section>
  );
}

type Options = { customers: Array<{ id: string; name: string }>; treatments: Array<{ id: string; customer_id: string; treatment_name: string; treatment_date: string }> };

function IssueTab({ api, organizationId, readOnly }: DocumentPageProps) {
  const [options, setOptions] = useState<Options | null>(null);
  const [error, setError] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [treatmentId, setTreatmentId] = useState('');
  const [opened, setOpened] = useState(false);
  const load = useCallback(async () => {
    try {
      const [customers, treatments] = await Promise.all([documentApi.listCustomers(api, organizationId), documentApi.listTreatments(api, organizationId)]);
      setOptions({ customers, treatments });
      setError('');
    } catch { setError('고객·시술 목록을 불러오지 못했습니다.'); }
  }, [api, organizationId]);
  useEffect(() => { void load(); }, [load]);
  const treatments = options?.treatments.filter((row) => row.customer_id === customerId) ?? [];
  return (
    <div className="editor-panel doc-issue-picker">
      <h2>시술 문서 발행</h2>
      <p className="muted">고객과 시술을 선택해 서식으로 문서를 발행하고, 발행본의 서명·교부·철회 기록을 확인합니다.</p>
      {error && <p role="alert" className="form-error">{error} <button type="button" onClick={() => void load()}>다시 시도</button></p>}
      <label>고객<select value={customerId} onChange={(e) => { setCustomerId(e.target.value); setTreatmentId(''); }}>
        <option value="">고객 선택</option>{options?.customers.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
      <label>시술<select value={treatmentId} disabled={!customerId} onChange={(e) => setTreatmentId(e.target.value)}>
        <option value="">시술 선택</option>{treatments.map((row) => <option key={row.id} value={row.id}>{row.treatment_date} · {row.treatment_name}</option>)}</select></label>
      <button type="button" className="primary-button" disabled={!customerId || !treatmentId} onClick={() => setOpened(true)}>문서 발행·이력 열기</button>
      {opened && <TreatmentDocumentModal api={api} organizationId={organizationId} customerId={customerId} treatmentId={treatmentId} readOnly={readOnly} onClose={() => setOpened(false)} />}
    </div>
  );
}
