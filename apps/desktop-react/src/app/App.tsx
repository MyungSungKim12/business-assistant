import { useEffect, useState } from 'react';
import { ConfirmDialog, NoticeHost, confirm } from '@business-assistant/react-ui';
import type { ApiClient } from '../api/client';
import type { ConnectionState } from '../platform/types';
import { useSessionStore } from '../store/session';
import { LoginView } from '../features/auth/LoginView';
import { OrganizationCreateForm } from '../features/auth/OrganizationCreateForm';
import { OrganizationPicker } from '../features/auth/OrganizationPicker';
import { TopBar, type MenuId } from '../features/shell/TopBar';
import { SettingsDialog } from '../features/settings/SettingsDialog';
import type { AppServices } from './services';
import { useSessionFlow } from './useSessionFlow';
import { useTrayActions } from './useTrayActions';
import { Workspace } from './Workspace';
import './app.css';

export function App({ services }: { services: AppServices }) {
  const { user, organization, entitlement } = useSessionStore();
  const { phase, organizations, error, notice, choose, login, signUp, createOrganization, logout } = useSessionFlow(services);
  const canCreateOrganization = Boolean(services.api.createOrganization);
  const [connection, setConnection] = useState<ConnectionState>('checking');
  const [active, setActive] = useState<MenuId>('dashboard');
  const [settings, setSettings] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => services.platform.subscribeConnection((state) => { setConnection(state); services.platform.setTrayStatus?.(state); }), [services.platform]);

  useTrayActions(services.platform, { signedIn: phase !== 'login' && phase !== 'restoring', logout });

  if (phase === 'restoring') return <><main className="center-layout"><p>세션을 확인하고 있습니다…</p></main><ConfirmDialog /></>;
  if (phase === 'login') return <><LoginView error={error} notice={notice} onLogin={login} onSignUp={services.api.signUp ? signUp : undefined} /><NoticeHost /><ConfirmDialog /></>;
  if (phase === 'empty') {
    return (
      <>
      <main className="center-layout">
        <section className="empty-card">
          <h1>접근 가능한 매장이 없습니다.</h1>
          <p>관리자에게 매장 초대를 요청하거나, 아래에서 새 매장을 만드세요.</p>
          {canCreateOrganization && <OrganizationCreateForm onCreate={createOrganization} />}
          {error && <p className="form-error" role="alert">{error}</p>}
          <button onClick={() => void logout()}>로그아웃</button>
        </section>
      </main>
      <ConfirmDialog />
      </>
    );
  }
  if (phase === 'organizations' || !organization || !entitlement || !user) {
    return <><OrganizationPicker organizations={organizations} onSelect={choose} onCreate={canCreateOrganization ? createOrganization : undefined} />{error && <div className="permission-banner" role="alert">{error}</div>}<ConfirmDialog /></>;
  }

  const api = services.api as ApiClient;
  const canManage = organization.role === 'owner' || organization.role === 'admin';
  // 작성 중인 내용이 있으면 메뉴를 옮기기 전에 확인한다.
  const navigate = async (id: MenuId) => {
    if (id === active) return;
    if (dirty && !(await confirm({ title: '저장하지 않은 변경', message: '저장하지 않은 변경 내용이 있습니다. 이동하시겠습니까?', confirmLabel: '이동', tone: 'danger' }))) return;
    setDirty(false);
    setActive(id);
  };
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
        canManage={canManage}
        onNavigate={(id) => void navigate(id)}
        onSettings={() => setSettings(true)}
        onLogout={() => void logout()}
        onExit={services.platform.exitApp}
      />
      <main className="workspace">
        <Workspace api={api} organizationId={organization.id} organizationName={organization.name} canManage={canManage} active={active} readOnly={readOnly} onNavigate={navigate} onDirtyChange={setDirty}
          onError={(error) => services.platform.log?.('ERROR', `화면 오류(${active}): ${error.name}: ${error.message.slice(0, 300)}`)} />
      </main>
      {settings && <SettingsDialog platform={services.platform} onClose={() => setSettings(false)} />}
      <NoticeHost />
      <ConfirmDialog />
    </div>
  );
}
