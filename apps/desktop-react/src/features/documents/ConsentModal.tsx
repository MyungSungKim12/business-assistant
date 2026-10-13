import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, confirm, notify } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { documentApi } from './api';
import { formatTime, isDefinitive, messageFor, newOperationId, statusOf } from './errors';
import { consentActionLabel, deliveryMethodLabel, type ConsentAction, type ConsentEvent, type ConsentRequest, type IssuedDocument, type Scope } from './schemas';
import { SignaturePad } from './SignaturePad';
import { hasInk, type Strokes } from './signature';

type Tab = 'sign' | 'deliver' | 'revoke' | 'history';
const empty = { signer: '', strokes: [] as Strokes, signConfirm: false, method: 'paper', recipient: '', reference: '', note: '', deliverConfirm: false, reason: '', revokeConfirm: false };

function signedValues(event: ConsentEvent | undefined): { signer: string; strokes: Strokes } {
  const values = event?.values ?? {};
  const strokes = Array.isArray(values.strokes) ? (values.strokes as Strokes) : [];
  return { signer: typeof values.signer_name === 'string' ? values.signer_name : '', strokes };
}

const saveMessages: Partial<Record<number, string>> = {
  401: '로그인이 만료되었습니다. 입력은 유지됩니다.',
  403: '기록 접근 또는 변경 권한이 없습니다. 입력은 유지됩니다.',
  409: '다른 기록이 추가되었습니다. 입력을 보존한 뒤 이력을 새로고침하세요.',
  422: '입력 형식과 확인 체크를 확인하세요. 입력은 유지됩니다.',
};

