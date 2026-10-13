import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiFailure } from '../errors.js';
import { bearerToken } from './organizations.js';
import type { CustomerGateway, CustomerInput } from '../supabase/customers.js';
import type { AuditRecorder } from '../audit/recorder.js';

const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();
const optionalProfile = {
  email: nullableText(255), phone: nullableText(50), notes: z.string().max(5_000).optional(), birth_date: nullableText(10), skin_type: nullableText(100),
  concerns: z.array(z.string().trim().min(1).max(100)).max(30).optional(), allergies: z.string().max(1_000).optional(),
  last_visit_date: nullableText(10), next_visit_date: nullableText(10), tags: z.array(z.string().trim().min(1).max(50)).max(30).optional(), status: z.enum(['active', 'archived']).optional(),
};
const createInput = z.object({ name: z.string().trim().min(1).max(200), ...optionalProfile }).strict();
const patchInput = createInput.partial().refine(value => Object.keys(value).length > 0);
type EditableCustomer = Omit<CustomerInput, 'id' | 'organization_id'>;

export function registerCustomerRoutes(app: FastifyInstance, organizations: Pick<{ requireAccess(token: string, id: string, feature: string, write?: boolean): Promise<string> }, 'requireAccess'> | undefined, customers?: CustomerGateway, audit?: AuditRecorder): void {
  function service(request: FastifyRequest) {
    const token = bearerToken(request);
    if (!organizations || !customers) throw new ApiFailure(503, 'Customer service unavailable');
    const params = z.object({ organizationId: z.uuid() }).safeParse(request.params);
    if (!params.success) throw new ApiFailure(422, 'Invalid organization ID');
    return { token, organizationId: params.data.organizationId, organizations, customers };
  }
  app.get('/api/v1/organizations/:organizationId/customers', async request => {
    const current = service(request);
    await current.organizations.requireAccess(current.token, current.organizationId, 'crm.basic');
    return current.customers.list(current.token, current.organizationId);
  });
  app.post('/api/v1/organizations/:organizationId/customers', async request => {
    const current = service(request);
    const input = createInput.safeParse(request.body);
    if (!input.success) throw new ApiFailure(422, 'Invalid customer input');
    await current.organizations.requireAccess(current.token, current.organizationId, 'crm.basic', true);
    const value: EditableCustomer = { email: null, phone: null, notes: '', birth_date: null, skin_type: null, concerns: [], allergies: '', last_visit_date: null, next_visit_date: null, tags: [], status: 'active', ...input.data };
    return current.customers.create(current.token, current.organizationId, value);
  });
  app.patch('/api/v1/organizations/:organizationId/customers/:customerId', async request => {
    const current = service(request);
    const params = z.object({ customerId: z.uuid() }).safeParse(request.params);
    if (!params.success) throw new ApiFailure(422, 'Invalid customer ID');
    const patch = patchInput.safeParse(request.body);
    if (!patch.success) throw new ApiFailure(422, 'Invalid customer input');
    await current.organizations.requireAccess(current.token, current.organizationId, 'crm.basic', true);
    const saved = await current.customers.update(current.token, current.organizationId, params.data.customerId, patch.data);
    if (!saved) throw new ApiFailure(404, 'Customer not found');
    return saved;
  });
  app.delete('/api/v1/organizations/:organizationId/customers/:customerId', async (request, reply) => {
    const current = service(request);
    const params = z.object({ customerId: z.uuid() }).safeParse(request.params);
    if (!params.success) throw new ApiFailure(422, 'Invalid customer ID');
    await current.organizations.requireAccess(current.token, current.organizationId, 'crm.basic', true);
    // 영구 삭제는 되돌릴 수 없으므로 감사 기록이 먼저 성공해야 진행한다(fail-closed).
    await audit?.recordRequired(current.token, { organizationId: current.organizationId, action: 'customer.delete', targetType: 'customer', targetId: params.data.customerId, requestId: request.id, ip: request.ip });
    if (!(await current.customers.remove(current.token, current.organizationId, params.data.customerId))) throw new ApiFailure(404, 'Customer not found');
    return reply.code(204).send();
  });
}
