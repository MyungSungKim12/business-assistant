import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../../config.js';
import type { OrgAccess } from '../catalog/routes.js';
import { createManagementGateway } from './gateway.js';
import { registerManagementRoutes } from './routes.js';

/** 통합 진입점: `registerManagementModule(app, organizations, config)`. */
export function registerManagementModule(app: FastifyInstance, organizations: OrgAccess | undefined, config: ServerConfig, fetcher: typeof fetch = fetch): void {
  registerManagementRoutes(app, organizations, createManagementGateway(config, fetcher));
}
export { createManagementGateway, type ManagementGateway, type ManagementPreview } from './gateway.js';
export { registerManagementRoutes } from './routes.js';
