import { confirm } from '@business-assistant/react-ui';
import type { AuthUser, Organization } from '../../api/schemas';
import type { ConnectionState } from '../../platform/types';
import { ConnectionBadge } from './ConnectionBadge';
import { MoreMenu } from './MoreMenu';
import { coreMenus } from './menuCatalog';

export type MenuId = 'dashboard' | 'tasks' | 'customers' | 'appointments' | 'treatments' | 'sales' | 'memberships' | 'inventory' | 'services' | 'staff' | 'finance' | 'documents' | 'files' | 'management' | 'admin';

interface TopBarProps {
  organization: Organization;
  user: AuthUser;
  connection: ConnectionState;
  active: MenuId;
  customerEnabled: boolean;
  readOnly: boolean;
  /** 소유자·관리자에게만 보이는 메뉴(경영 미리보기, 구독 관리)를 보여 줄지 */
  canManage: boolean;
  onNavigate: (id: MenuId) => void;
  onSettings: () => void;
  onLogout: () => void;
  /** 데스크톱에서만 전달된다. 웹 미리보기에는 종료 버튼이 없다. */
  onExit?: () => Promise<void>;
}

export function TopBar({ organization, user, connection, active, customerEnabled, readOnly, canManage, onNavigate, onSettings, onLogout, onExit }: TopBarProps) {
  const item = ([id, label]: [MenuId, string]) =>
    id !== 'customers' || customerEnabled
      ? <button key={id} className={active === id ? 'active' : ''} aria-current={active === id ? 'page' : undefined} onClick={() => onNavigate(id)}>{label}</button>
      : null;
  const logout = async () => {
    if (await confirm({ title: '로그아웃', message: '로그아웃하시겠습니까?', confirmLabel: '로그아웃' })) onLogout();
  };
  const exit = async () => {
    if (await confirm({ title: '종료', message: 'Business Assistant를 종료하시겠습니까?', confirmLabel: '종료', tone: 'danger' })) await onExit?.();
  };

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <span className="brand-mark brand-mark--small">BA</span>
        <strong>{organization.name}</strong>
        {readOnly && <em>읽기 전용</em>}
      </div>
      <nav aria-label="주 메뉴">
        {coreMenus.map(item)}
        <MoreMenu active={active} canManage={canManage} onNavigate={onNavigate} />
      </nav>
      <div className="topbar__actions">
        <ConnectionBadge state={connection} />
        <span className="user-name">{user.display_name || user.email}</span>
        <button aria-label="설정" onClick={onSettings}>설정</button>
        <button onClick={() => void logout()}>로그아웃</button>
        {onExit && <button onClick={() => void exit()}>종료</button>}
      </div>
    </header>
  );
}
