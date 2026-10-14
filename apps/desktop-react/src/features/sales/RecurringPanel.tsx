import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { confirm, notify } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { errorMessage, formatWon, monthClosedMessage, today } from './format';
import {
  blankRecurring, dueDay, monthTooFar, pendingCount, recurringApi, recurringStatus, recurringToForm, validateRecurring,
  type RecurringExpense, type RecurringForm,
} from './recurring';
import './sales.css';

type Props = { api: ApiClient; organizationId: string; readOnly: boolean; categories: string[]; onDirty: (dirty: boolean) => void };
const statusText = { registered: '등록됨', pending: '등록 대기', inactive: '사용 안 함' } as const;
const same = (a: RecurringForm, b: RecurringForm) => JSON.stringify(a) === JSON.stringify(b);

function failure(error: unknown): string {
  if (monthClosedMessage(error)) return monthClosedMessage(error)!;
  if (error instanceof ApiError && error.status === 409) return '같은 이름의 반복 지출이 있거나 다른 곳에서 먼저 수정되었습니다. 목록을 새로 불러옵니다.';
  if (error instanceof ApiError && error.status === 403) return '반복 지출은 소유자·관리자만 만들거나 고칠 수 있습니다.';
  return errorMessage(error, '반복 지출 처리');
}

/**
 * 반복 지출(FIN-11). 월세·통신비처럼 매달 나가는 지출을 저장해 두고, 월마다 버튼 한 번으로 그 달의 지출을 등록한다.
 * 자동 등록은 없다. 같은 달에 같은 항목은 한 번만 등록되어 여러 번 눌러도 중복되지 않고, 마감된 달에는 등록되지 않는다.
 */
