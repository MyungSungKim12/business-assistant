import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiFailure } from '../errors.js';
import type { OrganizationGateway } from '../supabase/organizations.js';

export function bearerToken(request: FastifyRequest): string {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '');
  if (!match) throw new ApiFailure(401,'Not authenticated');
  return match[1];
}

export function registerOrganizationRoutes(app: FastifyInstance, gateway?: OrganizationGateway): void {
  function service(request:FastifyRequest) {
    const token = bearerToken(request);
    if (!gateway) throw new ApiFailure(503,'Organization service unavailable');
    return {token,gateway};
  }
  app.post('/api/v1/organizations', async (request, reply) => {
    const {token,gateway} = service(request);
    const body = z.object({name:z.string().trim().min(1).max(200),slug:z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100)}).strict().safeParse(request.body);
    if (!body.success) throw new ApiFailure(422,'Invalid organization input');
    return reply.code(201).send(await gateway.create(token,body.data.name,body.data.slug));
  });
  app.get('/api/v1/organizations', async request => {
    const {token,gateway} = service(request);
    return gateway.list(token);
  });
  for (const route of ['entitlements','members','subscriptions/current'] as const) {
    app.get('/api/v1/organizations/:organizationId/'+route, async request => {
      const {token,gateway} = service(request);
      const parsed = z.object({organizationId:z.uuid()}).safeParse(request.params);
      if (!parsed.success) throw new ApiFailure(422,'Invalid organization ID');
      const id = parsed.data.organizationId;
      if (route === 'entitlements') return gateway.entitlements(token,id);
      if (route === 'members') return gateway.members(token,id);
      return gateway.currentSubscription(token,id);
    });
  }
}

