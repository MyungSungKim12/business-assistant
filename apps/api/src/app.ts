import { type FastifyInstance } from 'fastify';
import { registerAuthRoutes, type AuthGateway } from './routes/auth.js';
import { registerOrganizationRoutes } from './routes/organizations.js';
import { registerCustomerRoutes } from './routes/customers.js';
import { registerCustomerActivityRoutes } from './routes/customer-activities.js';
import { registerPhoneRoutes } from './modules/phone/routes.js';
import { registerCustomerPhotoRoutes, type CustomerPhotoGateway } from './routes/customer-photos.js';
import { registerAppointmentRoutes, type AppointmentGateway } from './routes/appointments.js';
import { registerOperationRoutes, type OperationsGateway } from './routes/operations.js';
import { registerTaskRoutes } from './routes/tasks.js';
import type { TaskGateway } from './supabase/tasks.js';
import type { OrganizationGateway } from './supabase/organizations.js';
import type { CustomerGateway } from './supabase/customers.js';
import type { CustomerActivityGateway } from './supabase/customer-activities.js';
import { authLimitSettings, type ServerConfig } from './config.js';
import { createFastifyApp } from './http.js';
import { registerReadiness } from './health.js';
import { createAuthGuard, type AuthGuard } from './security/auth-guard.js';
import { createAuditRecorder, registerAuditHooks, registerAuditModule, type AuditRecorder } from './audit/index.js';
import { registerTreatmentModule } from './modules/treatments/index.js';
import { registerSalesModule } from './modules/sales/index.js';
import { registerDocumentModule } from './modules/documents/index.js';
import { registerCatalogModule } from './modules/catalog/index.js';
import { registerManagementModule } from './modules/management/index.js';
import { registerAppointmentResourceModule } from './modules/appointment-resources/index.js';

type AppDependencies = {
  auth?: AuthGateway; organizations?: OrganizationGateway; customers?: CustomerGateway; activities?: CustomerActivityGateway; photos?: CustomerPhotoGateway;
  appointments?: AppointmentGateway; operations?: OperationsGateway; tasks?: TaskGateway; config?: ServerConfig; fetcher?: typeof fetch;
  /** 감사 기록기. 설정(config)이 있으면 기본 기록기를 만든다. */
  audit?: AuditRecorder;
  /** 로그인 시도 제한. 없으면 설정(또는 기본값)으로 만든다. 테스트에서 시간을 주입할 때 쓴다. */
  authGuard?: AuthGuard;
};

/**
 * 일반 API(사용자 토큰만 사용). 관리자 구독 기능은 서비스 키가 필요하므로 여기에 없고 admin-app.ts(별도 프로세스)에 있다.
 */
export function createApp(dependencies: AppDependencies = {}): FastifyInstance {
  const app = createFastifyApp(dependencies.config);
  const guard = dependencies.authGuard ?? createAuthGuard(authLimitSettings(dependencies.config));
  app.addHook('onClose', async () => { guard.close(); });
  const audit = dependencies.audit ?? (dependencies.config ? createAuditRecorder(dependencies.config, dependencies.fetcher, app.log) : undefined);
  if (audit) registerAuditHooks(app, audit);

  app.get('/api/v1/health', async () => ({ status: 'ok' }));
  if (dependencies.config) registerReadiness(app, dependencies.config, dependencies.fetcher);
  if (dependencies.auth) void registerAuthRoutes(app, dependencies.auth, guard);
  registerOrganizationRoutes(app, dependencies.organizations);
  registerCustomerRoutes(app, dependencies.organizations, dependencies.customers, audit);
  registerCustomerActivityRoutes(app, dependencies.organizations, dependencies.activities);
  registerPhoneRoutes(app, dependencies.organizations, dependencies.customers, dependencies.activities);
  registerCustomerPhotoRoutes(app, dependencies.organizations, dependencies.photos);
  registerAppointmentRoutes(app, dependencies.organizations, dependencies.appointments);
  registerOperationRoutes(app, dependencies.organizations, dependencies.operations);
  registerTaskRoutes(app, dependencies.organizations, dependencies.tasks);
  // 운영 모듈: 설정이 있을 때만 등록한다(단위 테스트는 게이트웨이를 직접 주입).
  if (dependencies.config && audit) {
    const { config, fetcher } = dependencies;
    registerTreatmentModule(app, dependencies.organizations, config, fetcher);
    registerSalesModule(app, dependencies.organizations, config, fetcher);
    registerDocumentModule(app, dependencies.organizations, config, fetcher);
    registerCatalogModule(app, dependencies.organizations, config, fetcher);
    registerManagementModule(app, dependencies.organizations, config, fetcher);
    registerAppointmentResourceModule(app, dependencies.organizations, config, fetcher);
    registerAuditModule(app, dependencies.organizations, config, fetcher);
  }
  return app;
}
