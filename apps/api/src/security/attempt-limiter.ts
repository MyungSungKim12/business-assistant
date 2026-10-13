/**
 * 메모리 기반 슬라이딩 윈도우 시도 제한기. 시간은 now() 로 주입할 수 있다.
 * 한계: 프로세스 메모리에만 있으므로 인스턴스를 여러 개 띄우거나 재시작하면 카운터가 공유·유지되지 않는다.
 */
export type LimitRule = { limit: number; windowMs: number };
export type LimitDecision = { allowed: boolean; retryAfterMs: number };

type Entry = { hits: number[]; windowMs: number };

export type AttemptLimiterOptions = {
  now?: () => number;
  /** 저장할 키의 최대 개수. 넘으면 청소 후 가장 오래된 키부터 버린다. */
  maxKeys?: number;
  /** 주기적 청소 간격(ms). 0 이면 타이머를 만들지 않는다(테스트). */
  sweepIntervalMs?: number;
};

export class AttemptLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly maxKeys: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: AttemptLimiterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxKeys = options.maxKeys ?? 50_000;
    const interval = options.sweepIntervalMs ?? 60_000;
    if (interval > 0) {
      this.timer = setInterval(() => this.sweep(), interval);
      this.timer.unref();
    }
  }

  /** 시도를 기록하지 않고 지금 허용되는지만 본다. */
  check(key: string, rule: LimitRule): LimitDecision {
    const entry = this.entries.get(key);
    if (!entry) return { allowed: true, retryAfterMs: 0 };
    const hits = this.live(entry.hits, rule.windowMs);
    if (hits.length < rule.limit) return { allowed: true, retryAfterMs: 0 };
    // limit 번째로 최근인 기록이 윈도우 밖으로 나가면 한 자리가 비워진다.
    const blocking = hits[hits.length - rule.limit];
    return { allowed: false, retryAfterMs: Math.max(1, blocking + rule.windowMs - this.now()) };
  }

  /** 시도를 기록한다. 기록은 limit 개까지만 유지해 메모리가 커지지 않는다. */
  record(key: string, rule: LimitRule): void {
    const entry = this.entries.get(key) ?? { hits: [], windowMs: rule.windowMs };
    entry.windowMs = Math.max(entry.windowMs, rule.windowMs);
    entry.hits = this.live(entry.hits, rule.windowMs);
    entry.hits.push(this.now());
    if (entry.hits.length > rule.limit) entry.hits.splice(0, entry.hits.length - rule.limit);
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (this.entries.size > this.maxKeys) this.shrink();
  }

  reset(key: string): void { this.entries.delete(key); }

  get size(): number { return this.entries.size; }

  /** 윈도우가 지난 기록과 빈 키를 지운다. */
  sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      const newest = entry.hits[entry.hits.length - 1];
      if (newest === undefined || newest + entry.windowMs <= now) this.entries.delete(key);
    }
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.entries.clear();
  }

  private live(hits: number[], windowMs: number): number[] {
    const cutoff = this.now() - windowMs;
    return hits.filter((time) => time > cutoff);
  }

  private shrink(): void {
    this.sweep();
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.maxKeys) break;
      this.entries.delete(key);
    }
  }
}
