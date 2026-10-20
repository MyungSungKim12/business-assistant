import { usePrivacy } from '../../../lib/privacy';
import type { Customer } from '../../../api/schemas';
import type { MenuId } from '../../shell/TopBar';
import { VISIT_WINDOW_DAYS, recentVisitors, shortDate, upcomingVisits } from '../dashboardMetrics';
import type { Source } from '../sourceState';
import { Panel } from './Panel';

interface Props {
  state: Source<Customer[]>;
  today: string;
  onRetry: () => void;
  onNavigate: (menu: MenuId) => void;
}

function CustomerRow({ customer, date, onOpen }: { customer: Customer; date: string; onOpen: () => void }) {
  const privacy = usePrivacy();
  return (
    <li>
      <button type="button" className="dash-row dash-row--customer" onClick={onOpen}>
        <span className="dash-row__main"><strong>{customer.name}</strong><small>{privacy.phone(customer.phone) || '연락처 없음'}</small></span>
        <small className="dash-row__date">{shortDate(date.slice(0, 10))}</small>
      </button>
    </li>
  );
}

/** 7일 이내 다음 방문 예정 고객. */
export function UpcomingVisitPanel({ state, today, onRetry, onNavigate }: Props) {
  const open = () => onNavigate('customers');
  return (
    <Panel
      area="dash-area-visits"
      title={`다음 예약 임박 (${VISIT_WINDOW_DAYS}일)`}
      state={state}
      onRetry={onRetry}
      isEmpty={(customers) => upcomingVisits(customers, today).length === 0}
      emptyText="7일 안에 예약된 고객이 없습니다."
      headerExtra={(customers) => customers && <span className="dash-count">{upcomingVisits(customers, today).length}명</span>}
    >
      {(customers) => (
        <ul className="dash-list">
          {upcomingVisits(customers, today).map((customer) => <CustomerRow key={customer.id} customer={customer} date={customer.next_visit_date ?? ''} onOpen={open} />)}
        </ul>
      )}
    </Panel>
  );
}

/** 방문·완료 시술 원장 기준 최근 방문 고객 5명을 보여 준다. */
export function RecentVisitorPanel({ state, onRetry, onNavigate }: Omit<Props, 'today'>) {
  const open = () => onNavigate('customers');
  return (
    <Panel
      area="dash-area-recent"
      title="최근 방문 고객"
      state={state}
      onRetry={onRetry}
      isEmpty={(customers) => recentVisitors(customers).length === 0}
      emptyText="방문 기록이 있는 고객이 없습니다."
      emptyAction={<button type="button" className="ba-mini" onClick={open}>고객 등록</button>}
    >
      {(customers) => (
        <ul className="dash-list">
          {recentVisitors(customers).map((customer) => <CustomerRow key={customer.id} customer={customer} date={customer.last_visit_date ?? ''} onOpen={open} />)}
        </ul>
      )}
    </Panel>
  );
}
