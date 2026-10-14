import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../../config.js';
import { createSalesGateway } from './gateway.js';
import { createRecurringGateway, registerRecurringRoutes } from './recurring.js';
import { registerSalesRoutes, type OrgAccess } from './routes.js';

export type { OrgAccess } from './routes.js';
export type { SalesGateway } from './gateway.js';

/** 매출 모듈(방문 장바구니·수납·일 정산·수입지출)의 단일 등록 진입점. */
export function registerSalesModule(app: FastifyInstance, organizations: OrgAccess | undefined, config: ServerConfig, fetcher?: typeof fetch): void {
  registerSalesRoutes(app, organizations, createSalesGateway(config, fetcher));
  registerRecurringRoutes(app, organizations, createRecurringGateway(config, fetcher));
}
