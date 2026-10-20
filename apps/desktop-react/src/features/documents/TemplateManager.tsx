import { useDraftProtection } from '../../app/DraftBoundary';
import { useCallback, useEffect, useRef, useState } from 'react';
import { confirm, notify } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { documentApi } from './api';
import { formatTime, isDefinitive, messageFor, newOperationId, statusOf } from './errors';
import { FIELD_NAMES, TEMPLATE_FIELDS, templateStatusLabel, type DocumentTemplate, type TemplateAction, type TemplateMutation, type TemplateVersion } from './schemas';

type Fields = { name: string; description: string; content: string };
type Pending = { templateId: string; payload: TemplateMutation };
const blank: Fields = { name: '', description: '', content: '' };
const fieldsOf = (row: DocumentTemplate | null): Fields => (row ? { name: row.name, description: row.description, content: row.content } : blank);

const mutateMessages: Partial<Record<number, string>> = {
  401: '로그인이 만료되었습니다. 입력은 유지됩니다.',
  403: '서식 관리 권한이 없습니다. 입력은 유지됩니다.',
  409: '다른 변경이 있습니다. 필요한 입력을 복사한 뒤 새로고침하세요.',
  422: '서식 이름과 본문을 확인하세요. 빈 본문은 게시할 수 없습니다.',
};

