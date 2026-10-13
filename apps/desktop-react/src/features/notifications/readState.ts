const KEY_PREFIX = 'business-assistant.notifications.read.';
const MAX_IDS = 500;

export const readStateKey = (userId: string) => `${KEY_PREFIX}${userId}`;

/** 읽음 처리한 알림 ID 목록(사용자별 localStorage). 저장소를 쓸 수 없거나 깨져 있으면 빈 집합. */
export function loadReadIds(userId: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(readStateKey(userId)) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveReadIds(userId: string, ids: Iterable<string>): void {
  try { localStorage.setItem(readStateKey(userId), JSON.stringify([...ids].slice(-MAX_IDS))); } catch { /* 저장소를 쓸 수 없으면 이번 실행에서만 유지 */ }
}

/** 지금 목록에 없는 ID(지난 알림)를 읽음 목록에서 정리한다. */
export function pruneReadIds(read: Set<string>, currentIds: string[]): Set<string> {
  const current = new Set(currentIds);
  return new Set([...read].filter((id) => current.has(id)));
}
