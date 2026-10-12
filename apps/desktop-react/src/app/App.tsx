import { useCallback, useEffect, useState } from 'react';
import { NoticeHost } from '@business-assistant/react-ui';
import type { Organization, Session } from '../api/schemas';
import type { ConnectionState } from '../platform/types';
import { useSessionStore } from '../store/session';
import { LoginView } from '../features/auth/LoginView';
import { OrganizationPicker } from '../features/auth/OrganizationPicker';
import { TopBar, type MenuId } from '../features/shell/TopBar';
import { SettingsDialog } from '../features/settings/SettingsDialog';
import { CustomerPage } from '../features/customers/CustomerPage';
import type { ApiClient } from '../api/client';
import type { AppServices } from './services';
import './app.css';

export function App({ services }: { services: AppServices }) {
  const { user, organization, entitlement, setUser, selectOrganization, reset } = useSessionStore();
  const [phase, setPhase] = useState<'restoring'|'login'|'organizations'|'ready'|'empty'>('restoring');
  const [organizations, setOrganizations] = useState<Organization[]>([]); const [error, setError] = useState('');
  const [connection, setConnection] = useState<ConnectionState>('checking'); const [active, setActive] = useState<MenuId>('dashboard'); const [settings, setSettings] = useState(false);
  useEffect(() => services.platform.subscribeConnection(setConnection), [services.platform]);
  const choose = useCallback(async (org: Organization) => { try { const grants = await services.api.getEntitlements(org.id); selectOrganization(org, grants); setPhase('ready'); } catch (reason) { setError((reason as { status?: number }).status === 403 ? '이 매장을 볼 권한이 없습니다.' : '매장 정보를 불러오지 못했습니다.'); setPhase('organizations'); } }, [selectOrganization, services.api]);
  const continueSession = useCallback(async (session: Session) => { setUser(session.user); const items = await services.api.listOrganizations(); setOrganizations(items); if (!items.length) setPhase('empty'); else if (items.length === 1) await choose(items[0]); else setPhase('organizations'); }, [choose, services.api, setUser]);
  useEffect(() => { let current = true; services.api.restoreSession().then((result) => { if (!current) return; if (result.authenticated) return continueSession(result.session); setPhase('login'); }).catch(() => { if (current) setPhase('login'); }); return () => { current = false; }; }, [continueSession, services.api]);
  if (phase === 'restoring') return <main className="center-layout"><p>세션을 확인하고 있습니다…</p></main>;
  if (phase === 'login') return <><LoginView error={error} onLogin={async (email,password) => { setError(''); try { await continueSession(await services.api.login(email,password)); } catch { setError('이메일과 비밀번호를 확인해 주세요.'); } }}/><NoticeHost/></>;
  if (phase === 'empty') return <main className="center-layout"><section className="empty-card"><h1>접근 가능한 매장이 없습니다.</h1><p>관리자에게 매장 초대를 요청해 주세요.</p><button onClick={async () => { await services.api.logout(); reset(); setPhase('login'); }}>로그아웃</button></section></main>;
  if (phase === 'organizations' || !organization || !entitlement || !user) return <><OrganizationPicker organizations={organizations} onSelect={choose}/>{error && <div className="permission-banner" role="alert">{error}</div>}</>;
  const customerEnabled = entitlement.features.includes('crm.basic'); const readOnly = organization.role === 'member';
  return <div className="app-shell"><TopBar organization={organization} user={user} connection={connection} active={active} customerEnabled={customerEnabled} readOnly={readOnly} onNavigate={setActive} onSettings={() => setSettings(true)} onLogout={async () => { await services.api.logout(); reset(); setPhase('login'); }}/><main className="workspace">{active === 'customers' ? <CustomerPage api={services.api as ApiClient} organizationId={organization.id} readOnly={readOnly}/> : <><p className="eyebrow">{active.toUpperCase()}</p><h1>{active === 'dashboard' ? '오늘의 매장' : '아직 React 전환 전'}</h1>{active !== 'dashboard' && <p className="muted">이 업무는 안정화 전까지 기존 PySide6 앱에서 이용해 주세요.</p>}</>}</main>{settings && <SettingsDialog platform={services.platform} onClose={() => setSettings(false)}/>}<NoticeHost/></div>;
}
