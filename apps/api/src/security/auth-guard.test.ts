import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../app.js';
import { authLimitSettings } from '../config.js';
import { ApiFailure } from '../errors.js';
import type { AuthGateway } from '../routes/auth.js';
import { AttemptLimiter } from './attempt-limiter.js';
import { createAuthGuard } from './auth-guard.js';

const USER = 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const session = { accessToken: 'access', refreshToken: 'refresh', user: { userId: USER, email: 'owner@example.com', displayName: '원장' } };

function clock(start = 1_000_000) {
  let value = start;
  return { now: () => value, advance: (milliseconds: number) => { value += milliseconds; } };
}

describe('AttemptLimiter', () => {
  const rule = { limit: 3, windowMs: 1000 };

  it('윈도우 안에서 limit 번째 시도 뒤부터 막고 Retry-After 를 계산한다', () => {
    const time = clock();
    const limiter = new AttemptLimiter({ now: time.now, sweepIntervalMs: 0 });
    for (let index = 0; index < 3; index += 1) { expect(limiter.check('k', rule).allowed).toBe(true); limiter.record('k', rule); time.advance(100); }
    const blocked = limiter.check('k', rule);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(700);
    time.advance(700);
    expect(limiter.check('k', rule).allowed).toBe(true);
  });

  it('reset 은 해당 키만 지운다', () => {
    const limiter = new AttemptLimiter({ now: clock().now, sweepIntervalMs: 0 });
    for (let index = 0; index < 3; index += 1) { limiter.record('a', rule); limiter.record('b', rule); }
    limiter.reset('a');
    expect(limiter.check('a', rule).allowed).toBe(true);
    expect(limiter.check('b', rule).allowed).toBe(false);
  });

  it('sweep 은 만료된 키를 지워 메모리가 커지지 않게 한다', () => {
    const time = clock();
    const limiter = new AttemptLimiter({ now: time.now, sweepIntervalMs: 0 });
    for (let index = 0; index < 100; index += 1) limiter.record(`k${index}`, rule);
    expect(limiter.size).toBe(100);
    time.advance(1001);
    limiter.sweep();
    expect(limiter.size).toBe(0);
  });

  it('키 수가 maxKeys 를 넘으면 오래된 키부터 버린다', () => {
    const limiter = new AttemptLimiter({ now: clock().now, sweepIntervalMs: 0, maxKeys: 5 });
    for (let index = 0; index < 20; index += 1) limiter.record(`k${index}`, rule);
    expect(limiter.size).toBe(5);
    expect(limiter.check('k19', { limit: 1, windowMs: 1000 }).allowed).toBe(false);
  });

  it('기록은 limit 개까지만 보관한다', () => {
    const limiter = new AttemptLimiter({ now: clock().now, sweepIntervalMs: 0 });
    for (let index = 0; index < 1000; index += 1) limiter.record('k', rule);
    expect((limiter as unknown as { entries: Map<string, { hits: number[] }> }).entries.get('k')!.hits.length).toBe(3);
  });
});

