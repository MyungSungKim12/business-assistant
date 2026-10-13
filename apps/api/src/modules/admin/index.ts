import type { FastifyInstance } from 'fastify';
import type { OrgAccess } from '../catalog/routes.js';
import { createAdminGateway, type AdminConfig } from './gateway.js';
import { registerAdminRoutes } from './routes.js';

/**
 * 통합 진입점: `registerAdminModule(app, organizations, config)`.
 * 관리자 판정은 조직 권한(organizations)이 아니라 플랫폼 관리자 목록이므로 organizations는 쓰지 않는다(시그니처 통일용).
 */
export function registerAdminModule(app: FastifyInstance, _organizations: OrgAccess | undefined, config: AdminConfig, fetcher: typeof fetch = fetch): void {
  registerAdminRoutes(app, createAdminGateway(config, fetcher));
}
export { createAdminGateway, platformAdminIds, type AdminConfig, type AdminGateway } from './gateway.js';
export { registerAdminRoutes, subscriptionRequest } from './routes.js';
