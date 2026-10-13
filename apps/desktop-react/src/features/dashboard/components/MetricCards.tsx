import type { MenuId } from '../../shell/TopBar';
import {
  LOW_STOCK_THRESHOLD, VISIT_WINDOW_DAYS, activeCustomers, bucketTasks, groupDigits, lowStock, monthTotals, receivableTotal,
  summarizeAppointments, appointmentsOnDay, upcomingVisits, wonOf,
} from '../dashboardMetrics';
import type { DashboardSources } from '../useDashboardData';
import type { Source } from '../sourceState';

type Tone = 'normal' | 'warn' | 'bad';
interface Card { id: string; label: string; menu: MenuId; value: string; sub: string; tone: Tone; state: 'loading' | 'ready' | 'error'; problem?: string }

function build<T>(source: Source<T>, label: string, menu: MenuId, id: string, make: (data: T) => { value: string; sub: string; tone?: Tone }): Card {
  if (source.status === 'loading') return { id, label, menu, value: '…', sub: '불러오는 중', tone: 'normal', state: 'loading' };
  if (source.status === 'error') {
    const short = source.failure.kind === 'forbidden' ? '권한 없음' : source.failure.kind === 'unavailable' ? '미사용 기능' : '불러오기 실패';
    return { id, label, menu, value: '-', sub: short, tone: 'normal', state: 'error', problem: short };
  }
  const made = make(source.data);
  return { id, label, menu, value: made.value, sub: made.sub, tone: made.tone ?? 'normal', state: 'ready' };
}

/** 핵심 지표 카드 줄. 카드마다 자기 원본의 상태만 보고 독립적으로 표시한다. */
export function MetricCards({ sources, today, onNavigate }: { sources: DashboardSources; today: string; onNavigate: (menu: MenuId) => void }) {
  const cards: Card[] = [
    build(sources.customers, '전체 고객', 'customers', 'customers', (customers) => ({
      value: `${groupDigits(activeCustomers(customers).length)}명`,
      sub: `${VISIT_WINDOW_DAYS}일 내 방문 예정 ${upcomingVisits(customers, today).length}명`,
    })),
    build(sources.appointments, '오늘 예약', 'appointments', 'appointments', ({ appointments }) => {
      const summary = summarizeAppointments(appointmentsOnDay(appointments, today));
      return { value: `${groupDigits(summary.total)}건`, sub: `미완료 ${summary.open} · 완료 ${summary.done}` };
    }),
    build(sources.tasks, '미완료 할 일', 'tasks', 'tasks', (tasks) => {
      const buckets = bucketTasks(tasks, today);
      const tone: Tone = buckets.overdue.length > 0 ? 'bad' : buckets.today.length > 0 ? 'warn' : 'normal';
      return { value: `${groupDigits(buckets.active)}건`, sub: `기한 지남 ${buckets.overdue.length} · 오늘 ${buckets.today.length}`, tone };
    }),
    build(sources.transactions, '이번 달 순수입', 'finance', 'finance', (transactions) => {
      const totals = monthTotals(transactions, today);
      return { value: wonOf(totals.net), sub: `수입 ${wonOf(totals.income)} · 지출 ${wonOf(totals.expense)}`, tone: totals.net < 0n ? 'bad' : 'normal' };
    }),
    build(sources.settlement, '오늘 미수금', 'sales', 'receivable', (settlement) => {
      const due = receivableTotal(settlement.receivables);
      return { value: wonOf(due.total), sub: `미수 ${due.count}건`, tone: due.count > 0 ? 'warn' : 'normal' };
    }),
    build(sources.products, '재고 부족 상품', 'inventory', 'stock', (products) => {
      const low = lowStock(products);
      return { value: `${groupDigits(low.length)}개`, sub: `재고 ${LOW_STOCK_THRESHOLD}개 이하`, tone: low.length > 0 ? 'warn' : 'normal' };
    }),
  ];
  return (
    <div className="dash-cards">
      {cards.map((card) => (
        <button
          key={card.id}
          type="button"
          className={`dash-card dash-card--${card.tone}${card.state === 'error' ? ' dash-card--error' : ''}`}
          aria-label={`${card.label} ${card.value} ${card.sub}`}
          onClick={() => onNavigate(card.menu)}
        >
          <span className="dash-card__label">{card.label}</span>
          <strong className="dash-card__value">{card.value}</strong>
          <span className="dash-card__sub">{card.sub}</span>
        </button>
      ))}
    </div>
  );
}