/** 서식(동의서) 버전 관리: 초안 저장 → 게시 → 새 버전/폐기. revision(낙관적 잠금)과 operation_id 재시도를 지킨다. */
export function TemplateManager({ api, organizationId, readOnly, onChanged }: { api: ApiClient; organizationId: string; readOnly: boolean; onChanged?: () => void }) {
  const [rows, setRows] = useState<DocumentTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [record, setRecord] = useState<DocumentTemplate | null>(null);
  const [fields, setFields] = useState<Fields>(blank);
  const [baseline, setBaseline] = useState<Fields>(blank);
  const [versions, setVersions] = useState<TemplateVersion[]>([]);
  const [viewing, setViewing] = useState<TemplateVersion | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [status, setStatus] = useState('');
  const [failed, setFailed] = useState(false);
  const [field, setField] = useState(TEMPLATE_FIELDS[0]);
  const contentRef = useRef<HTMLTextAreaElement>(null);

  const dirty = !viewing && JSON.stringify(fields) !== JSON.stringify(baseline);
  useDraftProtection(Boolean(dirty || pending), busy || pending !== null);
  const state = record?.status ?? 'draft';
  const unlocked = !busy && pending === null;
  const editable = !readOnly && unlocked && !conflict && !viewing;
  const textEditable = editable && state === 'draft';

  const populate = useCallback((row: DocumentTemplate | null) => {
    setRecord(row);
    setFields(fieldsOf(row));
    setBaseline(fieldsOf(row));
    setViewing(null);
    setVersions([]);
    setConflict(false);
    setPending(null);
    setFailed(false);
  }, []);

  const loadVersions = useCallback(async (row: DocumentTemplate) => {
    try { setVersions(await documentApi.listTemplateVersions(api, organizationId, row.id)); }
    catch { setStatus('게시 이력을 불러오지 못했습니다.'); }
  }, [api, organizationId]);

  const reload = useCallback(async (keepId?: string) => {
    setLoading(true);
    try {
      const list = await documentApi.listTemplates(api, organizationId);
      setRows(list);
      setLoadError('');
      const keep = list.find((row) => row.id === keepId) ?? null;
      populate(keep);
      if (keep) void loadVersions(keep);
      setStatus(`서식 ${list.length}개 · 항목을 선택하거나 새 서식을 작성하세요.`);
    } catch { setLoadError('서식 목록을 불러오지 못했습니다.'); }
    finally { setLoading(false); }
  }, [api, organizationId, populate, loadVersions]);
  useEffect(() => { void reload(); }, [reload]);

  /** 저장하지 않은 입력이나 결과 불명 요청이 있으면 버릴지 묻는다. */
  const confirmLeave = async (): Promise<boolean> => {
    if (busy) { setStatus('요청 처리 중입니다. 완료 후 다시 시도하세요.'); return false; }
    if (!dirty && !pending) return true;
    const message = pending ? '저장하지 않은 입력을 버리시겠습니까? 서버 처리 여부가 확인되지 않았습니다. 재시도하면 중복 없이 결과를 확인할 수 있습니다.' : '저장하지 않은 입력을 버리시겠습니까?';
    return confirm({ title: '작성 중인 서식', message, confirmLabel: '버리기', tone: 'danger' });
  };

  const select = async (row: DocumentTemplate) => {
    if (row.id === record?.id || !(await confirmLeave())) return;
    populate(row);
    void loadVersions(row);
    setStatus('게시본은 읽기 전용입니다. 새 버전을 만들면 이전 게시 내용은 그대로 보존됩니다.');
  };
  const startNew = async () => {
    if (readOnly || !(await confirmLeave())) return;
    populate(null);
    setStatus('새 초안을 작성하세요.');
  };
  const refresh = async () => { if (await confirmLeave()) await reload(record?.id); };

  const chooseVersion = (value: string) => {
    if (!value) { setViewing(null); return; }
    if (dirty) { setStatus('작성 중인 초안을 저장한 뒤 게시본을 조회하세요.'); return; }
    setViewing(versions.find((version) => String(version.version) === value) ?? null);
  };

  const run = async (request: Pending) => {
    setBusy(true);
    setStatus('서식을 저장하는 중…');
    try {
      const saved = await documentApi.mutateTemplate(api, organizationId, request.templateId, request.payload);
      setPending(null);
      const next = rows.some((row) => row.id === saved.id) ? rows.map((row) => (row.id === saved.id ? saved : row)) : [...rows, saved];
      setRows(next);
      populate(saved);
      void loadVersions(saved);
      setFailed(false);
      setStatus('서식을 저장했습니다.');
      notify.success('서식을 저장했습니다.');
      onChanged?.();
    } catch (error) {
      const code = statusOf(error);
      if (isDefinitive(code)) setPending(null);
      setConflict(code === 409);
      setFailed(true);
      setStatus(messageFor(error, mutateMessages, '요청을 완료하지 못했습니다. 입력은 유지됩니다. 다시 시도하세요.'));
    } finally { setBusy(false); }
  };

  const mutate = async (action: TemplateAction) => {
    if (!editable || (record === null && action !== 'save')) return;
    if (action !== 'save' && dirty) return setStatus('변경한 초안을 먼저 저장하세요.');
    if (action === 'publish' || action === 'retire') {
      const ok = await confirm({
        title: '서식 상태 변경', confirmLabel: action === 'publish' ? '게시' : '폐기', tone: action === 'retire' ? 'danger' : 'default',
        message: action === 'publish' ? '현재 내용을 게시하시겠습니까? 게시본은 수정할 수 없습니다.' : '서식을 폐기하시겠습니까? 이전 게시본은 보존되며 되돌릴 수 없습니다.',
      });
      if (!ok) return;
    }
    if (action === 'save' && (!fields.name.trim() || fields.description.length > 100_000 || fields.content.length > 100_000)) {
      return setStatus('이름은 필수이며 설명과 본문은 각각 100,000자 이하여야 합니다.');
    }
    const payload: TemplateMutation = {
      action: record === null ? 'create' : action, expected_revision: record?.revision ?? 0, operation_id: newOperationId(),
      ...(action === 'save' ? { values: { name: fields.name.trim(), description: fields.description, content: fields.content } } : {}),
    };
    const request = { templateId: record?.id ?? crypto.randomUUID(), payload };
    setPending(request);
    void run(request);
  };

  const insertField = () => {
    const token = `{{${field}}}`;
    const element = contentRef.current;
    const start = element?.selectionStart ?? fields.content.length, end = element?.selectionEnd ?? start;
    setFields((old) => ({ ...old, content: old.content.slice(0, start) + token + old.content.slice(end) }));
  };

  const shown = viewing ?? fields;
  const info = viewing ? `게시본 v${viewing.version} · 게시자 ${viewing.published_by}` : record ? `v${record.version} · ${templateStatusLabel[record.status] ?? record.status}` : '새 초안';
  const allowed = (action: TemplateAction) => (action === 'save' || action === 'publish' ? state === 'draft' : action === 'retire' ? state !== 'retired' : state === 'published') && (action === 'save' || record !== null);
  const actions: Array<[TemplateAction, string, string]> = [['save', '초안 저장', 'primary-button'], ['publish', '게시', 'primary-button'], ['revise', '새 버전 만들기', ''], ['retire', '폐기', 'danger-button']];

  return (
    <section className="doc-templates" aria-label="서식 관리">
      <p className="muted">초안을 검토한 뒤 게시하세요. 게시한 내용은 보존되며 수정은 새 버전에서 진행합니다.</p>
      {loadError && <p role="alert" className="form-error">{loadError} <button type="button" onClick={() => void reload(record?.id)}>다시 시도</button></p>}
      <div className="doc-split">
        <div className="data-surface doc-side">
          <div className="doc-actions">
            {!readOnly && <button type="button" disabled={!unlocked} onClick={() => void startNew()}>새 서식</button>}
            <button type="button" disabled={!unlocked} onClick={() => void refresh()}>새로고침</button>
          </div>
          {loading ? <p className="muted">서식을 불러오는 중…</p> : <ul className="doc-list" aria-label="서식 목록">
            {rows.map((row) => <li key={row.id}><button type="button" disabled={!unlocked} aria-pressed={record?.id === row.id} onClick={() => void select(row)}>{row.name} · v{row.version} · {templateStatusLabel[row.status] ?? row.status}</button></li>)}
            {rows.length === 0 && !loadError && <li className="muted">등록된 서식이 없습니다.</li>}
          </ul>}
        </div>
        <div className="editor-panel doc-editor">
          <p className="doc-state">{info}</p>
          {record && <label>게시 이력<select aria-label="게시 이력" disabled={!unlocked} value={viewing ? String(viewing.version) : ''} onChange={(e) => chooseVersion(e.target.value)}>
            <option value="">현재 버전</option>
            {versions.map((version) => <option key={version.version} value={String(version.version)}>게시본 v{version.version} · {formatTime(version.published_at)}</option>)}
          </select></label>}
          <label>서식 이름<input maxLength={200} readOnly={!textEditable} value={shown.name} onChange={(e) => setFields({ ...fields, name: e.target.value })} /></label>
          <label>설명<textarea rows={2} readOnly={!textEditable} value={shown.description} onChange={(e) => setFields({ ...fields, description: e.target.value })} /></label>
          <label>본문<textarea ref={contentRef} rows={12} readOnly={!textEditable} value={shown.content} onChange={(e) => setFields({ ...fields, content: e.target.value })} /></label>
          {!readOnly && <div className="doc-row">
            <label className="doc-grow">자동 채움 항목<select value={field} disabled={!textEditable} onChange={(e) => setField(e.target.value)}>{TEMPLATE_FIELDS.map((key) => <option key={key} value={key}>{FIELD_NAMES[key]}</option>)}</select></label>
            <button type="button" disabled={!textEditable} onClick={insertField}>자동 채움 항목 삽입</button>
          </div>}
          <p className="muted">삽입한 항목은 발행 시 자동 채워집니다. 해당 값이 미등록이면 발행이 중지됩니다(알레르기처럼 "없음"과 "미등록"이 다른 항목은 고객 정보를 먼저 확인해 입력하세요). 오늘 날짜는 발행하는 날(한국 시간)이며, 발행본에는 그 시점의 값이 고정됩니다.</p>
          {!readOnly && <div className="doc-actions">{actions.map(([action, label, tone]) => <button key={action} type="button" className={tone} disabled={!editable || !allowed(action)} onClick={() => void mutate(action)}>{label}</button>)}</div>}
          {pending && !busy && <button type="button" onClick={() => void run(pending)}>같은 요청 재시도</button>}
          {status && <p role={failed ? 'alert' : 'status'} className={failed ? 'form-error' : 'muted'}>{status}</p>}
        </div>
      </div>
    </section>
  );
}
