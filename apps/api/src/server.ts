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

const config = parseServerConfig(process.env);
const app = createApp({ config, auth: createRuntimeAuth(config), organizations:createOrganizationGateway(config), customers:createCustomerGateway(config), activities:createCustomerActivityGateway(config), photos:createCustomerPhotoGateway(config), appointments:createAppointmentGateway(config), operations:createOperationsGateway(config), tasks:createTaskGateway(config) });

await app.listen({ host: '127.0.0.1', port: config.APP_API_PORT });