/** 발행본 한 건의 현장 손서명·교부 확인·철회 기록(append-only). 저장 요청은 operation_id를 유지한 채 같은 요청으로 재시도한다. */
export function ConsentModal({ api, scope, document, readOnly, onClose }: { api: ApiClient; scope: Scope; document: IssuedDocument; readOnly: boolean; onClose: () => void }) {
  const [events, setEvents] = useState<ConsentEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<ConsentRequest | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const [status, setStatus] = useState('이력을 불러오는 중…');
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<Tab>('sign');
  const [form, setForm] = useState(empty);
  const [selected, setSelected] = useState(-1);
  const patch = (changes: Partial<typeof empty>) => setForm((old) => ({ ...old, ...changes }));

  const signEvent = events.find((event) => event.action === 'sign');
  const signed = signEvent !== undefined;
  const revoked = events.some((event) => event.action === 'revoke');
  const unlocked = loaded && !readOnly && !busy && pending === null && !conflicted && !revoked;
  const dirty = !readOnly && JSON.stringify(form) !== JSON.stringify(empty);
  const stored = useMemo(() => signedValues(signEvent), [signEvent]);

  const load = useCallback(async () => {
    setBusy(true);
    setStatus('최신 이력을 불러오는 중…');
    try {
      const rows = await documentApi.listEvents(api, scope, document.id);
      setEvents(rows);
      setLoaded(true);
      setConflicted(false);
      setFailed(false);
      setStatus('최신 이력을 확인했습니다.');
    } catch (error) {
      setFailed(true);
      setStatus(messageFor(error, { 403: '발행본 접근 권한이 없습니다.', 404: '발행본을 찾을 수 없습니다.' }, '이력을 불러오지 못했습니다. 다시 시도하세요.'));
    } finally { setBusy(false); }
  }, [api, scope, document.id]);
  useEffect(() => { void load(); }, [load]);

  const send = async (request: ConsentRequest) => {
    setBusy(true);
    setStatus('기록을 저장하는 중…');
    try {
      const saved = await documentApi.recordEvent(api, scope, document.id, request);
      setEvents((old) => [...old.filter((event) => event.id !== saved.id), saved]);
      setPending(null);
      setConflicted(false);
      setForm((old) => request.action === 'sign' ? { ...old, signer: '', strokes: [], signConfirm: false } : request.action === 'deliver'
        ? { ...old, recipient: '', reference: '', note: '', deliverConfirm: false } : { ...old, reason: '', revokeConfirm: false });
      setStatus('기록을 저장했습니다.');
      setTab('history');
      notify.success('기록을 저장했습니다.');
    } catch (error) {
      const code = statusOf(error);
      if (isDefinitive(code)) setPending(null);
      setConflicted(code === 409);
      setStatus(messageFor(error, saveMessages, '요청을 완료하지 못했습니다. 입력은 유지됩니다. 같은 요청을 재시도하세요.'));
    } finally { setBusy(false); }
  };

  const save = (action: ConsentAction) => {
    if (!unlocked || (action === 'sign') === signed) return;
    let values: Record<string, unknown>;
    if (action === 'sign') {
      if (!form.signer.trim() || !hasInk(form.strokes) || !form.signConfirm) return setStatus('서명자 이름, 손서명과 확인 체크가 필요합니다.');
      values = { signer_name: form.signer.trim(), strokes: form.strokes, confirmed: true };
    } else if (action === 'deliver') {
      if (!form.recipient.trim() || !form.deliverConfirm || form.note.length > 2000) return setStatus('수령인과 교부 확인 체크가 필요합니다. 메모는 2,000자 이내입니다.');
      values = { method: form.method, recipient: form.recipient.trim(), reference: form.reference, note: form.note, confirmed: true };
    } else {
      const reason = form.reason.trim();
      if (!reason || reason.length > 2000 || !form.revokeConfirm) return setStatus('철회 사유(2,000자 이내)와 요청 확인 체크가 필요합니다.');
      values = { reason, confirmed: true };
    }
    const request: ConsentRequest = { action, values, expected_revision: Math.max(0, ...events.map((event) => event.revision)), operation_id: newOperationId() };
    setPending(request);
    void send(request);
  };

  const close = async () => {
    if (busy) return setStatus('요청 처리 후 닫아주세요.');
    if (dirty || pending) {
      const message = pending ? '저장 결과가 불명확합니다. 같은 요청 재시도로 결과를 확인할 수 있습니다. 그래도 닫으시겠습니까?' : '저장하지 않은 입력과 손서명을 버리시겠습니까?';
      if (!(await confirm({ title: '작성 중인 기록', message, confirmLabel: '버리고 닫기', tone: 'danger' }))) return;
    }
    onClose();
  };

  const event = events[selected];
  const eventDetail = (item: ConsentEvent) => {
    const v = item.values as Record<string, string>;
    if (item.action === 'sign') return `서명자: ${v.signer_name}\n손서명은 손서명 탭에서 조회할 수 있습니다.`;
    if (item.action === 'deliver') return `방법: ${deliveryMethodLabel[v.method] ?? v.method}\n수령인: ${v.recipient}\n참조: ${v.reference}\n메모: ${v.note}`;
    return `철회 사유: ${v.reason}`;
  };
  const tabs: Array<[Tab, string]> = [['sign', '손서명'], ['deliver', '교부 확인'], ['revoke', '철회'], ['history', '전체 이력']];
  const stateText = revoked ? '철회됨 · 원문과 손서명 보존' : signed ? '현장 손서명 기록됨 · 별도 본인인증 미수행' : loaded ? '서명 미확인' : '확인 중…';

  return (
    <Modal title="발행본 · 서명·교부·철회" size="lg" onClose={() => void close()}>
      <div className="doc-consent">
        <h3 className="doc-consent__title">{document.title} · 서식 v{document.template_version}</h3>
        <p className="doc-state" data-testid="consent-state">{stateText}</p>
        <pre className="doc-body" aria-label="발행본 내용">{document.content}</pre>
        <div role="tablist" className="doc-tabs">
          {tabs.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>{label}</button>)}
        </div>
        {tab === 'sign' && <div role="tabpanel" className="doc-form">
          <p className="muted">현장 손서명 보관 · 별도 본인인증은 수행하지 않습니다.</p>
          <label>서명자 이름<input maxLength={100} disabled={!unlocked || signed} value={signed ? stored.signer : form.signer} onChange={(e) => patch({ signer: e.target.value })} /></label>
          <SignaturePad value={signed ? stored.strokes : form.strokes} onChange={(strokes) => patch({ strokes })} disabled={!unlocked || signed} />
          {!readOnly && <>
            <label className="doc-check"><input type="checkbox" disabled={!unlocked || signed} checked={form.signConfirm} onChange={(e) => patch({ signConfirm: e.target.checked })} />위 발행본을 읽은 고객이 직접 서명한 것을 확인했습니다.</label>
            <button type="button" className="primary-button" disabled={!unlocked || signed} onClick={() => save('sign')}>이 발행본에 손서명 저장</button>
          </>}
        </div>}
        {tab === 'deliver' && <div role="tabpanel" className="doc-form">
          <p className="muted">외부에서 실제 교부한 사실을 기록합니다. 이 버튼은 메시지를 발송하지 않습니다.</p>
          <label>교부 방법<select disabled={!unlocked || !signed} value={form.method} onChange={(e) => patch({ method: e.target.value })}>{Object.entries(deliveryMethodLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label>수령인<input maxLength={200} disabled={!unlocked || !signed} value={form.recipient} onChange={(e) => patch({ recipient: e.target.value })} /></label>
          <label>확인 자료·참조<input maxLength={500} disabled={!unlocked || !signed} value={form.reference} onChange={(e) => patch({ reference: e.target.value })} /></label>
          <label>기록 메모<textarea maxLength={2000} disabled={!unlocked || !signed} value={form.note} onChange={(e) => patch({ note: e.target.value })} /></label>
          {!signed && loaded && <p className="muted">손서명이 기록된 뒤에 교부 확인을 남길 수 있습니다.</p>}
          {!readOnly && <>
            <label className="doc-check"><input type="checkbox" disabled={!unlocked || !signed} checked={form.deliverConfirm} onChange={(e) => patch({ deliverConfirm: e.target.checked })} />해당 발행본을 수령인에게 실제로 교부한 사실을 확인했습니다.</label>
            <button type="button" className="primary-button" disabled={!unlocked || !signed} onClick={() => save('deliver')}>교부 확인 기록 추가</button>
          </>}
        </div>}
        {tab === 'revoke' && <div role="tabpanel" className="doc-form">
          <p className="muted">철회 후에도 원문·손서명·교부 기록은 보존됩니다. 철회는 되돌릴 수 없습니다.</p>
          <label>철회 사유<textarea maxLength={2000} placeholder="고객의 철회 요청 사유와 확인 경위를 입력하세요." disabled={!unlocked || !signed} value={form.reason} onChange={(e) => patch({ reason: e.target.value })} /></label>
          {!readOnly && <>
            <label className="doc-check"><input type="checkbox" disabled={!unlocked || !signed} checked={form.revokeConfirm} onChange={(e) => patch({ revokeConfirm: e.target.checked })} />고객의 철회 요청을 확인했습니다.</label>
            <button type="button" className="danger-button" disabled={!unlocked || !signed} onClick={() => save('revoke')}>철회 기록 남기기</button>
          </>}
        </div>}
        {tab === 'history' && <div role="tabpanel" className="doc-history">
          <ul className="doc-list" aria-label="기록 이력">
            {events.map((item, index) => <li key={item.id}><button type="button" aria-pressed={selected === index} onClick={() => setSelected(index)}>{item.revision}. {consentActionLabel[item.action]} · {formatTime(item.occurred_at)}</button></li>)}
            {loaded && events.length === 0 && <li className="muted">아직 기록이 없습니다.</li>}
          </ul>
          {event && <pre className="doc-body" aria-label="기록 상세">{`${consentActionLabel[event.action]}\n기록자 ID: ${event.actor_id}\n기록 시각: ${formatTime(event.occurred_at)}\n${eventDetail(event)}`}</pre>}
        </div>}
        <p role={failed || conflicted ? 'alert' : 'status'} className={failed || conflicted ? 'form-error' : 'muted'}>{status}</p>
        <div className="doc-actions">
          <button type="button" disabled={busy || pending !== null} onClick={() => void load()}>이력 새로고침</button>
          {pending && <button type="button" disabled={busy} onClick={() => void send(pending)}>같은 요청 재시도</button>}
          <span className="doc-spacer" />
          <button type="button" onClick={() => void close()}>닫기</button>
        </div>
      </div>
    </Modal>
  );
}
