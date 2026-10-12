import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';

export interface ModalProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
  size?: 'sm' | 'md' | 'lg';
  closeOnBackdrop?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

const focusable = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function Modal({ title, children, onClose, size = 'md', closeOnBackdrop = false, initialFocusRef }: ModalProps) {
  const labelId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    (initialFocusRef?.current ?? panel?.querySelector<HTMLElement>(focusable))?.focus();

    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const nodes = [...panel.querySelectorAll<HTMLElement>(focusable)];
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      previousFocus.current?.focus();
    };
  }, [initialFocusRef, onClose]);

  return (
    <div
      className="ba-modal-backdrop"
      data-testid="modal-backdrop"
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={panelRef} className={`ba-modal ba-modal--${size}`} role="dialog" aria-modal="true" aria-labelledby={labelId}>
        <header className="ba-modal__header">
          <h2 id={labelId}>{title}</h2>
          <button type="button" aria-label="닫기" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="ba-modal__body">{children}</div>
      </div>
    </div>
  );
}
