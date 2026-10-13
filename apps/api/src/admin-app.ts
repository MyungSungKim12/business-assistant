import type { FastifyInstance } from 'fastify';
import type { ResolvedAdminConfig } from './config.js';
import { createFastifyApp } from './http.js';
import { registerAdminModule } from './modules/admin/index.js';

/**
 * 관리자 API(플랫폼 관리자 전용, 서비스 키 사용). 일반 API 와 다른 프로세스·포트로 실행하며,
 * 경로(/api/v1/admin/...)와 인증(사용자 토큰 + 플랫폼 관리자 목록)은 이전과 같다.
 */
export function createAdminApp(config: ResolvedAdminConfig, fetcher?: typeof fetch): FastifyInstance {
  const app = createFastifyApp(config);
  app.get('/api/v1/health', async () => ({ status: 'ok' }));
  registerAdminModule(app, undefined, config, fetcher);
  return app;
}
