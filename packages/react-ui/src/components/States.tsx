import type { ReactNode } from 'react';

export function LoadingState({ label = '불러오는 중…' }: { label?: string }) { return <p className="ba-state" role="status">{label}</p>; }
export function EmptyState({ children }: { children: ReactNode }) { return <div className="ba-state ba-state--empty">{children}</div>; }
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="ba-state ba-state--error" role="alert"><span>{message}</span>{onRetry && <button type="button" onClick={onRetry}>다시 시도</button>}</div>;
}
