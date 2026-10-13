import { useState } from 'react';
import type { MenuId } from '../shell/TopBar';
import { AppointmentTimeline } from './components/AppointmentTimeline';
import { RecentVisitorPanel, UpcomingVisitPanel } from './components/CustomerPanels';
import { FinanceChartPanel } from './components/FinanceChart';
import { MetricCards } from './components/MetricCards';
import { QuickActions } from './components/QuickActions';
import { LowStockPanel, WalletExpiryPanel } from './components/StockWalletPanels';
import { TaskPanel } from './components/TaskPanel';
import type { DashboardApi } from './dashboardApi';
import { formatKstHeading, kstDateKey } from './dashboardMetrics';
import { sourceData } from './sourceState';
import { useDashboardData } from './useDashboardData';
import './dashboard.css';

export interface DashboardPageProps {
  api: DashboardApi;
  organizationId: string;
  onNavigate: (menu: MenuId) => void;
  /** 매장(조직) 이름. 없으면 일반 인사말만 보여 준다. */
  organizationName?: string;
  /** 소유자·관리자 여부. 경영 바로가기를 보여 줄지 정한다. */
  canManage?: boolean;
  /** 구성원(읽기 전용)이면 쓰기 메뉴 바로가기를 숨긴다. */
  readOnly?: boolean;
  /** 현재 시각 공급자. 테스트에서 고정 시각을 넣는다. */
  now?: () => Date;
}

const systemNow = () => new Date();

/** 홈: 오늘 요약, 지표, 예약·할 일·고객·재고·회원권·수입지출 패널을 한 화면에 보여 준다. 패널마다 독립적으로 불러온다. */
export function DashboardPage({ api, organizationId, onNavigate, organizationName, canManage = false, readOnly = false, now = systemNow }: DashboardPageProps) {
  const [clock, setClock] = useState<Date>(() => now());
  const [refreshKey, setRefreshKey] = useState(0);
  const today = kstDateKey(clock) ?? '';
  const { sources, reload } = useDashboardData(api, organizationId, today, refreshKey);
  const customers = sourceData(sources.customers);

  const refreshAll = () => {
    setClock(now());
    setRefreshKey((value) => value + 1);
  };

  return (
    <section className="dash" aria-label="홈">
      <header className="dash-head">
        <div className="dash-head__title">
          <h1>{organizationName ? `${organizationName}` : '오늘의 매장'}</h1>
          <span className="dash-head__date">{formatKstHeading(clock)}</span>
        </div>
        <QuickActions readOnly={readOnly} canManage={canManage} onNavigate={onNavigate} />
        <button type="button" className="dash-refresh" onClick={refreshAll}>새로고침</button>
      </header>
      <MetricCards sources={sources} today={today} onNavigate={onNavigate} />
      <div className="dash-grid">
        <AppointmentTimeline state={sources.appointments} customers={customers} today={today} onRetry={reload.appointments} onNavigate={onNavigate} />
        <TaskPanel state={sources.tasks} today={today} onRetry={reload.tasks} onNavigate={onNavigate} />
        <FinanceChartPanel state={sources.transactions} today={today} onRetry={reload.transactions} onNavigate={onNavigate} />
        <UpcomingVisitPanel state={sources.customers} today={today} onRetry={reload.customers} onNavigate={onNavigate} />
        <RecentVisitorPanel state={sources.customers} onRetry={reload.customers} onNavigate={onNavigate} />
        <LowStockPanel state={sources.products} onRetry={reload.products} onNavigate={onNavigate} />
        <WalletExpiryPanel state={sources.wallets} customers={customers} today={today} onRetry={reload.wallets} onNavigate={onNavigate} />
      </div>
    </section>
  );
}
