import type { Appointment } from '../../api/schemas';
import { formatKstTime } from './appointmentTime';
import { allowedTransitions, statusLabel, targetLabels, type NameLookup, type TargetStatus } from './appointmentRules';

export interface AppointmentListProps {
  /** 그날 예약(시작 시각 순). */
  rows: Appointment[];
  customerName: NameLookup;
  staffName: NameLookup;
  selectedId: string | null;
  readOnly: boolean;
  onSelect: (appointment: Appointment) => void;
  onTransition: (appointment: Appointment, target: TargetStatus) => void;
}

/** 목록 보기: 선택한 날짜의 예약을 시간 순으로 나열하고 행에서 바로 상태를 바꾼다. */
export function AppointmentList({ rows, customerName, staffName, selectedId, readOnly, onSelect, onTransition }: AppointmentListProps) {
  return (
    <div className="apt-list-wrap">
      <ol className="apt-list">
        {rows.map((item) => {
          // 목록 행에서는 한 단계 진행(확정·방문·완료)과 취소만 바로 노출하고, 노쇼는 상세 패널에서 처리한다.
          const targets = readOnly ? [] : allowedTransitions(item.status).filter((target) => target !== 'no_show');
          return (
            <li key={item.id} className={item.id === selectedId ? 'is-selected' : undefined}>
              <button type="button" className="apt-list__main" aria-pressed={item.id === selectedId} aria-label={`${formatKstTime(item.start_at)} ${customerName(item.customer_id)} 상세`} onClick={() => onSelect(item)}>
                <time>{formatKstTime(item.start_at)}</time>
                <span className="apt-list__text">
                  <strong>{item.service_name_snapshot}</strong>
                  <span>{customerName(item.customer_id)} · {staffName(item.staff_id)}</span>
                </span>
                <em data-status={item.status}>{statusLabel(item.status)}</em>
              </button>
              {targets.length > 0 && (
                <div className="row-actions">
                  {targets.map((target) => <button key={target} type="button" onClick={() => onTransition(item, target)}>{targetLabels[target]}</button>)}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {rows.length === 0 && <p className="muted empty-state">이 날짜에 예약이 없습니다.</p>}
    </div>
  );
}
