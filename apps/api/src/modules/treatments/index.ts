import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../../config.js';
import { createTreatmentGateway } from './gateway.js';
import { registerSaleDraftRoutes, registerTreatmentRoutes, type OrgAccess } from './routes.js';
import { createSaleDraftGateway } from './sale-drafts.js';
import { createTemplateGateway, registerTemplateRoutes } from './templates.js';

export type { OrgAccess } from './routes.js';

/** 시술·상담·결제 초안 모듈의 단일 진입점. app.ts에서 한 줄로 호출한다. */
export function registerTreatmentModule(app: FastifyInstance, organizations: OrgAccess | undefined, config: ServerConfig, fetcher?: typeof fetch): void {
  registerTreatmentRoutes(app, organizations, createTreatmentGateway(config, fetcher));
  registerSaleDraftRoutes(app, organizations, createSaleDraftGateway(config, fetcher));
  registerTemplateRoutes(app, organizations, createTemplateGateway(config, fetcher));
}
