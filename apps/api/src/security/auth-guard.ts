import { createHmac, randomBytes } from 'node:crypto';
import { ApiFailure } from '../errors.js';
import type { AuthLimitSettings } from '../config.js';
import { AttemptLimiter, type LimitRule } from './attempt-limiter.js';

export type AuthGuardOptions = {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  sweepIntervalMs?: number;
  maxKeys?: number;
};

export const INVALID_CREDENTIALS_BODY = { code: 'invalid_credentials', message: '이메일과 비밀번호를 확인해 주세요.', detail: 'Invalid credentials' } as const;

/** 429 응답. Retry-After 헤더(초)와 한국어/영어 안내를 함께 담는다. */
export function tooManyAttempts(retryAfterMs: number): ApiFailure {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return new ApiFailure(429, 'Too many attempts', {
    code: 'too_many_attempts',
    message: `시도 횟수가 너무 많습니다. ${seconds}초 후 다시 시도해 주세요. / Too many attempts. Please try again in ${seconds} seconds.`,
    retry_after_seconds: seconds,
  }, { 'Retry-After': String(seconds) });
}

/**
 * 로그인·회원가입·토큰 갱신 시도 제한(SEC-03).
 *
 * - 로그인: 실패만 센다. 키는 IP, IP+이메일, 이메일(전체 IP 합산). 성공하면 IP+이메일 키만 지운다.
 *   IP 키와 이메일 키는 성공으로 지우지 않으므로, 한 계정으로 성공 로그인을 끼워 넣어도 다른 계정 대입 공격의 카운터가 풀리지 않고
 *   다른 IP 에서의 실패 누적도 풀리지 않는다.
 * - 회원가입·갱신: 결과와 무관하게 시도마다 센다.
 * 이메일은 정규화(소문자·공백 제거) 후 프로세스별 임의 키로 HMAC 해 메모리에 평문으로 두지 않는다.
 */
export function createAuthGuard(settings: AuthLimitSettings, options: AuthGuardOptions = {}) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const limiter = new AttemptLimiter({ now, sweepIntervalMs: options.sweepIntervalMs, maxKeys: options.maxKeys });
  const pepper = randomBytes(32);
  const hash = (value: string) => createHmac('sha256', pepper).update(value.trim().toLowerCase()).digest('hex').slice(0, 32);

  const loginKeys = (ip: string, email: string) => {
    const emailHash = hash(email);
    return [
      { key: `login:ip:${ip}`, rule: settings.login },
      { key: `login:pair:${ip}|${emailHash}`, rule: settings.login },
      { key: `login:email:${emailHash}`, rule: settings.loginEmail },
    ];
  };

  function enforce(checks: Array<{ key: string; rule: LimitRule }>): void {
    if (!settings.enabled) return;
    let wait = 0;
    let blocked = false;
    for (const { key, rule } of checks) {
      const decision = limiter.check(key, rule);
      if (!decision.allowed) { blocked = true; wait = Math.max(wait, decision.retryAfterMs); }
    }
    if (blocked) throw tooManyAttempts(wait);
  }
  function record(checks: Array<{ key: string; rule: LimitRule }>): void {
    if (!settings.enabled) return;
    for (const { key, rule } of checks) limiter.record(key, rule);
  }

  return {
    beforeLogin(ip: string, email: string): void { enforce(loginKeys(ip, email)); },
    loginFailed(ip: string, email: string): void { record(loginKeys(ip, email)); },
    loginSucceeded(ip: string, email: string): void { limiter.reset(`login:pair:${ip}|${hash(email)}`); },
    /** 회원가입은 시도마다 IP 와 이메일 기준으로 센다. */
    attemptSignup(ip: string, email: string): void {
      const checks = [{ key: `signup:ip:${ip}`, rule: settings.signup }, { key: `signup:email:${hash(email)}`, rule: settings.signup }];
      enforce(checks);
      record(checks);
    },
    attemptRefresh(ip: string): void {
      const checks = [{ key: `refresh:ip:${ip}`, rule: settings.refresh }];
      enforce(checks);
      record(checks);
    },
    /** 실패 응답이 최소 failureMinMs 이후에 나가도록 늦춘다(계정 존재 여부를 응답 시간으로 구분하지 못하게). */
    async padFailure(startedAt: number): Promise<void> {
      const remaining = settings.failureMinMs - (now() - startedAt);
      if (remaining > 0) await sleep(remaining);
    },
    now,
    size: () => limiter.size,
    sweep: () => limiter.sweep(),
    close: () => limiter.close(),
  };
}
export type AuthGuard = ReturnType<typeof createAuthGuard>;
