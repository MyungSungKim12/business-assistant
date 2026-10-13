import { createApp } from './app.js';
import { parseServerConfig } from './config.js';
import { createRuntimeAuth } from './supabase/runtime-auth.js';
import { createOrganizationGateway } from './supabase/organizations.js';
import { createCustomerGateway } from './supabase/customers.js';
import { createCustomerActivityGateway } from './supabase/customer-activities.js';
import { createCustomerPhotoGateway } from './supabase/customer-photos.js';
import { createAppointmentGateway } from './supabase/appointments.js';
import { createOperationsGateway } from './supabase/operations.js';
import { createTaskGateway } from './supabase/tasks.js';
import { parseAccessCacheTtl } from './security/access-cache.js';
import { bindWarning, inspectEnvironment, scrubEnvironment } from './security/environment.js';

// 시작 점검: production 에서 개발용 자동 로그인이 켜져 있으면 시작하지 않는다.
const report = inspectEnvironment(process.env, 'api');
if (report.errors.length > 0) {
  for (const message of report.errors) console.error(`[server] ${message}`);
  process.exit(1);
}

const config = parseServerConfig(process.env);
// 일반 API 는 서비스 키·개발용 계정을 쓰지 않는다. 환경에서 지워 이후 코드가 읽지 못하게 한다(config 스키마에도 없다).
scrubEnvironment(process.env, 'api');

const app = createApp({ config, auth: createRuntimeAuth(config), organizations:createOrganizationGateway(config, fetch, { accessCacheTtlSec: parseAccessCacheTtl(process.env.APP_ACCESS_CACHE_TTL_SEC) }), customers:createCustomerGateway(config), activities:createCustomerActivityGateway(config), photos:createCustomerPhotoGateway(config), appointments:createAppointmentGateway(config), operations:createOperationsGateway(config), tasks:createTaskGateway(config) });
for (const message of report.warnings) app.log.warn(message);
const warning = bindWarning(config.APP_API_HOST);
if (warning) app.log.warn(warning);

await app.listen({ host: config.APP_API_HOST, port: config.APP_API_PORT });
