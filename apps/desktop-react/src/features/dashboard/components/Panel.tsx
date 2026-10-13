import type { ReactNode } from 'react';
import type { Source } from '../sourceState';

interface PanelProps<T> {
  /** 격자 배치용 클래스(dash-area-*) */
  area: string;
  title: string;
  state: Source<T>;
  onRetry: () => void;
  /** 데이터가 비었는지. true면 emptyText를 보여 준다. */
  isEmpty: (data: T) => boolean;
  emptyText: string;
  /** 비었을 때 본문 아래에 둘 동작(예: 새 예약 버튼) */
  emptyAction?: ReactNode;
  /** 헤더 오른쪽(건수, 더보기 버튼 등) */
  headerExtra?: (data: T | null) => ReactNode;
  children: (data: T) => ReactNode;
}

/**
 * 대시보드 패널 틀. 로딩·실패·빈 상태에서도 같은 크기의 틀을 유지하고,
 * 실패는 권한 없음/미사용 기능/일반 오류로 나누어 보여 준다.
 */
export function Panel<T>({ area, title, state, onRetry, isEmpty, emptyText, emptyAction, headerExtra, children }: PanelProps<T>) {
  const data = state.status === 'ready' ? state.data : null;
  return (
    <section className={`dash-panel ${area}`} aria-label={title}>
      <header className="dash-panel__head">
        <h2>{title}</h2>
        <div className="dash-panel__extra">{headerExtra?.(data)}</div>
      </header>
      <div className="dash-panel__body">
        {state.status === 'loading' && <p className="dash-state" role="status">불러오는 중…</p>}
        {state.status === 'error' && (
          <div className={`dash-state dash-state--${state.failure.kind}`} role="alert">
            <strong>{state.failure.kind === 'forbidden' ? '권한 없음' : state.failure.kind === 'unavailable' ? '미사용 기능' : '불러오기 실패'}</strong>
            <span>{state.failure.message}</span>
            <button type="button" className="ba-mini" onClick={onRetry}>다시 시도</button>
          </div>
        )}
        {state.status === 'ready' && (isEmpty(state.data)
          ? <div className="dash-state"><span>{emptyText}</span>{emptyAction}</div>
          : children(state.data))}
      </div>
    </section>
  );
}
