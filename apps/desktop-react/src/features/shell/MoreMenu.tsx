import { useEffect, useRef, useState } from 'react';
import type { MenuId } from './TopBar';
import { moreMenuIds, visibleGroups } from './menuCatalog';

interface MoreMenuProps {
  active: MenuId;
  canManage: boolean;
  onNavigate: (id: MenuId) => void;
}

/** 더보기: 나머지 모든 메뉴를 분류별로 한눈에 보여 주는 전체 메뉴 패널. */
export function MoreMenu({ active, canManage, onNavigate }: MoreMenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const groups = visibleGroups(canManage);
  const activeInside = moreMenuIds(canManage).includes(active);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) { if (event.key === 'Escape') setOpen(false); return; }
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);

  return (
    <div className="more" ref={root}>
      <button type="button" className={`more__toggle${activeInside ? ' active' : ''}${open ? ' is-open' : ''}`} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        더보기
      </button>
      {open && (
        <div className="more__panel" role="menu" aria-label="전체 메뉴">
          {groups.map((group) => (
            <section key={group.title} className="more__group" aria-label={group.title}>
              <h2>{group.title}</h2>
              <ul>
                {group.entries.map((entry) => (
                  <li key={entry.id}>
                    <button type="button" role="menuitem" className={`more__item${active === entry.id ? ' active' : ''}`} aria-current={active === entry.id ? 'page' : undefined} onClick={() => { setOpen(false); onNavigate(entry.id); }}>
                      <span className="more__mark" aria-hidden="true">{entry.mark}</span>
                      <span className="more__text"><strong>{entry.label}</strong><small>{entry.description}</small></span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
