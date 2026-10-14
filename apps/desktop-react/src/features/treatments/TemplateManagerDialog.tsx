import { useEffect, useState } from 'react';
import { ErrorState, LoadingState, Modal, confirm, notify } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { errorStatus } from './logic';
import { TEMPLATE_LIMITS, emptyTemplate, templateApi, validateTemplate, type TemplateInput, type TreatmentTemplate } from './templates';
import './treatments.css';

const toInput = (template: TreatmentTemplate): TemplateInput => ({
  name: template.name, category: template.category, treatment_name: template.treatment_name, notes: template.notes,
  consultation_goal: template.consultation_goal, consultation_plan: template.consultation_plan,
});

/** 시술 프로토콜 템플릿 관리(TRT-12). 목록에서 고르면 수정·삭제하고, "새 템플릿"으로 만든다. 쓰기는 owner/admin만. */
export function TemplateManagerDialog({ api, organizationId, onClose, onChanged }: {
  api: ApiClient; organizationId: string; onClose: () => void; onChanged?: () => void;
}) {
  const [templates, setTemplates] = useState<TreatmentTemplate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<TemplateInput>(emptyTemplate);
  const [baseline, setBaseline] = useState(() => JSON.stringify(emptyTemplate()));
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const selected = templates.find((item) => item.id === selectedId) ?? null;
  const dirty = JSON.stringify(form) !== baseline;

  async function load() {
    setLoading(true); setLoadError('');
    try { setTemplates(await templateApi.list(api, organizationId)); } catch { setLoadError('템플릿 목록을 불러오지 못했습니다.'); } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [api, organizationId]); // eslint-disable-line react-hooks/exhaustive-deps

  const fill = (next: TemplateInput, id: string | null) => { setForm(next); setBaseline(JSON.stringify(next)); setSelectedId(id); setError(''); };
  /** 저장하지 않은 내용이 있으면 확인한 뒤 실행한다. */
  async function guarded(action: () => void) {
    if (dirty && !await confirm({ title: '작성 중인 템플릿', message: '저장하지 않은 내용을 버릴까요?', confirmLabel: '버리기', tone: 'danger' })) return;
    action();
  }
  const pick = (template: TreatmentTemplate) => void guarded(() => fill(toInput(template), template.id));
  const startNew = () => void guarded(() => fill(emptyTemplate(), null));
  const close = () => void guarded(onClose);

  async function save() {
    const checked = validateTemplate(form);
    if ('error' in checked) { setError(checked.error); return; }
    setBusy(true); setError('');
    try {
      if (selected) {
        const saved = await templateApi.update(api, organizationId, selected.id, { ...checked.value, expected_version: selected.version });
        setTemplates((old) => old.map((item) => (item.id === saved.id ? saved : item)).sort((a, b) => a.name.localeCompare(b.name, 'ko')));
        fill(toInput(saved), saved.id);
        notify.success('템플릿을 수정했습니다.');
      } else {
        const saved = await templateApi.create(api, organizationId, checked.value);
        setTemplates((old) => [...old, saved].sort((a, b) => a.name.localeCompare(b.name, 'ko')));
        fill(toInput(saved), saved.id);
        notify.success('템플릿을 만들었습니다.');
      }
      onChanged?.();
    } catch (failure) {
      const status = errorStatus(failure);
      if (status === 409) { setError('같은 이름의 템플릿이 있거나 다른 곳에서 먼저 수정되었습니다. 목록을 새로 불러옵니다. 입력은 유지됩니다.'); void load(); }
      else if (status === 403) setError('템플릿은 소유자·관리자만 만들거나 고칠 수 있습니다.');
      else if (status === 422) setError('입력값을 확인하세요. 입력은 유지됩니다.');
      else setError('저장하지 못했습니다. 입력은 유지되며 다시 시도할 수 있습니다.');
    } finally { setBusy(false); }
  }

  async function remove() {
    if (!selected) return;
    if (!await confirm({ title: '템플릿 삭제', message: `'${selected.name}' 템플릿을 삭제할까요? 이미 작성한 시술 기록에는 영향이 없습니다.`, confirmLabel: '삭제', tone: 'danger' })) return;
    setBusy(true); setError('');
    try {
      await templateApi.remove(api, organizationId, selected.id);
      setTemplates((old) => old.filter((item) => item.id !== selected.id));
      fill(emptyTemplate(), null);
      notify.success('템플릿을 삭제했습니다.');
      onChanged?.();
    } catch (failure) {
      setError(errorStatus(failure) === 404 ? '이미 삭제된 템플릿입니다. 목록을 새로 불러옵니다.' : '삭제하지 못했습니다. 다시 시도해 주세요.');
      void load();
    } finally { setBusy(false); }
  }

  const set = (key: keyof TemplateInput) => (value: string) => { setForm((old) => ({ ...old, [key]: value })); setError(''); };

  return <Modal title="시술 프로토콜 템플릿" size="lg" onClose={close}>
    <div className="template-manager">
      <aside className="template-manager__list" aria-label="템플릿 목록">
        <button type="button" onClick={startNew} disabled={busy}>새 템플릿</button>
        {loading ? <LoadingState /> : loadError ? <ErrorState message={loadError} onRetry={() => void load()} /> : (
          <ul>
            {templates.length === 0 && <li className="muted">등록된 템플릿이 없습니다.</li>}
            {templates.map((template) => (
              <li key={template.id}><button type="button" aria-pressed={template.id === selectedId} onClick={() => pick(template)}><strong>{template.name}</strong>{template.category && <small>{template.category}</small>}</button></li>
            ))}
          </ul>
        )}
      </aside>
      <form className="template-manager__form" onSubmit={(event) => { event.preventDefault(); void save(); }} aria-label={selected ? '템플릿 수정' : '새 템플릿'}>
        <p className="muted">시술 기록과 상담을 쓸 때 불러와 채우는 틀입니다. 불러온 값은 복사되므로 템플릿을 바꿔도 이미 쓴 기록은 바뀌지 않습니다.</p>
        <label>템플릿 이름 *<input value={form.name} maxLength={TEMPLATE_LIMITS.name} disabled={busy} onChange={(event) => set('name')(event.target.value)} /></label>
        <label>시술명<input value={form.treatment_name} maxLength={TEMPLATE_LIMITS.treatment_name} disabled={busy} placeholder="비우면 이름이 시술명으로 채워집니다" onChange={(event) => set('treatment_name')(event.target.value)} /></label>
        <label>분류<input value={form.category} maxLength={TEMPLATE_LIMITS.category} disabled={busy} onChange={(event) => set('category')(event.target.value)} /></label>
        <label>시술 내용 · 진행 순서 · 사용 제품<textarea value={form.notes} maxLength={TEMPLATE_LIMITS.notes} disabled={busy} onChange={(event) => set('notes')(event.target.value)} /></label>
        <label>상담 목표<textarea value={form.consultation_goal} maxLength={TEMPLATE_LIMITS.consultation_goal} disabled={busy} onChange={(event) => set('consultation_goal')(event.target.value)} /></label>
        <label>예정 관리 내용<textarea value={form.consultation_plan} maxLength={TEMPLATE_LIMITS.consultation_plan} disabled={busy} onChange={(event) => set('consultation_plan')(event.target.value)} /></label>
        {error && <p role="alert" className="form-error">{error}</p>}
        <div className="ba-actions">
          {selected && <button type="button" className="danger-button" disabled={busy} onClick={() => void remove()}>삭제</button>}
          <button type="button" disabled={busy} onClick={close}>닫기</button>
          <button type="submit" className="primary-button" disabled={busy || (!!selected && !dirty)}>{busy ? '저장 중…' : selected ? '수정 저장' : '템플릿 저장'}</button>
        </div>
      </form>
    </div>
  </Modal>;
}
