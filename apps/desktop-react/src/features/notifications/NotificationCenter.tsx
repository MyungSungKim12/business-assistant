import { useEffect, useRef, useState } from 'react';
import type { MenuId } from '../shell/TopBar';
import { KIND_LABELS, type NotificationItem, type NotificationKind } from './notificationModel';
import type { NotificationState } from './useNotifications';
import './notifications.css';

const KIND_ORDER: NotificationKind[] = ['appointment', 'task', 'birthday', 'wallet'];

interface NotificationCenterProps {
  state: NotificationState;
  onNavigate: (id: MenuId) => void;
}

/** 상단바 알림 벨과 패널(UX-03). 항목을 누르면 읽음 처리하고 해당 메뉴로 이동한다. */
export function NotificationCenter({ state, onNavigate }: NotificationCenterProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const { refresh } = state;

  useEffect(() => {
    if (!open) return undefined;
    void refresh();
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) { if (event.key === 'Escape') setOpen(false); return; }
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open, refresh]);

  const choose = (item: NotificationItem) => {
    state.markRead(item.id);
    setOpen(false);
    onNavigate(item.menu);
  };
  const label = state.unreadCount > 0 ? `알림 ${state.unreadCount}건` : '알림';

  return (
    <div className="notify" ref={root}>
      <button type="button" className={`notify__bell${state.hasUrgentUnread ? ' is-urgent' : ''}`} aria-label={label} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M8 1.5a4 4 0 0 0-4 4v2.2L2.6 10.5V12h10.8v-1.5L12 7.7V5.5a4 4 0 0 0-4-4zM6.4 13h3.2a1.6 1.6 0 0 1-3.2 0z" fill="currentColor" /></svg>
        {state.unreadCount > 0 && <span className="notify__badge" aria-hidden="true">{state.unreadCount > 99 ? '99+' : state.unreadCount}</span>}
      </button>
      {open && <NotificationPanel state={state} onChoose={choose} />}
    </div>
  );
}

function NotificationPanel({ state, onChoose }: { state: NotificationState; onChoose: (item: NotificationItem) => void }) {
  const { items } = state;
  return (
    <div className="notify__panel" role="dialog" aria-label="알림 센터">
      <header>
        <strong>알림</strong>
        <button type="button" disabled={state.unreadCount === 0} onClick={state.markAllRead}>모두 읽음</button>
      </header>
      {state.partial && <p className="notify__note" role="status">일부 알림을 불러오지 못했습니다. 잠시 후 다시 열어 주세요.</p>}
      {items.length === 0 && <p className="notify__empty">{state.loading ? '알림을 불러오는 중입니다…' : '새 알림이 없습니다.'}</p>}
      {KIND_ORDER.map((kind) => {
        const group = items.filter((item) => item.kind === kind);
        if (group.length === 0) return null;
        return (
          <section key={kind} aria-label={KIND_LABELS[kind]}>
            <h3>{KIND_LABELS[kind]}</h3>
            <ul>
              {group.map((item) => (
                <li key={item.id}>
                  <button type="button" className={`notify__item${state.isRead(item.id) ? ' is-read' : ''}${item.urgent ? ' is-urgent' : ''}`} onClick={() => onChoose(item)}>
                    <span className="notify__dot" aria-hidden="true" />
                    <span className="notify__text"><strong>{item.title}</strong><small>{item.detail}</small></span>
                    {item.urgent && !state.isRead(item.id) && <em>임박</em>}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
