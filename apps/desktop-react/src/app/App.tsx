import { useEffect, useState } from 'react';
import { ConfirmDialog, NoticeHost } from '@business-assistant/react-ui';
import type { ApiClient } from '../api/client';
import type { ConnectionState } from '../platform/types';
import { useSessionStore } from '../store/session';
import { LoginView } from '../features/auth/LoginView';
import { OrganizationPicker } from '../features/auth/OrganizationPicker';
import { TopBar, type MenuId } from '../features/shell/TopBar';
import { SettingsDialog } from '../features/settings/SettingsDialog';
import { CustomerPage } from '../features/customers/CustomerPage';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { AppointmentPage } from '../features/appointments/AppointmentPage';
import { OperationPage, type OperationModule } from '../features/operations/OperationPage';
import { TaskPage } from '../features/tasks/TaskPage';
import type { AppServices } from './services';
import { useSessionFlow } from './useSessionFlow';
import './app.css';

export function App({ services }: { services: AppServices }) {
  const { user, organization, entitlement } = useSessionStore();
  const { phase, organizations, error, choose, login, logout } = useSessionFlow(services);
  const [connection, setConnection] = useState<ConnectionState>('checking');
  const [active, setActive] = useState<MenuId>('dashboard');
  const [settings, setSettings] = useState(false);
  useEffect(() => services.platform.subscribeConnection(setConnection), [services.platform]);

  if (phase === 'restoring') return <main className="center-layout"><p>세션을 확인하고 있습니다…</p></main>;
  if (phase === 'login') return <><LoginView error={error} onLogin={login} /><NoticeHost /></>;
  if (phase === 'empty') {
    return (
      <main className="center-layout">
        <section className="empty-card">
          <h1>접근 가능한 매장이 없습니다.</h1>
          <p>관리자에게 매장 초대를 요청해 주세요.</p>
          <button onClick={() => void logout()}>로그아웃</button>
        </section>
      </main>
    );
  }
  if (phase === 'organizations' || !organization || !entitlement || !user) {
    return <><OrganizationPicker organizations={organizations} onSelect={choose} />{error && <div className="permission-banner" role="alert">{error}</div>}</>;
  }

  const api = services.api as ApiClient;
  const readOnly = organization.role === 'member';
  const customerEnabled = entitlement.features.includes('crm.basic');
  return (
    <div className="app-shell">
      <TopBar
        organization={organization}
        user={user}
        connection={connection}
        active={active}
        customerEnabled={customerEnabled}
        readOnly={readOnly}
        onNavigate={setActive}
        onSettings={() => setSettings(true)}
        onLogout={() => void logout()}
        onExit={services.platform.exitApp}
      />
      <main className="workspace">
        {active === 'customers' ? <CustomerPage api={api} organizationId={organization.id} readOnly={readOnly} />
          : active === 'appointments' ? <AppointmentPage api={api} organizationId={organization.id} readOnly={readOnly} />
          : active === 'tasks' ? <TaskPage api={api} organizationId={organization.id} />
          : active === 'dashboard' ? <DashboardPage api={api} organizationId={organization.id} onNavigate={setActive} />
          : <OperationPage api={api} organizationId={organization.id} module={active as OperationModule} readOnly={readOnly} />}
      </main>
      {settings && <SettingsDialog platform={services.platform} onClose={() => setSettings(false)} />}
      <NoticeHost />
      <ConfirmDialog />
    </div>
  );
}
