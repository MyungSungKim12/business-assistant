/**
 * 짧은 수명의 요청 캐시. 같은 키를 동시에 요청하면 한 번만 불러오고, 실패한 결과는 남기지 않는다.
 * 검색 팔레트와 알림 센터가 고객·할 일 같은 목록을 함께 쓰므로 한 번 불러온 것을 잠시 나눠 쓴다.
 */
interface Entry { at: number; promise: Promise<unknown> }

export function createTtlCache(now: () => number = Date.now) {
  const entries = new Map<string, Entry>();
  return {
    /** maxAgeMs 이내에 불러온 값(또는 진행 중인 요청)이 있으면 그것을, 아니면 loader 를 실행한다. */
    get<T>(key: string, loader: () => Promise<T>, maxAgeMs: number): Promise<T> {
      const existing = entries.get(key);
      if (existing && now() - existing.at <= maxAgeMs) return existing.promise as Promise<T>;
      // loader 가 동기적으로 던져도(예: 지원하지 않는 API) 거부된 약속으로 다룬다.
      let promise: Promise<T>;
      try { promise = loader(); } catch (error) { promise = Promise.reject(error instanceof Error ? error : new Error(String(error))); }
      const entry: Entry = { at: now(), promise };
      entries.set(key, entry);
      promise.catch(() => { if (entries.get(key) === entry) entries.delete(key); });
      return promise;
    },
    /** 접두사로 시작하는 항목을 지운다. 인자가 없으면 전부 지운다(로그아웃·매장 전환). */
    clear(prefix = ''): void {
      for (const key of [...entries.keys()]) if (key.startsWith(prefix)) entries.delete(key);
    },
    size: () => entries.size,
  };
}
export type TtlCache = ReturnType<typeof createTtlCache>;

/** 앱 전체가 함께 쓰는 캐시. 로그아웃하거나 매장을 바꾸면 비운다. */
export const workspaceCache: TtlCache = createTtlCache();
