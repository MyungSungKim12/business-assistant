import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../../config.js';
import type { OrgAccess } from '../catalog/routes.js';
import { createAppointmentResourceGateway } from './gateway.js';
import { registerAppointmentResourceRoutes } from './routes.js';

/** 통합 진입점: `registerAppointmentResourceModule(app, organizations, config)`. */
export function registerAppointmentResourceModule(app: FastifyInstance, organizations: OrgAccess | undefined, config: ServerConfig, fetcher: typeof fetch = fetch): void {
  registerAppointmentResourceRoutes(app, organizations, createAppointmentResourceGateway(config, fetcher));
}
export { createAppointmentResourceGateway, appointmentSchema as appointmentWithResourcesSchema, type AppointmentResourceGateway, type AppointmentSaveInput } from './gateway.js';
export { registerAppointmentResourceRoutes } from './routes.js';
