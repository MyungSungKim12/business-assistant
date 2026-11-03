import type{FastifyInstance}from'fastify';
import type{ServerConfig}from'../../config.js';
import type{OrgAccess}from'../catalog/routes.js';
import{createAppointmentVisitGroupGateway}from'./gateway.js';
import{registerAppointmentVisitGroupRoutes}from'./routes.js';
export function registerAppointmentVisitGroupModule(app:FastifyInstance,organizations:OrgAccess|undefined,config:ServerConfig,fetcher:typeof fetch=fetch){registerAppointmentVisitGroupRoutes(app,organizations,createAppointmentVisitGroupGateway(config,fetcher))}
