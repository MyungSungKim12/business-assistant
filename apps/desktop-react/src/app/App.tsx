import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog, NoticeHost, confirm, notify } from '@business-assistant/react-ui';
import type { ApiClient } from '../api/client';
import type { ConnectionState } from '../platform/types';
import { useSessionStore } from '../store/session';
import { usePreferences } from '../store/preferences';
import { workspaceCache } from '../store/ttlCache';
import { LoginView } from '../features/auth/LoginView';
import { OrganizationCreateForm } from '../features/auth/OrganizationCreateForm';
import { OrganizationPicker } from '../features/auth/OrganizationPicker';
import { NotificationCenter } from '../features/notifications/NotificationCenter';
import { useNotifications } from '../features/notifications/useNotifications';
import { SearchPalette } from '../features/search/SearchPalette';
import type { SearchResult } from '../features/search/searchModel';
import { TopBar, type MenuId } from '../features/shell/TopBar';
import { searchMenus } from '../features/shell/menuCatalog';
import { SettingsDialog } from '../features/settings/SettingsDialog';
import type { WorkspaceFocus } from './focus';
import { LockScreen } from './LockScreen';
import type { AppServices } from './services';
import { useIdleLock } from './useIdleLock';
import { usePlatformAdmin } from './usePlatformAdmin';
import { useSearchShortcut } from './useSearchShortcut';
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [focus, setFocus] = useState<WorkspaceFocus | null>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => services.platform.subscribeConnection((state) => { setConnection(state); services.platform.setTrayStatus?.(state); }), [services.platform]);

  useTrayActions(services.platform, { signedIn: phase !== 'login' && phase !== 'restoring', logout });

  const api = services.api as ApiClient;
  const ready = phase === 'ready' && Boolean(organization && entitlement && user);
  const userId = user?.user_id ?? '';
  const organizationId = organization?.id ?? '';
  const canManage = organization?.role === 'owner' || organization?.role === 'admin';
  const customerEnabled = Boolean(entitlement?.features.includes('crm.basic'));

  // 사용자별 설정(개인정보 가림, 자동 잠금)을 불러오고, 로그아웃·매장 전환 때 검색·알림 캐시를 비운다.
  useEffect(() => { usePreferences.getState().load(user?.user_id ?? null); }, [user?.user_id]);
  useEffect(() => () => workspaceCache.clear(), [userId, organizationId]);

  const idleLockMinutes = usePreferences((state) => state.idleLockMinutes);
  const fontScale = usePreferences((state) => state.fontScale);
  const startMenu = usePreferences((state) => state.startMenu);
  const notificationsEnabled = usePreferences((state) => state.notificationsEnabled);
  const updateNotice = usePreferences((state) => state.updateNotice);

  // 글자 크기: 문서 전체 배율. 미지원 환경에서는 무시된다.
  useEffect(() => {
    document.documentElement.style.zoom = fontScale === 1 ? '' : String(fontScale);
    return () => { document.documentElement.style.zoom = ''; };
  }, [fontScale]);
  // 시작 화면: 로그인(사용자 전환) 직후 한 번만 적용한다. 이후 메뉴 이동은 건드리지 않는다.
  const startedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || startedFor.current === userId) return;
    startedFor.current = userId;
    setActive(startMenu);
  }, [ready, userId, startMenu]);
  // 새 버전 알림: 앱이 자동으로 확인한 업데이트가 있으면 한 번 안내한다.
  useEffect(() => {
    if (!ready || !updateNotice || !services.platform.onUpdateAvailable) return undefined;
    let off: (() => void) | undefined;
    let cancelled = false;
    void services.platform.onUpdateAvailable((info) => notify.info(`새 버전 ${info.version || ''}을(를) 설치할 수 있습니다. 설정의 '업데이트 확인'에서 설치하세요.`))
      .then((unlisten) => { if (cancelled) unlisten(); else off = unlisten; }).catch(() => undefined);
    return () => { cancelled = true; off?.(); };
  }, [ready, updateNotice, services.platform]);
  const idle = useIdleLock(idleLockMinutes, ready);
  const platformAdmin = usePlatformAdmin(api, ready);
  const notifications = useNotifications({ api, organizationId, userId, enabled: ready && !idle.locked && notificationsEnabled });
  const openSearch = useCallback(() => setSearchOpen(true), []);
  useSearchShortcut(openSearch, ready && !idle.locked);
  const menus = useMemo(() => searchMenus(Boolean(canManage), platformAdmin, customerEnabled), [canManage, platformAdmin, customerEnabled]);

  // 작성 중인 내용이 있으면 메뉴를 옮기기 전에 확인한다. 이동했으면(또는 이미 그 화면이면) true.
  const navigate = async (id: MenuId): Promise<boolean> => {
    if (id === active) return true;
    if (dirty && !(await confirm({ title: '저장하지 않은 변경', message: '저장하지 않은 변경 내용이 있습니다. 이동하시겠습니까?', confirmLabel: '이동', tone: 'danger' }))) return false;
    setDirty(false);
    setFocus(null);
    setActive(id);
    return true;
  };
  const openSearchResult = async (result: SearchResult) => {
    setSearchOpen(false);
    const moved = await navigate(result.menu);
    if (moved && result.focus) setFocus({ ...result.focus, nonce: Date.now() });
  };

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

  const readOnly = organization.role === 'member';
  return (
    <>
      {/* 잠금 중에는 화면을 그대로 두되(작업 중 상태 유지) 입력·초점을 받지 못하게 하고 잠금 화면으로 가린다. */}
      <div className="app-shell" inert={idle.locked}>
        <TopBar
          organization={organization}
          user={user}
          connection={connection}
          active={active}
          customerEnabled={customerEnabled}
          readOnly={readOnly}
          canManage={canManage}
          platformAdmin={platformAdmin}
          onSearch={openSearch}
          notifications={notificationsEnabled ? <NotificationCenter state={notifications} onNavigate={(id) => void navigate(id)} /> : undefined}
          onNavigate={(id) => void navigate(id)}
          onSettings={() => setSettings(true)}
          onLogout={() => void logout()}
          onExit={services.platform.exitApp}
        />
        <main className="workspace">
          <Workspace api={api} organizationId={organization.id} organizationName={organization.name} canManage={canManage} currentUserId={user.user_id} currentRole={organization.role as 'owner' | 'admin' | 'member'}
            active={active} readOnly={readOnly} focus={focus} onNavigate={navigate} onDirtyChange={setDirty}
            onError={(error) => services.platform.log?.('ERROR', `화면 오류(${active}): ${error.name}: ${error.message.slice(0, 300)}`)} />
        </main>
        {settings && <SettingsDialog platform={services.platform} onClose={() => setSettings(false)} />}
        {searchOpen && !idle.locked && <SearchPalette api={api} organizationId={organization.id} menus={menus} onClose={() => setSearchOpen(false)} onSelect={(result) => void openSearchResult(result)} />}
        <NoticeHost />
        <ConfirmDialog />
      </div>
      {idle.locked && <LockScreen email={user.email} verify={(email, password) => services.api.login(email, password)} onUnlock={idle.unlock} onLogout={() => void logout()} />}
    </>
  );
}
