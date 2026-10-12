import type { AuthUser, Organization } from '../../api/schemas';
import type { ConnectionState } from '../../platform/types';
import { ConnectionBadge } from './ConnectionBadge';

export type MenuId = 'dashboard'|'customers'|'appointments'|'treatments'|'sales'|'memberships'|'inventory'|'staff'|'finance'|'documents'|'files';
const core: Array<[MenuId,string]> = [['dashboard','홈'],['customers','고객관리'],['appointments','예약'],['treatments','시술'],['sales','매출']];
const more: Array<[MenuId,string]> = [['memberships','회원권'],['inventory','재고'],['staff','직원'],['finance','정산'],['documents','문서'],['files','파일']];
export function TopBar({ organization, user, connection, active, customerEnabled, readOnly, onNavigate, onSettings, onLogout }: { organization: Organization; user: AuthUser; connection: ConnectionState; active: MenuId; customerEnabled: boolean; readOnly: boolean; onNavigate: (id: MenuId) => void; onSettings: () => void; onLogout: () => void }) {
  const render = ([id,label]: [MenuId,string]) => id !== 'customers' || customerEnabled ? <button key={id} className={active === id ? 'active' : ''} onClick={() => onNavigate(id)}>{label}</button> : null;
  return <header className="topbar"><div className="topbar__brand"><span className="brand-mark brand-mark--small">BA</span><strong>{organization.name}</strong>{readOnly && <em>읽기 전용</em>}</div><nav aria-label="주 메뉴">{core.map(render)}<details><summary>더보기</summary><div className="more-menu">{more.map(render)}</div></details></nav><div className="topbar__actions"><ConnectionBadge state={connection}/><span className="user-name">{user.display_name || user.email}</span><button aria-label="설정" onClick={onSettings}>설정</button><button onClick={onLogout}>로그아웃</button></div></header>;
}