describe('AuthGuard', () => {
  const settings = { ...authLimitSettings(), failureMinMs: 0 };

  it('로그인 실패가 IP+이메일 한도에 닿으면 429 이고 성공하면 그 키만 풀린다', () => {
    const time = clock();
    const guard = createAuthGuard({ ...settings, login: { limit: 2, windowMs: 60_000 } }, { now: time.now, sweepIntervalMs: 0 });
    guard.loginFailed('1.1.1.1', 'A@Example.com');
    guard.loginFailed('1.1.1.1', ' a@example.com ');
    expect(() => guard.beforeLogin('1.1.1.1', 'a@example.com')).toThrow(ApiFailure);
    // 다른 IP 에서 같은 이메일은 이메일 단위 한도(30)에 닿기 전까지 허용된다.
    expect(() => guard.beforeLogin('2.2.2.2', 'a@example.com')).not.toThrow();
    guard.loginSucceeded('1.1.1.1', 'a@example.com');
    // 성공해도 IP 키는 유지되므로 같은 IP 는 여전히 막혀 있다.
    expect(() => guard.beforeLogin('1.1.1.1', 'other@example.com')).toThrow(ApiFailure);
    guard.close();
  });

  it('성공이 이메일 단위 실패 누적이나 다른 IP 의 잠금을 풀지 않는다', () => {
    const guard = createAuthGuard({ ...settings, login: { limit: 100, windowMs: 60_000 }, loginEmail: { limit: 3, windowMs: 60_000 } }, { now: clock().now, sweepIntervalMs: 0 });
    guard.loginFailed('1.1.1.1', 'v@example.com');
    guard.loginFailed('2.2.2.2', 'v@example.com');
    guard.loginFailed('3.3.3.3', 'v@example.com');
    guard.loginSucceeded('4.4.4.4', 'v@example.com');
    expect(() => guard.beforeLogin('5.5.5.5', 'v@example.com')).toThrow(ApiFailure);
    guard.close();
  });

  it('429 는 Retry-After(초)와 한국어/영어 메시지를 담는다', () => {
    const guard = createAuthGuard({ ...settings, login: { limit: 1, windowMs: 90_000 } }, { now: clock().now, sweepIntervalMs: 0 });
    guard.loginFailed('1.1.1.1', 'a@example.com');
    try { guard.beforeLogin('1.1.1.1', 'a@example.com'); throw new Error('expected'); } catch (error) {
      const failure = error as ApiFailure;
      expect(failure.status).toBe(429);
      expect(failure.headers['Retry-After']).toBe('90');
      expect(failure.extra.message).toContain('90초');
      expect(failure.extra.message).toContain('Too many attempts');
    }
    guard.close();
  });

  it('회원가입은 시도마다 IP 와 이메일 기준으로 센다', () => {
    const guard = createAuthGuard({ ...settings, signup: { limit: 2, windowMs: 3_600_000 } }, { now: clock().now, sweepIntervalMs: 0 });
    guard.attemptSignup('1.1.1.1', 'a@example.com');
    guard.attemptSignup('1.1.1.1', 'b@example.com');
    expect(() => guard.attemptSignup('1.1.1.1', 'c@example.com')).toThrow(ApiFailure);
    guard.attemptSignup('2.2.2.2', 'x@example.com');
    guard.attemptSignup('3.3.3.3', 'x@example.com');
    expect(() => guard.attemptSignup('4.4.4.4', 'x@example.com')).toThrow(ApiFailure);
    guard.close();
  });

  it('비활성화하면 아무것도 막지 않는다', () => {
    const guard = createAuthGuard({ ...settings, enabled: false, login: { limit: 1, windowMs: 1000 } }, { now: clock().now, sweepIntervalMs: 0 });
    for (let index = 0; index < 5; index += 1) { guard.loginFailed('1.1.1.1', 'a@example.com'); guard.beforeLogin('1.1.1.1', 'a@example.com'); }
    expect(guard.size()).toBe(0);
    guard.close();
  });

  it('실패 응답은 최소 지연까지 기다린다', async () => {
    const time = clock();
    const sleep = vi.fn(async (milliseconds: number) => { time.advance(milliseconds); });
    const guard = createAuthGuard({ ...settings, failureMinMs: 250 }, { now: time.now, sleep, sweepIntervalMs: 0 });
    const started = time.now();
    time.advance(40);
    await guard.padFailure(started);
    expect(sleep).toHaveBeenCalledWith(210);
    await guard.padFailure(started);
    expect(sleep).toHaveBeenCalledTimes(1);
    guard.close();
  });
});

