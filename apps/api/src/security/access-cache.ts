import { createHmac, randomBytes } from 'node:crypto';

export type AccessCacheOptions = {
  /** 유지 시간(초). 0 이하이면 캐시를 쓰지 않는다. */
  ttlSec: number;
  now?: () => number;
  /** 보관할 최대 항목 수. 넘으면 만료분을 먼저 지우고, 그래도 넘으면 가장 오래된 것부터 지운다. */
  maxEntries?: number;
};

export type AccessKey = { token: string; organizationId: string; feature: string; write: boolean };
type Entry = { role: string; expiresAt: number; organizationId: string };

export const DEFAULT_ACCESS_CACHE_TTL_SEC = 30;

/** 환경 값(APP_ACCESS_CACHE_TTL_SEC)을 초 단위로 읽는다. 비었거나 잘못된 값은 기본 30초, 0 은 끔. */
export function parseAccessCacheTtl(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_ACCESS_CACHE_TTL_SEC;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_ACCESS_CACHE_TTL_SEC;
  return Math.min(Math.floor(value), 3600);
}

/**
 * 조직 권한 검사(멤버십 + 구독 기능) 결과의 짧은 메모리 캐시(SEC-06).
 *
 * - 키: 토큰 HMAC(프로세스별 임의 키, 원문 토큰은 저장하지 않음) + 조직 + 기능 + 쓰기 여부.
 *   사용자·조직·기능·쓰기 여부가 하나라도 다르면 항목이 분리되어 서로 오염되지 않는다.
 * - 성공(허용)한 결과만 저장한다. 거부·오류는 저장하지 않는다.
 * - 구성원 역할 변경·제거 시 invalidateOrganization 으로 해당 조직 항목을 모두 지운다.
 */
export function createAccessCache(options: AccessCacheOptions) {
  const now = options.now ?? Date.now;
  const ttlMs = Math.max(0, options.ttlSec) * 1000;
  const maxEntries = options.maxEntries ?? 2000;
  const pepper = randomBytes(32);
  const entries = new Map<string, Entry>();

  const keyOf = (key: AccessKey) => {
    const tokenHash = createHmac('sha256', pepper).update(key.token).digest('hex');
    return `${tokenHash}|${key.organizationId}|${key.feature}|${key.write ? 'w' : 'r'}`;
  };

  function sweep(): void {
    const current = now();
    for (const [name, entry] of entries) if (entry.expiresAt <= current) entries.delete(name);
  }
  function makeRoom(): void {
    if (entries.size < maxEntries) return;
    sweep();
    // Map 은 삽입 순서를 유지하므로 앞쪽이 가장 오래된 항목이다.
    while (entries.size >= maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  return {
    enabled: ttlMs > 0,
    get(key: AccessKey): string | undefined {
      if (ttlMs <= 0) return undefined;
      const name = keyOf(key);
      const entry = entries.get(name);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) { entries.delete(name); return undefined; }
      return entry.role;
    },
    set(key: AccessKey, role: string): void {
      if (ttlMs <= 0) return;
      const name = keyOf(key);
      entries.delete(name);
      makeRoom();
      entries.set(name, { role, expiresAt: now() + ttlMs, organizationId: key.organizationId });
    },
    /** 조직의 멤버십이 바뀌었을 때(역할 변경·제거·추가) 그 조직의 모든 항목을 지운다. */
    invalidateOrganization(organizationId: string): void {
      for (const [name, entry] of entries) if (entry.organizationId === organizationId) entries.delete(name);
    },
    clear(): void { entries.clear(); },
    sweep,
    size: () => entries.size,
  };
}
export type AccessCache = ReturnType<typeof createAccessCache>;
