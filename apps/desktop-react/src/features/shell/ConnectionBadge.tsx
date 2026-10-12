import type { ConnectionState } from '../../platform/types';
export function ConnectionBadge({ state }: { state: ConnectionState }) { const label = state === 'online' ? '연결됨' : state === 'offline' ? '오프라인' : '확인 중'; return <span className={`connection connection--${state}`}><i />{label}</span>; }
