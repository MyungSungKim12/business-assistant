import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from './config.js';

const CACHE_MS = 5_000;

/**
 * `GET /api/v1/health` 는 프로세스가 살아 있는지만 답한다(app.ts). 이 `GET /api/v1/health/ready` 는 Supabase Auth 에 닿는지까지 보고,
 * 주소·키·오류 원문은 응답에 싣지 않는다. 남용으로 외부 호출이 늘지 않도록 결과를 5초 캐시한다.
 */
export function registerReadiness(app: FastifyInstance, config: ServerConfig, fetcher: typeof fetch = fetch, now: () => number = Date.now): void {
  let cached: { at: number; ok: boolean } | undefined;
  async function probe(): Promise<boolean> {
    try {
      const response = await fetcher(new URL('/auth/v1/health', config.APP_SUPABASE_URL), {
        headers: { apikey: config.APP_SUPABASE_PUBLISHABLE_KEY }, signal: AbortSignal.timeout(3_000), redirect: 'error',
      });
      return response.ok;
    } catch { return false; }
  }
  app.get('/api/v1/health/ready', async (_request, reply) => {
    if (!cached || now() - cached.at > CACHE_MS) cached = { at: now(), ok: await probe() };
    const checks = { supabase: cached.ok ? 'ok' : 'unavailable' };
    return reply.code(cached.ok ? 200 : 503).send({ status: cached.ok ? 'ok' : 'unavailable', checks });
  });
}
