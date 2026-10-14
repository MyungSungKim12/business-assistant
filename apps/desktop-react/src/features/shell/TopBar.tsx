import type { ReactNode } from 'react';
import { confirm } from '@business-assistant/react-ui';
import type { AuthUser, Organization } from '../../api/schemas';
import type { ConnectionState } from '../../platform/types';
import { usePrivacy } from '../../lib/privacy';
import { ConnectionBadge } from './ConnectionBadge';
import { MoreMenu } from './MoreMenu';
import { coreMenus } from './menuCatalog';

export type MenuId = 'dashboard' | 'tasks' | 'customers' | 'appointments' | 'treatments' | 'sales' | 'memberships' | 'inventory' | 'services' | 'staff' | 'finance' | 'documents' | 'files' | 'management' | 'members' | 'audit' | 'admin';

interface TopBarProps {
  organization: Organization;
  user: AuthUser;
  connection: ConnectionState;
  active: MenuId;
  customerEnabled: boolean;
  readOnly: boolean;
  /** 소유자·관리자에게만 보이는 메뉴(경영 미리보기, 구독 관리)를 보여 줄지 */
  canManage: boolean;
  /** 서버가 플랫폼 관리자로 확인한 경우에만 true(구독 메뉴 표시). 확인 전·실패·미설정이면 false. */
  platformAdmin?: boolean;
  /** 전체 검색(Ctrl+K)을 연다. 없으면 검색 버튼을 숨긴다. */
  onSearch?: () => void;
  /** 알림 센터(벨) 자리 */
  notifications?: ReactNode;
  onNavigate: (id: MenuId) => void;
  onSettings: () => void;
  onLogout: () => void;
  /** 데스크톱에서만 전달된다. 웹 미리보기에는 종료 버튼이 없다. */
  onExit?: () => Promise<void>;
}

export function TopBar({ organization, user, connection, active, customerEnabled, readOnly, canManage, platformAdmin = false, onSearch, notifications, onNavigate, onSettings, onLogout, onExit }: TopBarProps) {
  const privacy = usePrivacy();
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
        <MoreMenu active={active} canManage={canManage} platformAdmin={platformAdmin} onNavigate={onNavigate} />
      </nav>
      <div className="topbar__actions">
        {onSearch && <button type="button" className="topbar__search" aria-label="전체 검색 (Ctrl+K)" title="전체 검색 (Ctrl+K)" onClick={onSearch}>검색 <kbd>Ctrl K</kbd></button>}
        {notifications}
        <ConnectionBadge state={connection} />
        <span className="user-name">{user.display_name || privacy.email(user.email)}</span>
        <button aria-label="설정" onClick={onSettings}>설정</button>
        <button onClick={() => void logout()}>로그아웃</button>
        {onExit && <button onClick={() => void exit()}>종료</button>}
      </div>
    </header>
  );
}
