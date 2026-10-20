import { useEffect, useState } from 'react';
import { Modal } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import type { Customer } from '../../api/schemas';
import { documentApi } from '../documents/api';
import { evidenceStatusLabel, type IssuedDocument, type Scope } from '../documents/schemas';
import { treatmentApi } from './api';
import { cautionsAcknowledged, localTime, sameCautions } from './logic';
import type { Treatment } from './schemas';

type Result<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; value: T };
type Props = Scope & { api: ApiClient; onClose: () => void; onConsultation: () => void; onDocuments?: () => void };

/** 선택한 발행본만 조회한다. 발행·서명·교부·철회와 서명 증빙의 일치는 별도 사실이다. */
function DocumentCheck({ api, scope, document }: { api: ApiClient; scope: Scope; document: IssuedDocument }) {
  const [state, setState] = useState<Result<{ signed: boolean; revoked: boolean; delivered: boolean; at?: string }>>({ status: 'loading' });
  const [proof, setProof] = useState('');
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const events = await documentApi.listEvents(api, scope, document.id);
        if (!active) return;
        if (events.some((event, index) => event.organization_id !== scope.organizationId || event.document_id !== document.id || event.revision !== index + 1)) throw new Error('scope or revision');
        const sign = events.find(event => event.action === 'sign');
        const revoked = events.some(event => event.action === 'revoke');
        setState({ status: 'ready', value: { signed: Boolean(sign), revoked, delivered: events.some(event => event.action === 'deliver'), at: sign?.occurred_at } });
        if (!sign || revoked) return;
        setProof('서명 증빙 확인 중…');
        try {
          const result = await documentApi.verifyEvent(api, scope, document.id, sign.id);
          if (!active) return;
          if (result.event_id !== sign.id || result.revision !== sign.revision) throw new Error('verification scope');
          setProof(`서명 증빙: ${evidenceStatusLabel[result.status]}`);
        } catch { if (active) setProof('서명 증빙을 확인하지 못했습니다. 문서를 다시 선택해 재시도하세요.'); }
      } catch { if (active) setState({ status: 'error' }); }
    })();
    return () => { active = false; };
  }, [api, scope, document.id]);
  if (state.status === 'loading') return <p role="status">선택한 발행본의 서명·교부·철회 이력을 확인하는 중…</p>;
  if (state.status === 'error') return <p role="alert">문서 이력을 확인하지 못했습니다. 문서를 다시 선택해 재시도하세요.</p>;
  const { signed, revoked, delivered, at } = state.value;
  return <div aria-label="선택 문서 확인 결과">
    <p>{revoked ? '철회 기록 있음 · 이 문서로 동의 상태를 판단하지 마세요.' : signed ? `손서명 기록 있음 · ${localTime(at)}` : '손서명 기록 없음 · 발행만으로 동의가 완료되지 않습니다.'}</p>
    <p>{delivered ? '교부 확인 기록 있음 · 실제 발송 여부는 별도 확인' : '교부 기록 없음'}</p>
    {proof && <p role="status">{proof}</p>}
  </div>;
}

export function TreatmentPreflight(props: Props) {
  // Scope 변경 시 이전 결과가 한 프레임이라도 새 고객에게 표시되지 않도록 remount 한다.
  return <PreflightContent key={`${props.organizationId}/${props.customerId}/${props.treatmentId}`} {...props} />;
}

