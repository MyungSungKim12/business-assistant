import { useRef, useState } from 'react';
import { Modal, confirm } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import type { Customer } from '../../api/schemas';
import { treatmentApi } from './api';
import { cautionSnapshot, cautionsAcknowledged, errorStatus, localTime, newOperationId, sameCautions } from './logic';
import type { ConsultationValues, Treatment } from './schemas';
import { useStable } from './useStable';
import './treatments.css';

type Props = { api: ApiClient; organizationId: string; customer: Customer; record: Treatment; readOnly: boolean; onSaved: (record: Treatment) => void; onClose: () => void };

/** 상담 목표·예정 관리와 고객 주의사항 확인(TRT-001). 준비(draft) 상태에서만 수정한다. */
export function ConsultationDialog({ api, organizationId, customer, record, readOnly, onSaved, onClose }: Props) {
  const editable = !readOnly && record.status === 'draft';
  const acknowledgedNow = cautionsAcknowledged(record) && sameCautions(record.cautions_snapshot, customer);
  const [goal, setGoal] = useState(record.consultation_goal);
  const [plan, setPlan] = useState(record.consultation_plan);
  const [acknowledge, setAcknowledge] = useState(acknowledgedNow);
  const [baseline] = useState({ goal: record.consultation_goal, plan: record.consultation_plan, acknowledge: acknowledgedNow });
  const [saving, setSaving] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const [message, setMessage] = useState(editable ? '빈 초안도 저장할 수 있습니다. 시술 시작 전 목표와 주의 확인을 완료하세요.' : '준비 상태에서만 상담을 수정할 수 있습니다.');
  const pending = useRef<{ fingerprint: string; operationId: string } | null>(null);
  const dirty = editable && (goal !== baseline.goal || plan !== baseline.plan || acknowledge !== baseline.acknowledge);

  const requestClose = async () => {
    if (saving) { setMessage('저장이 끝난 뒤 닫아주세요.'); return; }
    if (dirty && !await confirm({ title: '작성 중인 상담', message: '저장하지 않은 상담 내용을 버리고 닫으시겠습니까?', confirmLabel: '버리고 닫기', tone: 'danger' })) return;
    onClose();
  };

  const onModalClose = useStable(() => void requestClose());

  async function save() {
    if (!editable || saving || conflicted) return;
    if (goal.length > 2000 || plan.length > 5000) { setMessage('상담 목표는 2,000자, 예정 관리 내용은 5,000자 이내로 입력하세요.'); return; }
    const values: ConsultationValues = { goal, plan, acknowledge_cautions: acknowledge, expected_cautions: cautionSnapshot(customer) };
    // 같은 입력의 재시도는 같은 operation_id를 써서 서버에서 한 번만 반영되게 한다.
    const fingerprint = JSON.stringify({ values, version: record.version });
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, operationId: newOperationId() };
    setSaving(true);
    setMessage('상담을 저장하는 중…');
    try {
      const saved = await treatmentApi.mutate(api, organizationId, customer.id, record.id, { action: 'consult', expected_version: record.version, operation_id: pending.current.operationId, reason: '', values });
      onSaved(saved);
      onClose();
    } catch (error) {
      const status = errorStatus(error);
      if (status === 409) { setConflicted(true); setMessage('고객 정보 또는 시술 기록이 변경됐습니다. 입력을 보관한 뒤 닫고 상담을 다시 열어주세요.'); }
      else if (status === 422) setMessage('입력값을 확인하세요. 입력은 유지됩니다.');
      else setMessage('저장에 실패했습니다. 입력은 유지됩니다. 다시 저장할 수 있습니다.');
    } finally { setSaving(false); }
  }

  const confirmation = record.cautions_acknowledged_at
    ? `${acknowledgedNow ? '확인 완료' : '고객 정보 변경 · 다시 확인 필요'} · ${localTime(record.cautions_acknowledged_at)} · 확인자 ID: ${record.cautions_acknowledged_by ?? '—'}`
    : '아직 주의사항을 확인하지 않았습니다.';

  return (
    <Modal title={`상담 기록 · ${customer.name} · ${record.treatment_name}`} size="lg" onClose={onModalClose}>
      <div className="treatment-dialog">
        <div className="treatment-cautions" aria-label="고객 주의사항">
          <div>피부 타입: {customer.skin_type || '미등록'}</div>
          <div>고민: {customer.concerns.join(', ') || '미등록'}</div>
          <div>알레르기·주의사항: {customer.allergies || '미등록 · 상담 시 확인'}</div>
        </div>
        <label>상담 목표 · 시술 시작 전 필수
          <textarea value={goal} readOnly={!editable || saving} maxLength={2000} placeholder="고객 요청, 개선하고 싶은 점, 오늘 관리 목표 (2,000자 이내)" onChange={(event) => setGoal(event.target.value)} />
        </label>
        <label>예정 관리 내용
          <textarea value={plan} readOnly={!editable || saving} maxLength={5000} placeholder="예상 서비스와 진행 시 유의할 내용 (5,000자 이내)" onChange={(event) => setPlan(event.target.value)} />
        </label>
        <label className="treatment-check">
          <input type="checkbox" checked={acknowledge} disabled={!editable || saving} onChange={(event) => setAcknowledge(event.target.checked)} />
          위 고객 정보와 미등록 항목을 상담에서 직접 확인했습니다.
        </label>
        <p className="muted">{confirmation}</p>
        <p role="status" className={conflicted ? 'form-error' : 'muted'}>{message}</p>
        <div className="ba-actions">
          <button type="button" disabled={saving} onClick={() => void requestClose()}>닫기</button>
          {editable && <button type="button" className="primary-button" disabled={saving || conflicted} onClick={() => void save()}>{saving ? '저장 중…' : '상담 초안 저장'}</button>}
        </div>
      </div>
    </Modal>
  );
}