describe('인증 라우트 시도 제한', () => {
  let app: FastifyInstance;
  afterEach(async () => { await app?.close(); });
  const login = (payload: unknown, ip = '10.0.0.1') => app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: payload as object, remoteAddress: ip });

  function build(auth: Partial<AuthGateway>, overrides: Partial<ReturnType<typeof authLimitSettings>> = {}) {
    const time = clock();
    const guard = createAuthGuard({ ...authLimitSettings(), failureMinMs: 0, ...overrides }, { now: time.now, sweepIntervalMs: 0 });
    app = createApp({ auth: { signIn: vi.fn(), ...auth } as AuthGateway, authGuard: guard });
    return time;
  }

  it('로그인 실패가 반복되면 429 와 Retry-After 를 돌려주고 시간이 지나면 풀린다', async () => {
    const time = build({ signIn: async () => { throw new ApiFailure(401, 'Invalid credentials'); } }, { login: { limit: 3, windowMs: 600_000 } });
    for (let index = 0; index < 3; index += 1) expect((await login({ email: 'a@example.com', password: 'x' })).statusCode).toBe(401);
    const blocked = await login({ email: 'a@example.com', password: 'x' });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('600');
    expect(blocked.json()).toMatchObject({ code: 'too_many_attempts', retry_after_seconds: 600 });
    time.advance(600_001);
    expect((await login({ email: 'a@example.com', password: 'x' })).statusCode).toBe(401);
  });

  it('존재하지 않는 이메일과 틀린 비밀번호는 같은 응답이다', async () => {
    build({ signIn: async (email) => { if (email === 'known@example.com') throw new ApiFailure(401, 'Invalid credentials'); throw new Error('no such user'); } });
    const wrongPassword = await login({ email: 'known@example.com', password: 'bad' });
    const unknownEmail = await login({ email: 'unknown@example.com', password: 'bad' });
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    const strip = (body: Record<string, unknown>) => ({ ...body, requestId: undefined });
    expect(strip(unknownEmail.json())).toEqual(strip(wrongPassword.json()));
    expect(wrongPassword.json()).toMatchObject({ code: 'invalid_credentials', message: '이메일과 비밀번호를 확인해 주세요.' });
  });

  it('인증 서비스 장애(503)는 실패 횟수에 세지 않는다', async () => {
    build({ signIn: async () => { throw new ApiFailure(503, 'Authentication unavailable'); } }, { login: { limit: 2, windowMs: 600_000 } });
    for (let index = 0; index < 5; index += 1) expect((await login({ email: 'a@example.com', password: 'x' })).statusCode).toBe(503);
  });

  it('성공 로그인은 정상 응답이고 같은 IP 의 다른 계정 실패 누적을 지우지 않는다', async () => {
    build({ signIn: async (email) => { if (email === 'owner@example.com') return session; throw new ApiFailure(401, 'Invalid credentials'); } }, { login: { limit: 2, windowMs: 600_000 } });
    expect((await login({ email: 'victim@example.com', password: 'x' })).statusCode).toBe(401);
    expect((await login({ email: 'owner@example.com', password: 'ok' })).statusCode).toBe(200);
    expect((await login({ email: 'victim@example.com', password: 'y' })).statusCode).toBe(401);
    expect((await login({ email: 'victim@example.com', password: 'z' })).statusCode).toBe(429);
  });

  it('회원가입과 갱신도 제한한다', async () => {
    build({ signUp: async () => null, refresh: async () => session }, { signup: { limit: 1, windowMs: 3_600_000 }, refresh: { limit: 2, windowMs: 600_000 } });
    const signup = (email: string) => app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { email, password: 'long-enough-password', display_name: '신규' }, remoteAddress: '10.0.0.9' });
    expect((await signup('a@example.com')).statusCode).toBe(200);
    const blocked = await signup('b@example.com');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('3600');
    const refresh = () => app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refresh_token: 'r' }, remoteAddress: '10.0.0.8' });
    expect((await refresh()).statusCode).toBe(200);
    expect((await refresh()).statusCode).toBe(200);
    expect((await refresh()).statusCode).toBe(429);
  });

  it('프록시를 신뢰하지 않으면 X-Forwarded-For 로 제한을 우회할 수 없다', async () => {
    build({ signIn: async () => { throw new ApiFailure(401, 'Invalid credentials'); } }, { login: { limit: 1, windowMs: 600_000 }, loginEmail: { limit: 1000, windowMs: 600_000 } });
    const attempt = (forwarded: string) => app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'a@example.com', password: 'x' }, remoteAddress: '10.0.0.1', headers: { 'x-forwarded-for': forwarded } });
    expect((await attempt('9.9.9.1')).statusCode).toBe(401);
    expect((await attempt('9.9.9.2')).statusCode).toBe(429);
  });

  it('APP_TRUST_PROXY 가 켜지면 X-Forwarded-For 의 클라이언트 IP 로 구분한다', async () => {
    const guard = createAuthGuard({ ...authLimitSettings(), failureMinMs: 0, login: { limit: 1, windowMs: 600_000 }, loginEmail: { limit: 1000, windowMs: 600_000 } }, { sweepIntervalMs: 0 });
    app = createApp({ auth: { signIn: async () => { throw new ApiFailure(401, 'Invalid credentials'); } }, authGuard: guard, config: { APP_SUPABASE_URL: 'https://example.supabase.co', APP_SUPABASE_PUBLISHABLE_KEY: 'k', APP_FILE_BUCKET: 'b', APP_API_PORT: 8000, APP_TRUST_PROXY: true } });
    const attempt = (forwarded: string) => app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'a@example.com', password: 'x' }, remoteAddress: '10.0.0.1', headers: { 'x-forwarded-for': forwarded } });
    expect((await attempt('9.9.9.1')).statusCode).toBe(401);
    expect((await attempt('9.9.9.2')).statusCode).toBe(401);
    expect((await attempt('9.9.9.2')).statusCode).toBe(429);
  });
});