function PreflightContent({ api, organizationId, customerId, treatmentId, onClose, onConsultation, onDocuments }: Props) {
  const [refresh, setRefresh] = useState(0);
  const [cautions, setCautions] = useState<Result<{ customer: Customer; record: Treatment }>>({ status: 'loading' });
  const [documents, setDocuments] = useState<Result<IssuedDocument[]>>({ status: 'loading' });
  const [selected, setSelected] = useState('');
  const [selection, setSelection] = useState(0);
  const [scope] = useState<Scope>({ organizationId, customerId, treatmentId });
  useEffect(() => {
    let active = true;
    setCautions({ status: 'loading' }); setDocuments({ status: 'loading' }); setSelected('');
    void Promise.all([api.listCustomers(organizationId), treatmentApi.list(api, organizationId, customerId)]).then(([customers, records]) => {
      const customer = customers.find(row => row.id === customerId && row.organization_id === organizationId);
      const record = records.find(row => row.id === treatmentId && row.customer_id === customerId && row.organization_id === organizationId);
      if (!customer || !record) throw new Error('missing source');
      if (active) setCautions({ status: 'ready', value: { customer, record } });
    }).catch(() => { if (active) setCautions({ status: 'error' }); });
    void documentApi.listIssued(api, scope).then(rows => {
      if (rows.some(row => row.organization_id !== organizationId || row.customer_id !== customerId || row.treatment_id !== treatmentId)) throw new Error('document scope');
      if (active) setDocuments({ status: 'ready', value: rows });
    }).catch(() => { if (active) setDocuments({ status: 'error' }); });
    return () => { active = false; };
  }, [api, organizationId, customerId, treatmentId, scope, refresh]);
  const document = documents.status === 'ready' ? documents.value.find(row => row.id === selected) : undefined;
  const checked = cautions.status === 'ready' ? cautions.value : undefined;
  return <Modal title="시술 전 확인" size="lg" onClose={onClose}>
    <div className="treatment-dialog">
      <p className="muted">조회 시점의 안내입니다. 문서 발행·손서명·교부·철회는 각각 확인하세요. 이 창을 열어도 주의 확인 기록이나 시술 상태는 바뀌지 않습니다.</p>
      <h3>고객 주의사항·상담</h3>
      {cautions.status === 'loading' && <p role="status">최신 고객·상담 정보를 확인하는 중…</p>}
      {cautions.status === 'error' && <p role="alert">최신 고객·상담 정보를 확인하지 못했습니다.</p>}
      {checked && <div className="treatment-cautions">
        <p>고객: {checked.customer.name}</p>
        <p>피부 타입: {checked.customer.skin_type || '미등록'}</p>
        <p>고민: {checked.customer.concerns.join(', ') || '미등록'}</p>
        <p>알레르기·주의사항</p><p>{checked.customer.allergies || '미등록 · 상담 시 확인'}</p>
        <p>{checked.record.consultation_goal.trim() ? `상담 목표: ${checked.record.consultation_goal}` : '상담 목표 미입력'}</p>
        <p>{!cautionsAcknowledged(checked.record) ? '주의사항 확인 기록 없음' : sameCautions(checked.record.cautions_snapshot, checked.customer) ? '확인한 주의정보와 현재 고객 정보가 같습니다.' : '고객 주의정보가 변경되었습니다. 상담에서 다시 확인·저장하세요.'}</p>
        {cautionsAcknowledged(checked.record) && <p>확인 시각: {localTime(checked.record.cautions_acknowledged_at)} · 확인자 ID: {checked.record.cautions_acknowledged_by}</p>}
      </div>}
      <h3>이 시술의 발행 문서</h3>
      {documents.status === 'loading' && <p role="status">발행 문서를 확인하는 중…</p>}
      {documents.status === 'error' && <p role="alert">발행 문서를 확인하지 못했습니다. 권한과 연결을 확인한 뒤 다시 시도하세요.</p>}
      {documents.status === 'ready' && <ul aria-label="시술 발행 문서">
        {documents.value.length === 0 && <li>이 시술에 발행한 문서가 없습니다.</li>}
        {documents.value.map(row => <li key={row.id}><button type="button" aria-pressed={selected === row.id} onClick={() => { setSelected(row.id); setSelection(value => value + 1); }}>{row.title} · v{row.template_version} · {localTime(row.issued_at)}</button></li>)}
      </ul>}
      {document && <DocumentCheck key={`${document.id}/${selection}`} api={api} scope={scope} document={document} />}
      <p className="muted">문서를 선택하면 해당 발행본의 이력과 서명 증빙을 확인합니다. 필수 동의서의 종류·적용 범위와 법적 효력은 이 조회로 판정하지 않습니다.</p>
      <div className="ba-actions">
        <button type="button" onClick={() => setRefresh(value => value + 1)}>최신 정보 다시 확인</button>
        <button type="button" onClick={onConsultation}>상담·주의 확인 열기</button>
        {onDocuments && <button type="button" onClick={onDocuments}>문서 발행·서명 열기</button>}
        <button type="button" onClick={onClose}>닫기</button>
      </div>
    </div>
  </Modal>;
}