export function RecurringPanel({ api, organizationId, readOnly, categories, onDirty }: Props) {
  const todayKey = today();
  const [month, setMonth] = useState(todayKey.slice(0, 7));
  const [items, setItems] = useState<RecurringExpense[]>([]);
  const [registered, setRegistered] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<RecurringExpense | null>(null);
  const [form, setForm] = useState<RecurringForm>(blankRecurring);
  const [baseline, setBaseline] = useState<RecurringForm>(form);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const ticket = useRef(0);
  const dirty = !same(form, baseline);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  const load = useCallback(async () => {
    const mine = ++ticket.current;
    setLoading(true); setError('');
    try {
      const [list, runs] = await Promise.all([
        recurringApi.list(api, organizationId),
        /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? recurringApi.runs(api, organizationId, month) : Promise.resolve([]),
      ]);
      if (mine !== ticket.current) return;
      setItems(list);
      setRegistered(new Set(runs.map((run) => run.recurring_id)));
    } catch (e) {
      if (mine !== ticket.current) return;
      setError(errorMessage(e, '반복 지출 조회'));
    } finally { if (mine === ticket.current) setLoading(false); }
  }, [api, organizationId, month]);
  useEffect(() => { void load(); }, [load]);

  const fill = (item: RecurringExpense | null) => {
    const next = item ? recurringToForm(item) : blankRecurring();
    setSelected(item); setForm(next); setBaseline(next); setFormError('');
  };
  async function guarded(action: () => void) {
    if (dirty && !await confirm({ title: '저장하지 않은 변경', message: '저장하지 않은 변경 내용이 있습니다. 이동하시겠습니까?', confirmLabel: '이동', tone: 'danger' })) return;
    action();
  }

  async function save() {
    if (saving) return;
    const checked = validateRecurring(form);
    if ('error' in checked) { setFormError(checked.error); return; }
    setSaving(true); setFormError('');
    try {
      const saved = selected
        ? await recurringApi.update(api, organizationId, selected.id, { ...checked.value, expected_version: selected.version })
        : await recurringApi.create(api, organizationId, checked.value);
      notify.success(selected ? '반복 지출을 수정했습니다. 이미 등록된 거래는 바뀌지 않습니다.' : '반복 지출을 만들었습니다.');
      fill(saved);
      await load();
    } catch (e) {
      setFormError(failure(e));
      if (e instanceof ApiError && e.status === 409) void load();
    } finally { setSaving(false); }
  }

  async function remove() {
    if (!selected || saving) return;
    if (!await confirm({ title: '반복 지출 삭제', message: `'${selected.name}'을(를) 삭제할까요? 이미 등록된 거래는 그대로 남습니다.`, confirmLabel: '삭제', tone: 'danger' })) return;
    setSaving(true); setFormError('');
    try {
      await recurringApi.remove(api, organizationId, selected.id);
      notify.success('반복 지출을 삭제했습니다.');
      fill(null);
      await load();
    } catch (e) { setFormError(failure(e)); void load(); } finally { setSaving(false); }
  }

  const pending = useMemo(() => pendingCount(items, registered), [items, registered]);
  const tooFar = monthTooFar(month, todayKey);
  async function generate() {
    if (saving || pending === 0) return;
    if (!await confirm({ title: '이 달 반복 지출 등록', message: `${month}의 반복 지출 ${pending}건을 지출로 등록할까요? 이미 등록된 항목은 건너뜁니다.`, confirmLabel: '등록' })) return;
    setSaving(true); setError('');
    try {
      const result = await recurringApi.generate(api, organizationId, month);
      notify.success(`${result.created}건을 지출로 등록했습니다.${result.skipped ? ` (이미 등록된 ${result.skipped}건은 건너뜀)` : ''}`);
      await load();
    } catch (e) { setError(failure(e)); } finally { setSaving(false); }
  }

  const set = (patch: Partial<RecurringForm>) => { setForm((old) => ({ ...old, ...patch })); setFormError(''); };
  const monthValid = /^\d{4}-(0[1-9]|1[0-2])$/.test(month);

  return <div className="finance-layout">
    <div className="finance-main">
      <div className="sales-filters">
        <label>등록할 월<input type="month" aria-label="등록할 월" value={month} onChange={(e) => setMonth(e.target.value)} /></label>
        {!readOnly && <button type="button" className="primary-button" disabled={saving || loading || pending === 0 || !monthValid || tooFar} onClick={() => void generate()}>{pending > 0 ? `이 달 반복 지출 등록 (${pending}건)` : '이 달 반복 지출 등록'}</button>}
        <button type="button" onClick={() => void load()}>새로고침</button>
      </div>
      {tooFar && <p className="muted" role="status">다음 달보다 먼 달은 등록할 수 없습니다.</p>}
      {error && <div role="alert" className="form-error">{error} <button type="button" onClick={() => void load()}>다시 시도</button></div>}
      {loading ? <p role="status" className="muted">반복 지출을 불러오는 중…</p> : (
        <div className="data-surface">
          <table>
            <caption>반복 지출 목록</caption>
            <thead><tr><th>이름</th><th>금액</th><th>분류</th><th>{month || '월'} 등록일</th><th>상태</th></tr></thead>
            <tbody>
              {items.map((item) => {
                const status = recurringStatus(item, registered);
                return (
                  <tr key={item.id} aria-selected={selected?.id === item.id} className={selected?.id === item.id ? 'is-selected' : undefined}>
                    <td><button type="button" className="sales-link" onClick={() => void guarded(() => fill(item))}>{item.name}</button></td>
                    <td>{formatWon(item.amount)}</td><td>{item.category}</td>
                    <td>{monthValid ? dueDay(month, item.day_of_month) : '-'}</td>
                    <td data-testid={`status-${item.id}`}>{statusText[status]}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {items.length === 0 && <p className="empty-state">등록된 반복 지출이 없습니다. 월세·통신비처럼 매달 나가는 지출을 추가해 보세요.</p>}
        </div>
      )}
    </div>
    {!readOnly && <aside className="editor-panel">
      <h2>{selected ? '반복 지출 수정' : '반복 지출 추가'}</h2>
      <label>이름<input maxLength={120} value={form.name} onChange={(e) => set({ name: e.target.value })} /></label>
      <label>금액(원)<input inputMode="decimal" value={form.amount} onChange={(e) => set({ amount: e.target.value })} /></label>
      <label>분류<input maxLength={200} list="finance-categories" value={form.category} onChange={(e) => set({ category: e.target.value })} /></label>
      <datalist id="finance-categories">{categories.map((name) => <option key={name} value={name} />)}</datalist>
      <label>매달 나가는 날<input type="number" min={1} max={31} value={form.day_of_month} onChange={(e) => set({ day_of_month: e.target.value })} /></label>
      <p className="muted">31일처럼 없는 날짜는 그 달의 마지막 날로 등록됩니다.</p>
      <label>거래처<input value={form.counterparty} onChange={(e) => set({ counterparty: e.target.value })} /></label>
      <label>메모<textarea value={form.memo} onChange={(e) => set({ memo: e.target.value })} /></label>
      <label className="inline"><input type="checkbox" checked={form.is_active} onChange={(e) => set({ is_active: e.target.checked })} /> 사용 (끄면 월 등록에서 제외)</label>
      {formError && <p role="alert" className="form-error">{formError}</p>}
      <div className="sales-actions">
        <button type="button" className="primary-button" disabled={saving || (!!selected && !dirty)} onClick={() => void save()}>{saving ? '저장 중…' : selected ? '수정 저장' : '추가'}</button>
        {selected && <button type="button" disabled={saving} onClick={() => void remove()}>삭제</button>}
        {selected && <button type="button" disabled={saving} onClick={() => void guarded(() => fill(null))}>새 항목</button>}
      </div>
    </aside>}
  </div>;
}
