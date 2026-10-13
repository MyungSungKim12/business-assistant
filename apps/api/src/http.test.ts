import { afterEach, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { createApp } from './app.js';
import { ApiFailure } from './errors.js';
import { createFastifyApp, REDACT_PATHS, redactUrl } from './http.js';
import { registerReadiness } from './health.js';
import { testConfig } from './modules/catalog/testkit.js';

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

describe('redactUrl', () => {
  it('민감해 보이는 쿼리 값만 가리고 경로와 나머지는 유지한다', () => {
    expect(redactUrl('/api/v1/x?from_date=2026-10-01&access_token=abc&Signature=zzz&apikey=k')).toBe(
      '/api/v1/x?from_date=2026-10-01&access_token=%5BREDACTED%5D&Signature=%5BREDACTED%5D&apikey=%5BREDACTED%5D',
    );
    expect(redactUrl('/api/v1/health')).toBe('/api/v1/health');
    expect(redactUrl('/a?')).toBe('/a');
  });
});

describe('보안 응답 헤더', () => {
  it('인증이 필요한 응답은 no-store, 상태 확인은 캐시 헤더를 붙이지 않는다', async () => {
    app = createApp();
    const health = await app.inject({ url: '/api/v1/health' });
    expect(health.json()).toEqual({ status: 'ok' });
    expect(health.headers['x-content-type-options']).toBe('nosniff');
    expect(health.headers['referrer-policy']).toBe('no-referrer');
    expect(health.headers['x-frame-options']).toBe('DENY');
    expect(health.headers['cache-control']).toBeUndefined();
    const protectedRoute = await app.inject({ url: '/api/v1/organizations' });
    expect(protectedRoute.statusCode).toBe(401);
    expect(protectedRoute.headers['cache-control']).toBe('no-store');
    expect(protectedRoute.headers['www-authenticate']).toBe('Bearer');
    expect(protectedRoute.headers['strict-transport-security']).toBeUndefined();
  });

  it('HTTPS 로 들어온 요청(신뢰한 프록시 경유)에만 HSTS 를 붙인다', async () => {
    app = createApp({ config: { ...testConfig, APP_TRUST_PROXY: true } });
    const response = await app.inject({ url: '/api/v1/health', headers: { 'x-forwarded-proto': 'https' } });
    expect(response.headers['strict-transport-security']).toContain('max-age=');
    const plain = await app.inject({ url: '/api/v1/health' });
    expect(plain.headers['strict-transport-security']).toBeUndefined();
  });
});

describe('요청 본문 크기 제한', () => {
  it('APP_BODY_LIMIT_BYTES 를 넘으면 413 이고 원문 오류를 노출하지 않는다', async () => {
    app = createFastifyApp({ APP_BODY_LIMIT_BYTES: 100 });
    app.post('/echo', async () => ({ ok: true }));
    const response = await app.inject({ method: 'POST', url: '/echo', payload: { text: 'x'.repeat(500) } });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ detail: 'Payload too large' });
    expect((await app.inject({ method: 'POST', url: '/echo', payload: { text: 'ok' } })).statusCode).toBe(200);
  });

  it('깨진 JSON 은 400 이다', async () => {
    app = createFastifyApp();
    app.post('/echo', async () => ({ ok: true }));
    const response = await app.inject({ method: 'POST', url: '/echo', headers: { 'content-type': 'application/json' }, payload: '{bad' });
    expect(response.statusCode).toBe(400);
  });

  it('ApiFailure 의 헤더를 응답에 싣는다', async () => {
    app = createFastifyApp();
    app.get('/limited', async () => { throw new ApiFailure(429, 'Too many attempts', {}, { 'Retry-After': '7' }); });
    const response = await app.inject({ url: '/limited' });
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('7');
  });
});

describe('로그 redact', () => {
  it('Authorization·쿠키·비밀번호·토큰 필드와 URL 의 토큰은 로그에 남지 않는다', async () => {
    const lines: string[] = [];
    const stream = new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done(); } });
    const fastify = Fastify({
      logger: { level: 'info', stream, redact: { paths: REDACT_PATHS, censor: '[REDACTED]' }, serializers: { req: (request) => (typeof request.url === 'string' ? { method: request.method, url: redactUrl(request.url) } : (request as unknown as Record<string, unknown>)) } },
    });
    fastify.get('/probe', async (request) => {
      request.log.info({ password: 'pw-secret', refresh_token: 'rt-secret', user: { token: 'tk-secret' }, req: { headers: { authorization: 'Bearer hdr-secret', cookie: 'sid=cookie-secret' } } }, 'probe');
      return { ok: true };
    });
    await fastify.inject({ url: '/probe?access_token=url-secret&page=1', headers: { authorization: 'Bearer hdr-secret' } });
    await fastify.close();
    const output = lines.join('');
    for (const secret of ['pw-secret', 'rt-secret', 'tk-secret', 'hdr-secret', 'cookie-secret', 'url-secret']) expect(output, secret).not.toContain(secret);
    expect(output).toContain('[REDACTED]');
    expect(output).toContain('page=1');
  });
});

describe('준비 상태 점검(ready)', () => {
  const build = (fetcher: typeof fetch) => {
    app = Fastify();
    registerReadiness(app, testConfig, fetcher);
    return app;
  };

  it('Supabase 에 닿으면 200, 아니면 503 이며 주소·오류 원문은 노출하지 않는다', async () => {
    let calls = 0;
    build((async () => { calls += 1; return new Response('{}', { status: 200 }); }) as typeof fetch);
    const ok = await app.inject({ url: '/api/v1/health/ready' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ status: 'ok', checks: { supabase: 'ok' } });
    await app.inject({ url: '/api/v1/health/ready' });
    expect(calls).toBe(1);
    await app.close();

    build((async () => { throw new Error('connect ECONNREFUSED https://example.supabase.co key=public-key'); }) as typeof fetch);
    const down = await app.inject({ url: '/api/v1/health/ready' });
    expect(down.statusCode).toBe(503);
    expect(down.body).not.toContain('supabase.co');
    expect(down.body).not.toContain('public-key');
    expect(down.json()).toEqual({ status: 'unavailable', checks: { supabase: 'unavailable' } });
  });

  it('설정이 있는 createApp 에 등록되어 있고 인증 없이 호출할 수 있다', async () => {
    app = createApp({ config: testConfig, fetcher: (async () => new Response('{}', { status: 200 })) as typeof fetch });
    expect((await app.inject({ url: '/api/v1/health/ready' })).statusCode).toBe(200);
  });
});
