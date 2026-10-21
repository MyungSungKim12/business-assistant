import { useState } from 'react';
import { Modal } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import type { z } from 'zod';
import type { phoneIdentificationSchema } from '../../api/schemas';

type Match = z.infer<typeof phoneIdentificationSchema>['matches'][number];

export function PhoneMemoDialog({ api, organizationId, onClose }: { api: ApiClient; organizationId: string; onClose: () => void }) {
  const [phone, setPhone] = useState('');
  const [memo, setMemo] = useState('');
  const [matches, setMatches] = useState<Match[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function identify() {
    setBusy(true); setError(''); setMatches([]); setSelectedId('');
    try {
      const result = await api.identifyMobileCaller(organizationId, phone);
      setMatches(result.matches);
      if (result.matches.length === 1) setSelectedId(result.matches[0]!.customer_id);
      if (!result.matches.length) setError('등록된 활성 고객과 일치하는 번호가 없습니다. 고객 전화번호를 확인해 주세요.');
    } catch { setError('번호 조회에 실패했습니다. 입력 번호와 연결 상태를 확인한 뒤 다시 시도해 주세요.'); }
    finally { setBusy(false); }
  }

  async function save() {
    if (!selectedId || !memo.trim()) return;
    setBusy(true); setError('');
    try {
      await api.createMobilePhoneMemo(organizationId, { customer_id: selectedId, phone, memo: memo.trim(), occurred_at: new Date().toISOString() });
      onClose();
    } catch { setError('메모를 저장하지 못했습니다. 작성한 내용은 유지되니 다시 시도해 주세요.'); }
    finally { setBusy(false); }
  }

  return <Modal title="전화 상담 메모" onClose={onClose}>
    <div className="cx-phone-memo">
      <p className="muted">통화 후 번호로 고객을 확인하고 상담 내용을 고객 활동에 기록합니다.</p>
      <label>전화번호<input autoComplete="tel" inputMode="tel" value={phone} onChange={event => setPhone(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void identify(); }} placeholder="010-1234-5678" /></label>
      <button type="button" disabled={busy || !phone.trim()} onClick={() => void identify()}>{busy ? '확인 중…' : '고객 확인'}</button>
      {matches.length > 0 && <fieldset><legend>고객 선택</legend>{matches.map(match => <label className="cx-phone-memo__match" key={match.customer_id}><input type="radio" name="phone-match" checked={selectedId === match.customer_id} onChange={() => setSelectedId(match.customer_id)} /> <span>{match.name}</span><small>{match.phone}</small></label>)}</fieldset>}
      <label>상담 메모<textarea value={memo} onChange={event => setMemo(event.target.value)} rows={4} maxLength={10_000} placeholder="통화 내용을 입력하세요." /></label>
      {error && <p role="alert" className="form-error">{error}</p>}
      <div className="cx-phone-memo__actions"><button type="button" onClick={onClose} disabled={busy}>취소</button><button type="button" onClick={() => void save()} disabled={busy || !selectedId || !memo.trim()}>메모 저장</button></div>
    </div>
  </Modal>;
}
