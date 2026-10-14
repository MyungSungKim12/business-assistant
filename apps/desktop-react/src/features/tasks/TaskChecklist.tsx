import { useState } from 'react';
import type { Task } from '../../api/schemas';
import { CHECKLIST_LIMIT, addChecklistItem, checklistOf, type Checklist, checklistProgress, removeChecklistItem, toggleChecklistItem } from './checklistLogic';

/** 할 일 체크리스트. 항목을 추가·체크·삭제할 때마다 바로 저장하고, 실패하면 원래 상태를 유지한다. */
export function TaskChecklist({ task, readOnly, onChange }: { task: Task; readOnly: boolean; onChange: (checklist: Checklist) => Promise<void> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const items = checklistOf(task);
  const { done, total } = checklistProgress(items);

  const save = async (next: Checklist): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError('');
    try { await onChange(next); return true; } catch { setError('체크리스트를 저장하지 못했습니다. 다시 시도하세요.'); return false; } finally { setBusy(false); }
  };
  const add = async () => {
    const next = addChecklistItem(items, text, crypto.randomUUID());
    if (next === items) return;
    if (await save(next)) setText('');
  };

  return (
    <section className="tasks-checklist" aria-label="체크리스트">
      <h3>체크리스트{total > 0 ? ` (${done}/${total})` : ''}</h3>
      {total === 0 && <p className="tasks-muted">항목이 없습니다.</p>}
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <label><input type="checkbox" checked={item.done} disabled={readOnly || busy} onChange={() => void save(toggleChecklistItem(items, item.id))} /><span className={item.done ? 'tasks-checklist__done' : undefined}>{item.text}</span></label>
            {!readOnly && <button type="button" aria-label={`${item.text} 삭제`} disabled={busy} onClick={() => void save(removeChecklistItem(items, item.id))}>삭제</button>}
          </li>
        ))}
      </ul>
      {!readOnly && total < CHECKLIST_LIMIT && (
        <div className="tasks-checklist__add">
          <input aria-label="체크리스트 항목" placeholder="항목 추가" maxLength={200} value={text} disabled={busy} onChange={(event) => setText(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void add(); } }} />
          <button type="button" disabled={busy || text.trim() === ''} onClick={() => void add()}>추가</button>
        </div>
      )}
      {error && <p role="alert" className="tasks-error">{error}</p>}
    </section>
  );
}
