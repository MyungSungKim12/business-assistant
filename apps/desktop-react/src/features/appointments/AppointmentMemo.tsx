import { useEffect, useRef, useState } from 'react';
import { useDraftProtection } from '../../app/DraftBoundary';

export const MEMO_LIMIT = 1000;

/** 예약 메모. 일정(버전·충돌 검사)과 별도로 저장하므로 완료·취소된 예약에도 남길 수 있다. 저장에 실패하면 입력을 그대로 둔다. */
export function AppointmentMemo({ value: rawValue, readOnly, onSave, onDirtyChange, onBusyChange }: { value?: string; readOnly: boolean; onSave: (memo: string) => Promise<void>; onDirtyChange?: (dirty: boolean) => void; onBusyChange?: (busy: boolean) => void }) {
  const value = rawValue ?? '';
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const baseline = useRef(value);
  useEffect(() => {
    if (draft === baseline.current) { setDraft(value); setError(''); }
    else if (value !== baseline.current && draft !== value) setError('다른 곳에서 메모가 변경되었습니다. 작성 내용은 유지됩니다. 내용을 확인하고 저장하세요.');
    baseline.current = value;
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = draft !== value;
  useDraftProtection(dirty, saving);
  useEffect(() => { onBusyChange?.(saving); return () => onBusyChange?.(false); }, [saving, onBusyChange]);
  useEffect(() => { onDirtyChange?.(dirty || saving); return () => onDirtyChange?.(false); }, [dirty, saving, onDirtyChange]);

  if (readOnly) return <div className="apt-memo"><h3>메모</h3>{value ? <p className="apt-memo__text">{value}</p> : <p className="muted">메모가 없습니다.</p>}</div>;

  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    setError('');
    try { await onSave(draft); } catch { setError('메모를 저장하지 못했습니다. 입력한 내용은 그대로 두었으니 다시 시도하세요.'); } finally { setSaving(false); }
  };
  return (
    <div className="apt-memo">
      <label>
        <h3>메모</h3>
        <textarea disabled={saving} value={draft} maxLength={MEMO_LIMIT} placeholder="알레르기·요청 사항 등을 적어 두세요" onChange={(event) => { setDraft(event.currentTarget.value); setError(''); }} />
      </label>
      <div className="apt-memo__foot">
        <span className="muted">{draft.length}/{MEMO_LIMIT}</span>
        <button type="button" disabled={saving || !dirty} onClick={() => void save()}>{saving ? '저장 중…' : '메모 저장'}</button>
      </div>
      {error && <p role="alert" className="form-error">{error}</p>}
    </div>
  );
}
