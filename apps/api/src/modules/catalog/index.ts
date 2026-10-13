import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../../config.js';
import { createCatalogGateway } from './gateway.js';
import { registerCatalogRoutes, type OrgAccess } from './routes.js';

/** 통합 진입점: `registerCatalogModule(app, organizations, config)` 한 줄이면 상품·재고·회원권 라우트가 등록된다. */
export function registerCatalogModule(app: FastifyInstance, organizations: OrgAccess | undefined, config: ServerConfig, fetcher: typeof fetch = fetch): void {
  registerCatalogRoutes(app, organizations, createCatalogGateway(config, fetcher));
}
export { createCatalogGateway, type CatalogGateway } from './gateway.js';
export { registerCatalogRoutes, type OrgAccess } from './routes.js';
