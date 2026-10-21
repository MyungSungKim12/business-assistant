import { useState, type ReactNode } from 'react';
import { Modal, notify } from '@business-assistant/react-ui';
import type { Task } from '../../api/schemas';
import { HOME_WIDGET_IDS, usePreferences, type HomeWidgetId } from '../../store/preferences';
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
import { operationalCustomers,useVisitFacts } from '../customers/visitFacts';
import type { Source } from './sourceState';
import type { Customer } from '../../api/schemas';

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
  /** 로그인한 사용자 ID. 구성원이 자기에게 지정된 할 일을 홈에서 바로 완료하는 데 쓴다. */
  currentUserId?: string;
  /** 현재 시각 공급자. 테스트에서 고정 시각을 넣는다. */
  now?: () => Date;
}

const systemNow = () => new Date();

/** 홈: 오늘 요약, 지표, 예약·할 일·고객·재고·회원권·수입지출 패널을 한 화면에 보여 준다. 패널마다 독립적으로 불러온다. */
export function DashboardPage({ api, organizationId, onNavigate, organizationName, canManage = false, readOnly = false, currentUserId = '', now = systemNow }: DashboardPageProps) {
  const chartDays = usePreferences((state) => state.homeChartDays);
  const homeWidgets = usePreferences((state) => state.homeWidgets);
  const setHomeWidgets = usePreferences((state) => state.setHomeWidgets);
  const [widgetsOpen,setWidgetsOpen]=useState(false);
  const [clock, setClock] = useState<Date>(() => now());
  const [refreshKey, setRefreshKey] = useState(0);
  const today = kstDateKey(clock) ?? '';
  const { sources, reload } = useDashboardData(api, organizationId, today, refreshKey);
  const customers = sourceData(sources.customers);
  const visitFacts=useVisitFacts(api,organizationId,(customers??[]).map(row=>row.id),refreshKey);
  const visitCustomers:Source<Customer[]>=sources.customers.status!=='ready'?sources.customers:visitFacts.status==='ready'?{status:'ready',data:operationalCustomers(customers??[],visitFacts.facts)}:visitFacts.status==='loading'?{status:'loading'}:{status:'error',failure:{kind:'error',message:'방문·예약 원장 조회 실패 · SQL 061 적용·권한·연결을 확인하세요.'}};

  const retryVisitFacts = () => { if(sources.customers.status==='error') reload.customers(); else visitFacts.retry(); };

  const refreshAll = () => {
    setClock(now());
    setRefreshKey((value) => value + 1);
  };

  /** 홈에서 바로 완료: 쓰기 권한이 있거나 그 할 일의 담당자만. 서버(DB)도 같은 규칙을 강제한다. */
  const canComplete = (task: Task) => !readOnly || (currentUserId !== '' && task.assignee_id === currentUserId);
  const completeTask = async (task: Task) => {
    try {
      await api.updateTask(organizationId, task.id, { status: 'done' });
      notify.success(`'${task.title}' 할 일을 완료했습니다.`);
      reload.tasks();
    } catch {
      notify.error('할 일을 완료하지 못했습니다. 다시 시도해 주세요.');
    }
  };

  const widgetNodes:Record<HomeWidgetId,ReactNode>={
    appointments:<AppointmentTimeline state={sources.appointments} customers={customers} today={today} onRetry={reload.appointments} onNavigate={onNavigate} />,
    tasks:<TaskPanel state={sources.tasks} today={today} onRetry={reload.tasks} onNavigate={onNavigate} canComplete={canComplete} onComplete={completeTask} />,
    visits:<UpcomingVisitPanel state={visitCustomers} today={today} onRetry={retryVisitFacts} onNavigate={onNavigate} />,
    recent:<RecentVisitorPanel state={visitCustomers} onRetry={retryVisitFacts} onNavigate={onNavigate} />,
    chart:<FinanceChartPanel state={sources.transactions} today={today} onRetry={reload.transactions} onNavigate={onNavigate} days={chartDays} onDaysChange={(value) => usePreferences.getState().setHomeChartDays(value)} />,
    stock:<LowStockPanel state={sources.products} onRetry={reload.products} onNavigate={onNavigate} />,
    wallet:<WalletExpiryPanel state={sources.wallets} customers={customers} today={today} onRetry={reload.wallets} onNavigate={onNavigate} />,
  };
  const widgetLabels:Record<HomeWidgetId,string>={appointments:'오늘 예약',tasks:'할 일',visits:'다음 방문 예정',recent:'최근 방문 고객',chart:'수입·지출 차트',stock:'재고 부족',wallet:'회원권 만료 예정'};
  const toggleWidget=(id:HomeWidgetId)=>{
    if(homeWidgets.includes(id)){if(homeWidgets.length>1)setHomeWidgets(homeWidgets.filter(item=>item!==id));}
    else setHomeWidgets([...homeWidgets,id]);
  };
  const moveWidget=(id:HomeWidgetId,delta:number)=>{
    const index=homeWidgets.indexOf(id),target=index+delta;if(index<0||target<0||target>=homeWidgets.length)return;
    const next=[...homeWidgets];[next[index],next[target]]=[next[target]!,next[index]!];setHomeWidgets(next);
  };

  return (
    <section className="dash" aria-label="홈">
      <header className="dash-head">
        <div className="dash-head__title">
          <h1>{organizationName ? `${organizationName}` : '오늘의 매장'}</h1>
          <span className="dash-head__date">{formatKstHeading(clock)}</span>
        </div>
        <QuickActions readOnly={readOnly} canManage={canManage} onNavigate={onNavigate} />
        <button type="button" className="dash-customize" onClick={()=>setWidgetsOpen(true)}>홈 구성</button>
        <button type="button" className="dash-refresh" onClick={refreshAll}>새로고침</button>
      </header>
      <MetricCards sources={sources} today={today} onNavigate={onNavigate} visitCustomers={visitCustomers} />
      <div className="dash-grid">
        {homeWidgets.map((id)=><div key={id} className={`dash-widget dash-widget--${id}`} data-widget={id}>{widgetNodes[id]}</div>)}
      </div>
      {widgetsOpen&&<Modal title="홈 구성" size="md" onClose={()=>setWidgetsOpen(false)}>
        <p className="muted">표시할 패널을 고르고 화살표로 순서를 바꾸세요. 설정은 이 사용자 계정에 저장됩니다.</p>
        <div className="dash-widget-settings">{HOME_WIDGET_IDS.map(id=>{const index=homeWidgets.indexOf(id),visible=index>=0;return <div className="dash-widget-settings__row" key={id}>
          <label><input type="checkbox" checked={visible} disabled={visible&&homeWidgets.length===1} onChange={()=>toggleWidget(id)}/>{widgetLabels[id]}</label>
          <button type="button" aria-label={`${widgetLabels[id]} 위로`} disabled={!visible||index===0} onClick={()=>moveWidget(id,-1)}>↑</button>
          <button type="button" aria-label={`${widgetLabels[id]} 아래로`} disabled={!visible||index===homeWidgets.length-1} onClick={()=>moveWidget(id,1)}>↓</button>
        </div>;})}</div>
      </Modal>}
    </section>
  );
}
