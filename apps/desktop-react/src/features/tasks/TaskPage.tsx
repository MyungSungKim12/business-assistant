import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { Task } from '../../api/schemas';

export function TaskPage({ api, organizationId }: { api: ApiClient; organizationId: string }) {
  const [items, setItems] = useState<Task[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ title: '', description: '', due_at: '', priority: 'normal' as 'low'|'normal'|'high' });
  const load = useCallback(async () => {
    try { setItems(await api.listTasks(organizationId)); setError(''); }
    catch { setError('할 일 목록을 불러오지 못했습니다.'); }
  }, [api, organizationId]);
  useEffect(() => { void load(); }, [load]);
  const create = async () => {
    if (!form.title.trim()) return;
    setSaving(true);
    try {
      await api.createTask(organizationId, { ...form, title: form.title.trim(), due_at: form.due_at ? new Date(form.due_at).toISOString() : null });
      setForm({ title: '', description: '', due_at: '', priority: 'normal' });
      await load();
    } catch { setError('할 일을 저장하지 못했습니다.'); }
    finally { setSaving(false); }
  };
  const update = async (item: Task, status: 'open'|'in_progress'|'done'|'canceled') => {
    try { await api.updateTask(organizationId, item.id, { status }); await load(); }
    catch { setError('할 일 상태를 변경하지 못했습니다.'); }
  };
  return <section className="task-page">
    <div className="page-toolbar"><div><p className="eyebrow">TASKS</p><h1>할 일</h1><p className="muted">매장 업무를 등록하고 처리 상태를 공유합니다.</p></div></div>
    {error && <p role="alert" className="form-error">{error}</p>}
    <div className="task-layout">
      <div className="data-surface task-list">{items.map((item) => <article key={item.id} className={`task-item task-item--${item.status}`}><div><span className={`priority priority--${item.priority}`}>{item.priority === 'high' ? '높음' : item.priority === 'low' ? '낮음' : '보통'}</span><h2>{item.title}</h2><p>{item.description || '설명 없음'}</p><small>{item.due_at ? new Date(item.due_at).toLocaleString('ko-KR') : '기한 없음'}</small></div><div className="row-actions"><select aria-label="상태" value={item.status} onChange={(event) => void update(item, event.target.value as 'open'|'in_progress'|'done'|'canceled')}><option value="open">대기</option><option value="in_progress">진행</option><option value="done">완료</option><option value="canceled">취소</option></select><button className="danger-button" onClick={async()=>{try{await api.deleteTask(organizationId,item.id);await load()}catch{setError('할 일을 삭제하지 못했습니다.')}}}>삭제</button></div></article>)}{!items.length && <p className="empty-state">등록된 할 일이 없습니다.</p>}</div>
      <aside className="editor-panel"><h2>할 일 등록</h2><label>제목<input value={form.title} onChange={(e)=>setForm({...form,title:e.target.value})}/></label><label>설명<textarea value={form.description} onChange={(e)=>setForm({...form,description:e.target.value})}/></label><label>기한<input type="datetime-local" value={form.due_at} onChange={(e)=>setForm({...form,due_at:e.target.value})}/></label><label>우선순위<select value={form.priority} onChange={(e)=>setForm({...form,priority:e.target.value as typeof form.priority})}><option value="low">낮음</option><option value="normal">보통</option><option value="high">높음</option></select></label><button className="primary-button" disabled={saving||!form.title.trim()} onClick={()=>void create()}>{saving?'저장 중…':'할 일 등록'}</button></aside>
    </div>
  </section>;
}
