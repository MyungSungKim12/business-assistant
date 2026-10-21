import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Modal } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';

type Props = { api: ApiClient; organizationId: string; customerId: string; onClose: () => void };
const fields = [
  ['profile_days', '고객 프로필 보유기간(일)'],
  ['sensitive_notes_days', '민감 상담정보 보유기간(일)'],
  ['treatment_photos_days', '시술 사진 보유기간(일)'],
  ['consent_records_days', '동의 증빙 보유기간(일)'],
  ['transaction_records_days', '거래 기록 보유기간(일)'],
  ['dispute_records_days', '분쟁 기록 보유기간(일)'],
  ['audit_events_days', '감사 이벤트 보유기간(일)'],
] as const;
type Field = (typeof fields)[number][0];
type Values = Record<Field, number | null>;
const emptyValues: Values = { profile_days: null, sensitive_notes_days: null, treatment_photos_days: null, consent_records_days: null, transaction_records_days: null, dispute_records_days: null, audit_events_days: null };

export function CustomerRetentionDialog({ api, organizationId, customerId, onClose }: Props) {
  const [values, setValues] = useState<Values>(emptyValues);
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<{ relationship_ended_at: string | null; active_hold: { id: string; reason: string; created_by: string; created_at: string } | null } | null>(null);
  const [holdReason, setHoldReason] = useState('');
  const [endReason, setEndReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [policyResponse, currentStatus] = await Promise.all([api.getCustomerRetentionPolicy(organizationId), api.getCustomerRetentionStatus(organizationId, customerId)]);
      setValues(policyResponse.policy ? Object.fromEntries(fields.map(([key]) => [key, policyResponse.policy?.[key] ?? null])) as Values : emptyValues);
      setVersion(policyResponse.policy?.version ?? 0);
      setStatus(currentStatus);
      setNotice(policyResponse.reason);
    } catch {
      setError('보유 정책과 고객 상태를 불러오지 못했습니다. 권한과 SQL 097 적용 여부를 확인하세요.');
    } finally { setLoading(false); }
  }, [api, organizationId, customerId]);
  useEffect(() => { void refresh(); }, [refresh]);

  async function savePolicy(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const saved = await api.saveCustomerRetentionPolicy(organizationId, { expected_version: version, ...values });
      setVersion(saved.version); setNotice('보유기간을 저장했습니다. 미설정 항목은 계속 파기를 차단합니다.');
    } catch { setError('저장하지 못했습니다. 다른 관리자가 먼저 수정했을 수 있으니 새로고침 후 다시 시도하세요.'); }
    finally { setBusy(false); }
  }

  async function setHold(active: boolean) {
    const reason = holdReason.trim();
    if (!reason) { setError('보류 설정 또는 해제 사유를 입력하세요.'); return; }
    setBusy(true); setError('');
    try { await api.setCustomerLegalHold(organizationId, customerId, active, reason); setHoldReason(''); await refresh(); }
    catch { setError(active ? '법적 보류를 설정하지 못했습니다.' : '법적 보류를 해제하지 못했습니다.'); }
    finally { setBusy(false); }
  }

  async function setRelationship(ended: boolean) {
    const reason = endReason.trim();
    if (!reason) { setError('관계 종료 또는 재개 사유를 입력하세요.'); return; }
    setBusy(true); setError('');
    try { await api.setCustomerRelationshipEnd(organizationId, customerId, ended ? new Date().toISOString() : null, reason); setEndReason(''); await refresh(); }
    catch { setError('고객 관계 상태를 저장하지 못했습니다.'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="고객 보유·파기 정책" size="lg" onClose={onClose}>
      <div className="cxt-body cx-retention">
        <p className="muted">조직별 기간을 사업자 정책에 맞게 입력하세요. 이 화면은 삭제를 실행하지 않습니다.</p>
        {error && <p role="alert" className="form-error">{error} <button type="button" onClick={() => void refresh()}>다시 시도</button></p>}
        {notice && <p className="cx-retention__notice">{notice}</p>}
        {loading ? <p className="muted">정책을 불러오는 중…</p> : <form className="cx-retention__form" onSubmit={(event) => void savePolicy(event)}>
          <h3>데이터별 보유기간</h3>
          <p className="muted">빈 값은 미설정입니다. 임의 기간을 넣지 않으며, 필수 분류가 모두 설정되어도 파기 실행은 별도 검증 완료 전까지 잠겨 있습니다.</p>
          {fields.map(([key, label]) => <label key={key}>{label}<input aria-label={label} type="number" min="1" max="36500" step="1" value={values[key] ?? ''} disabled={busy} onChange={(event) => setValues(current => ({ ...current, [key]: event.target.value === '' ? null : Number(event.target.value) }))} placeholder="미설정" /></label>)}
          <div className="cxt-footer"><button type="submit" className="primary-button" disabled={busy}>보유기간 저장</button></div>
        </form>}
        <section className="cx-retention__customer" aria-label="선택 고객 관계 및 보류 상태">
          <h3>선택 고객 상태</h3>
          <p>관계 종료: {status?.relationship_ended_at ? new Date(status.relationship_ended_at).toLocaleString() : '기록되지 않음'}</p>
          <label>관계 종료 사유<input aria-label="관계 종료 사유" maxLength={300} value={endReason} onChange={event => setEndReason(event.target.value)} /></label>
          <div className="cxt-footer"><button type="button" disabled={busy || loading} onClick={() => void setRelationship(!status?.relationship_ended_at)}>{status?.relationship_ended_at ? '관계 재개 기록' : '관계 종료 기록'}</button></div>
          <p>법적 보류: {status?.active_hold ? `설정됨 · ${status.active_hold.reason}` : '없음'}</p>
          <label>보류 사유<input aria-label="보류 사유" maxLength={300} value={holdReason} onChange={event => setHoldReason(event.target.value)} /><small className="muted">사유만 간단히 적고 고객의 민감정보는 입력하지 마세요.</small></label>
          <div className="cxt-footer"><button type="button" disabled={busy || loading} onClick={() => void setHold(!status?.active_hold)}>{status?.active_hold ? '법적 보류 해제' : '법적 보류 설정'}</button></div>
        </section>
        <p className="cx-retention__blocked"><strong>영구 삭제는 아직 사용할 수 없습니다.</strong> 예약·매출·회원권·동의·사진 원본과 Storage 파일을 분리하고, 재시도·백업 파기 증거를 확인한 뒤 별도 단계로 연결합니다.</p>
      </div>
    </Modal>
  );
}
