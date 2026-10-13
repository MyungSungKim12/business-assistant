import { useEffect } from 'react';

/** Ctrl+K(맥은 Cmd+K)로 검색 팔레트를 연다. 입력 중에도 동작하며 브라우저 기본 동작은 막는다. */
export function useSearchShortcut(open: () => void, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        open();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, open]);
}
