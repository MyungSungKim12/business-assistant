import type { MenuId } from '../../shell/TopBar';

interface Action { menu: MenuId; label: string; write: boolean; manageOnly?: boolean }

const actions: Action[] = [
  { menu: 'appointments', label: '새 예약', write: false },
  { menu: 'customers', label: '새 고객', write: true },
  { menu: 'tasks', label: '새 할 일', write: false },
  { menu: 'sales', label: '새 방문(매출)', write: true },
  { menu: 'treatments', label: '시술 기록', write: true },
  { menu: 'management', label: '경영 보기', write: false, manageOnly: true },
];

/** 빠른 실행 버튼 줄. 쓰기 메뉴는 읽기 전용(구성원)에게 숨기고, 경영은 관리 권한자에게만 보인다. */
export function QuickActions({ readOnly, canManage, onNavigate }: { readOnly: boolean; canManage: boolean; onNavigate: (menu: MenuId) => void }) {
  return (
    <nav className="dash-actions" aria-label="빠른 실행">
      {actions
        .filter((action) => !(action.write && readOnly) && !(action.manageOnly && !canManage))
        .map((action) => (
          <button key={action.menu} type="button" className={action.menu === 'appointments' ? 'primary-button' : undefined} onClick={() => onNavigate(action.menu)}>
            {action.label}
          </button>
        ))}
    </nav>
  );
}
