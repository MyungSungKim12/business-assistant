import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuthRoutes, type AuthGateway } from './routes/auth.js';
import { registerOrganizationRoutes } from './routes/organizations.js';
import { registerCustomerRoutes } from './routes/customers.js';
import { registerCustomerActivityRoutes } from './routes/customer-activities.js';
import { registerCustomerPhotoRoutes, type CustomerPhotoGateway } from './routes/customer-photos.js';
import { registerAppointmentRoutes, type AppointmentGateway } from './routes/appointments.js';
import { registerOperationRoutes, type OperationsGateway } from './routes/operations.js';
import { registerTaskRoutes } from './routes/tasks.js';
import type { TaskGateway } from './supabase/tasks.js';
import type { OrganizationGateway } from './supabase/organizations.js';
import type { CustomerGateway } from './supabase/customers.js';
import type { CustomerActivityGateway } from './supabase/customer-activities.js';
import { ApiFailure } from './errors.js';
import type { ServerConfig } from './config.js';
import { registerTreatmentModule } from './modules/treatments/index.js';
import { registerSalesModule } from './modules/sales/index.js';
import { registerDocumentModule } from './modules/documents/index.js';
import { registerCatalogModule } from './modules/catalog/index.js';
import { registerManagementModule } from './modules/management/index.js';
import { registerAdminModule } from './modules/admin/index.js';
import { registerAppointmentResourceModule } from './modules/appointment-resources/index.js';

type AppDependencies = { auth?: AuthGateway; organizations?: OrganizationGateway; customers?: CustomerGateway; activities?: CustomerActivityGateway; photos?: CustomerPhotoGateway; appointments?: AppointmentGateway; operations?: OperationsGateway; tasks?: TaskGateway; config?: ServerConfig; fetcher?: typeof fetch };

export function createApp(dependencies: AppDependencies = {}): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get('/api/v1/health', async () => ({ status: 'ok' }));
  if (dependencies.auth) void registerAuthRoutes(app, dependencies.auth);
  registerOrganizationRoutes(app, dependencies.organizations);
  registerCustomerRoutes(app, dependencies.organizations, dependencies.customers);
  registerCustomerActivityRoutes(app, dependencies.organizations, dependencies.activities);
  registerCustomerPhotoRoutes(app, dependencies.organizations, dependencies.photos);
  registerAppointmentRoutes(app, dependencies.organizations, dependencies.appointments);
  registerOperationRoutes(app, dependencies.organizations, dependencies.operations);
  registerTaskRoutes(app, dependencies.organizations, dependencies.tasks);
  // 운영 모듈: 설정이 있을 때만 등록한다(단위 테스트는 게이트웨이를 직접 주입).
  if (dependencies.config) {
    const { config, fetcher } = dependencies;
    registerTreatmentModule(app, dependencies.organizations, config, fetcher);
    registerSalesModule(app, dependencies.organizations, config, fetcher);
    registerDocumentModule(app, dependencies.organizations, config, fetcher);
    registerCatalogModule(app, dependencies.organizations, config, fetcher);
    registerManagementModule(app, dependencies.organizations, config, fetcher);
    registerAdminModule(app, dependencies.organizations, config, fetcher);
    registerAppointmentResourceModule(app, dependencies.organizations, config, fetcher);
  }
  app.setErrorHandler((error, request, reply) => {
    const status = error instanceof ApiFailure ? error.status : 500;
    if (status === 401) reply.header('WWW-Authenticate', 'Bearer');
    return reply.code(status).send({detail:error instanceof ApiFailure ? error.detail : 'Internal server error',...(error instanceof ApiFailure ? error.extra : {}),requestId:request.id});
  });

  return app;
}
