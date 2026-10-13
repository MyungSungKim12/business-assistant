import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiFailure } from '../errors.js';
import { bearerToken } from './organizations.js';
import type { ActivityInput, CustomerActivityGateway } from '../supabase/customer-activities.js';

const identifiers = z.object({ organizationId: z.uuid(), customerId: z.uuid() });
const createInput = z.object({ activity_type: z.string().trim().min(1).max(100).default('note'), title: z.string().trim().min(1).max(100), description: z.string().max(10_000).default(''), occurred_at: z.iso.datetime({ offset: true }).nullable().default(null) }).strict();

export function registerCustomerActivityRoutes(app: FastifyInstance, organizations: Pick<{ requireAccess(token: string, id: string, feature: string, write?: boolean): Promise<string> }, 'requireAccess'> | undefined, activities?: CustomerActivityGateway): void {
  function service(request: FastifyRequest) {
    const token = bearerToken(request);
    if (!organizations || !activities) throw new ApiFailure(503, 'Customer activity service unavailable');
    const params = identifiers.safeParse(request.params);
    if (!params.success) throw new ApiFailure(422, 'Invalid customer ID');
    return { token, ...params.data, organizations, activities };
  }
  app.get('/api/v1/organizations/:organizationId/customers/:customerId/activities', async request => {
    const current = service(request); await current.organizations.requireAccess(current.token, current.organizationId, 'crm.basic'); return current.activities.list(current.token, current.organizationId, current.customerId);
  });
  app.post('/api/v1/organizations/:organizationId/customers/:customerId/activities', async (request, reply) => {
    const current = service(request); const input = createInput.safeParse(request.body);
    if (!input.success) throw new ApiFailure(422, 'Invalid customer activity input');
    await current.organizations.requireAccess(current.token, current.organizationId, 'crm.basic', true);
    const created = await current.activities.create(current.token, current.organizationId, current.customerId, input.data as ActivityInput);
    return reply.code(201).send(created);
  });
  app.delete('/api/v1/organizations/:organizationId/customers/:customerId/activities/:activityId', async (request, reply) => {
    const current = service(request); const activityId = z.object({ activityId: z.uuid() }).safeParse(request.params);
    if (!activityId.success) throw new ApiFailure(422, 'Invalid customer activity ID');
    await current.organizations.requireAccess(current.token, current.organizationId, 'crm.basic', true);
    if (!await current.activities.remove(current.token, current.organizationId, current.customerId, activityId.data.activityId)) throw new ApiFailure(404, 'Customer activity not found');
    return reply.code(204).send();
  });
}
