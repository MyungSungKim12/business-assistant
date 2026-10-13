import { createAdminApp } from './admin-app.js';
import { parseAdminConfig } from './config.js';
import { bindWarning, inspectEnvironment } from './security/environment.js';

const report = inspectEnvironment(process.env, 'admin');
if (report.errors.length > 0) {
  for (const message of report.errors) console.error(`[admin-server] ${message}`);
  process.exit(1);
}

const config = parseAdminConfig(process.env);
const app = createAdminApp(config);
for (const message of report.warnings) app.log.warn(message);
const warning = bindWarning(config.APP_ADMIN_HOST);
if (warning) app.log.warn(warning);
if (!config.APP_PLATFORM_ADMIN_USER_IDS?.trim()) app.log.warn('APP_PLATFORM_ADMIN_USER_IDS 가 비어 있어 모든 관리자 요청이 403 으로 거부됩니다.');

await app.listen({ host: config.APP_ADMIN_HOST, port: config.APP_ADMIN_PORT });
