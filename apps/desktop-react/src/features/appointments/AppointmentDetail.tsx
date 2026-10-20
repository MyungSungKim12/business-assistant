import type { Appointment } from '../../api/schemas';
import type { ReactNode } from 'react';
import { AppointmentMemo } from './AppointmentMemo';
import { formatDateLabel, formatKstTime, kstDateKey } from './appointmentTime';
import { allowedTransitions, canEditAppointment, statusLabel, targetLabels, type NameLookup, type TargetStatus } from './appointmentRules';

const sourceLabels: Record<string, string> = { manual: '직접 등록', phone: '전화', walk_in: '현장 방문', online: '온라인' };

export interface AppointmentDetailProps {
  appointment: Appointment;
  customerName: NameLookup;
  staffName: NameLookup;
  /** 자원 ID → 이름(알 수 없으면 undefined). */
  resourceName: (id: string) => string | undefined;
  readOnly: boolean;
  busy?: boolean;
  onTransition: (target: TargetStatus) => void;
  /** 메모를 저장한다. 실패하면 던진다. */
  onSaveMemo: (memo: string) => Promise<void>;
  onEdit: () => void;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  onOpenCustomer?: () => void;
  onOpenTreatment?: () => void;
  onOpenCheckout?: () => void;
  history?: ReactNode;
}

/** 선택한 예약의 내용과 상태 변경·수정 버튼. */
export function AppointmentDetail({ appointment, customerName, staffName, resourceName, readOnly, busy = false, onTransition, onSaveMemo, onEdit, onClose, onDirtyChange, onBusyChange, onOpenCustomer, onOpenTreatment, onOpenCheckout, history }: AppointmentDetailProps) {
  const targets = readOnly ? [] : allowedTransitions(appointment.status);
  const editable = !readOnly && canEditAppointment(appointment.status);
  const startDate = kstDateKey(appointment.start_at);
  const endDate = kstDateKey(appointment.end_at);
  return (
    <section className="apt-detail" aria-label="예약 상세">
      <header className="apt-side__head">
        <h2>예약 상세</h2>
        <button type="button" onClick={onClose}>닫기</button>
      </header>
      <dl className="apt-detail__list">
        <div><dt>고객</dt><dd>{customerName(appointment.customer_id)}</dd></div>
        <div><dt>서비스</dt><dd>{appointment.service_name_snapshot}</dd></div>
        <div><dt>담당자</dt><dd>{staffName(appointment.staff_id)}</dd></div>
        <div>
          <dt>시간</dt>
          <dd>
            {formatDateLabel(startDate)} {formatKstTime(appointment.start_at)} ~ {endDate === startDate ? '' : `${formatDateLabel(endDate)} `}{formatKstTime(appointment.end_at)}
            <span className="muted"> (소요 {appointment.duration_minutes}분{appointment.buffer_minutes > 0 ? ` + 여유 ${appointment.buffer_minutes}분` : ''})</span>
          </dd>
        </div>
        <div><dt>상태</dt><dd><span className="apt-status" data-status={appointment.status}>{statusLabel(appointment.status)}</span></dd></div>
        <div>
          <dt>공간·장비</dt>
          <dd>{appointment.resource_ids.length === 0 ? <span className="muted">없음</span> : appointment.resource_ids.map((id) => resourceName(id) ?? '알 수 없는 자원').join(', ')}</dd>
        </div>
        <div><dt>등록 경로</dt><dd>{sourceLabels[appointment.source] ?? appointment.source}</dd></div>
        {appointment.cancellation_reason && <div><dt>취소 사유</dt><dd>{appointment.cancellation_reason}</dd></div>}
        {appointment.no_show_reason && <div><dt>노쇼 사유</dt><dd>{appointment.no_show_reason}</dd></div>}
      </dl>
      {(onOpenCustomer || onOpenTreatment || onOpenCheckout) && <div className="apt-detail__actions" role="group" aria-label="연결된 업무">
        {onOpenCustomer && <button type="button" disabled={busy} onClick={onOpenCustomer}>고객 정보</button>}
        {onOpenTreatment && <button type="button" disabled={busy} onClick={onOpenTreatment}>시술 이력</button>}
        {onOpenCheckout && (appointment.status==='checked_in'||appointment.status==='completed') && <button type="button" disabled={busy} onClick={onOpenCheckout}>수납 장바구니</button>}
      </div>}
      <AppointmentMemo key={appointment.id} value={appointment.memo} readOnly={readOnly} onSave={onSaveMemo} onDirtyChange={onDirtyChange} onBusyChange={onBusyChange} />
      {history}
      {(targets.length > 0 || editable) && (
        <div className="apt-detail__actions" role="group" aria-label="예약 처리">
          {targets.map((target) => (
            <button key={target} type="button" disabled={busy} className={target === 'canceled' || target === 'no_show' ? 'danger-button' : 'primary-button'} onClick={() => onTransition(target)}>{targetLabels[target]}</button>
          ))}
          {editable && <button type="button" disabled={busy} onClick={onEdit}>예약 수정</button>}
        </div>
      )}
      {readOnly && <p className="muted">보기 전용 권한입니다.</p>}
      {!readOnly && !editable && targets.length === 0 && <p className="muted">완료·취소·노쇼 예약은 더 변경할 수 없습니다.</p>}
    </section>
  );
}
