import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiFailure } from '../errors.js';
import type { OrganizationGateway } from '../supabase/organizations.js';
import { memberEmailInput, memberRoleInput } from '../supabase/organization-members.js';

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
  registerMemberRoutes(app,service);
}

/** 구성원 관리(TEAM-10). 목록은 기존 /members(하위 호환) 대신 /members/detail 로 이메일·이름까지 돌려준다. 권한은 DB 함수가 다시 확인한다. */
function registerMemberRoutes(app: FastifyInstance, service: (request: FastifyRequest) => { token: string; gateway: OrganizationGateway }): void {
  const base = '/api/v1/organizations/:organizationId/members';
  const orgId = (request: FastifyRequest) => {
    const parsed = z.object({organizationId:z.uuid()}).safeParse(request.params);
    if (!parsed.success) throw new ApiFailure(422,'Invalid organization ID');
    return parsed.data.organizationId;
  };
  app.get(base+'/detail', async request => {
    const {token,gateway} = service(request);
    return gateway.membersDetail(token,orgId(request));
  });
  app.post(base, async (request, reply) => {
    const {token,gateway} = service(request);
    const id = orgId(request);
    const body = memberEmailInput.safeParse(request.body);
    if (!body.success) throw new ApiFailure(422,'Invalid member input');
    return reply.code(201).send(await gateway.addMemberByEmail(token,id,body.data.email,body.data.role));
  });
  app.patch(base+'/:userId', async request => {
    const {token,gateway} = service(request);
    const id = orgId(request);
    const params = z.object({userId:z.uuid()}).safeParse(request.params);
    const body = memberRoleInput.safeParse(request.body);
    if (!params.success || !body.success) throw new ApiFailure(422,'Invalid member input');
    return gateway.setMemberRole(token,id,params.data.userId,body.data.role);
  });
  app.delete(base+'/:userId', async (request, reply) => {
    const {token,gateway} = service(request);
    const id = orgId(request);
    const params = z.object({userId:z.uuid()}).safeParse(request.params);
    if (!params.success) throw new ApiFailure(422,'Invalid member input');
    await gateway.removeMember(token,id,params.data.userId);
    return reply.code(204).send();
  });
}
