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

type AppDependencies = { auth?: AuthGateway; organizations?: OrganizationGateway; customers?: CustomerGateway; activities?: CustomerActivityGateway; photos?: CustomerPhotoGateway; appointments?: AppointmentGateway; operations?: OperationsGateway; tasks?: TaskGateway };

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
  app.setErrorHandler((error, request, reply) => {
    const status = error instanceof ApiFailure ? error.status : 500;
    if (status === 401) reply.header('WWW-Authenticate', 'Bearer');
    return reply.code(status).send({detail:error instanceof ApiFailure ? error.detail : 'Internal server error',requestId:request.id});
  });

  return app;
}
