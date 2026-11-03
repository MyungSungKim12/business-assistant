import { useEffect, useRef, useState } from 'react';
import { Modal, confirm } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import type { z } from 'zod';
import type { phoneIdentificationSchema } from '../../api/schemas';
import type {PhoneResponse} from '../../api/phoneInbox';

type Match = z.infer<typeof phoneIdentificationSchema>['matches'][number];

export function PhoneMemoDialog({ api, organizationId, onClose, initialCall, onDirtyChange }: { api: ApiClient; organizationId: string; onClose: () => void; initialCall?: { id?:string; phone_e164: string; occurred_at: string; matches: Match[] }; onDirtyChange?: (dirty: boolean) => void }) {
  const [phone, setPhone] = useState(initialCall?.phone_e164 ?? '');
  const [memo, setMemo] = useState('');
  const [matches, setMatches] = useState<Match[]>(initialCall?.matches ?? []);
  const [selectedId, setSelectedId] = useState(initialCall?.matches.length === 1 ? initialCall.matches[0]!.customer_id : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict,setConflict]=useState(false);
  const pending=useRef<{signature:string;input:PhoneResponse}|null>(null);
  useEffect(() => { onDirtyChange?.(Boolean(memo.trim()) || busy); return () => onDirtyChange?.(false); }, [memo, busy, onDirtyChange]);
  async function close() {
    if (busy) return;
    if (memo.trim() && !await confirm({ title: '작성 중인 전화 메모', message: '저장하지 않은 메모를 버리고 닫을까요?', confirmLabel: '버리고 닫기', cancelLabel: '계속 작성', tone: 'danger' })) return;
    onClose();
  }

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
      if(initialCall?.id&&api.getPhoneInboxRecord){
        const signature=JSON.stringify([selectedId,memo.trim()]);
        let input=pending.current?.signature===signature?pending.current.input:null;
        if(!input){
          let record=null;
          try{record=await api.getPhoneInboxRecord(organizationId,initialCall.id);}catch(e){if(!(e&&typeof e==='object'&&'status' in e&&e.status===404))throw e;}
          if(record){input={recipient_id:record.recipient_id,expected_version:record.version,operation_id:crypto.randomUUID(),customer_id:selectedId,memo:memo.trim()};pending.current={signature,input};}
        }
        if(input){await api.respondPhoneInbox(organizationId,initialCall.id,input);onClose();return;}
      }
      await api.createMobilePhoneMemo(organizationId, { customer_id: selectedId, phone, memo: memo.trim(), occurred_at: initialCall?.occurred_at ?? new Date().toISOString() });
      onClose();
    } catch(e) {const changed=!!e&&typeof e==='object'&&'status' in e&&e.status===409;setConflict(changed);setError(changed?'다른 사람이 먼저 처리했습니다. 입력을 유지한 채 최신 기록을 확인해 주세요.':'메모를 저장하지 못했습니다. 작성한 내용은 유지되니 다시 시도해 주세요.'); }
    finally { setBusy(false); }
  }

  return <Modal title="전화 상담 메모" onClose={() => void close()}>
    <div className="cx-phone-memo">
      <p className="muted">통화 후 번호로 고객을 확인하고 상담 내용을 고객 활동에 기록합니다.</p>
      <label>전화번호<input disabled={busy} autoComplete="tel" inputMode="tel" value={phone} onChange={event => { setPhone(event.target.value); setMatches([]); setSelectedId(''); }} onKeyDown={event => { if (event.key === 'Enter') void identify(); }} placeholder="010-1234-5678" /></label>
      <button type="button" disabled={busy || !phone.trim()} onClick={() => void identify()}>{busy ? '확인 중…' : '고객 확인'}</button>
      {matches.length > 0 && <fieldset disabled={busy}><legend>고객 선택</legend>{matches.map(match => <label className="cx-phone-memo__match" key={match.customer_id}><input type="radio" name="phone-match" checked={selectedId === match.customer_id} onChange={() => setSelectedId(match.customer_id)} /> <span>{match.name}</span><small>{match.phone}</small></label>)}</fieldset>}
      <label>상담 메모<textarea disabled={busy} value={memo} onChange={event => setMemo(event.target.value)} rows={4} maxLength={10_000} placeholder="통화 내용을 입력하세요." /></label>
      {error && <p role="alert" className="form-error">{error}</p>}
      {conflict&&<button type="button" disabled={busy} onClick={()=>{pending.current=null;setConflict(false);setError('최신 버전을 다시 확인한 뒤 저장합니다. 기존 응대 기록은 전화 수신함에서 확인할 수 있습니다.');}}>최신 버전으로 다시 확인</button>}
      <div className="cx-phone-memo__actions"><button type="button" onClick={() => void close()} disabled={busy}>취소</button><button type="button" onClick={() => void save()} disabled={busy || conflict || !selectedId || !memo.trim()}>메모 저장</button></div>
    </div>
  </Modal>;
}
