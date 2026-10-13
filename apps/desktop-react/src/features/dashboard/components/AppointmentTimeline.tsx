import type { Customer } from '../../../api/schemas';
import type { MenuId } from '../../shell/TopBar';
import { appointmentStatusLabel, appointmentsOnDay, kstTime, summarizeAppointments } from '../dashboardMetrics';
import type { TodayAppointments } from '../dashboardApi';
import type { Source } from '../sourceState';
import { Panel } from './Panel';

interface Props {
  state: Source<TodayAppointments>;
  customers: Customer[] | null;
  today: string;
  onRetry: () => void;
  onNavigate: (menu: MenuId) => void;
}

/** 오늘 예약을 시간순으로 보여 주는 좌측 큰 패널. */
export function AppointmentTimeline({ state, customers, today, onRetry, onNavigate }: Props) {
  const customerNames = new Map((customers ?? []).map((customer) => [customer.id, customer.name]));
  return (
    <Panel
      area="dash-area-timeline"
      title="오늘 예약"
      state={state}
      onRetry={onRetry}
      isEmpty={(data) => appointmentsOnDay(data.appointments, today).length === 0}
      emptyText="오늘 예약이 없습니다."
      emptyAction={<button type="button" className="primary-button" onClick={() => onNavigate('appointments')}>새 예약</button>}
      headerExtra={(data) => (
        <>
          {data && <span className="dash-count">{summarizeAppointments(appointmentsOnDay(data.appointments, today)).total}건</span>}
          <button type="button" className="ba-mini" onClick={() => onNavigate('appointments')}>예약 메뉴</button>
        </>
      )}
    >
      {(data) => {
        const staffNames = new Map(data.staff.map((row) => [row.id, row.name]));
        return (
          <ol className="dash-list dash-timeline">
            {appointmentsOnDay(data.appointments, today).map((item) => (
              <li key={item.id}>
                <button type="button" className={`dash-row dash-row--time dash-row--${item.status}`} onClick={() => onNavigate('appointments')}>
                  <time dateTime={item.start_at}>{kstTime(item.start_at)}</time>
                  <span className="dash-row__main">
                    <strong>{customerNames.get(item.customer_id) ?? '고객 정보 없음'}</strong>
                    <small>{item.service_name_snapshot || '서비스 미지정'} · {staffNames.get(item.staff_id) ?? '담당자 미지정'}</small>
                  </span>
                  <span className={`dash-badge dash-badge--${item.status}`}>{appointmentStatusLabel[item.status] ?? item.status}</span>
                </button>
              </li>
            ))}
          </ol>
        );
      }}
    </Panel>
  );
}
