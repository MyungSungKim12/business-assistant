import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiFailure } from '../../errors.js';
import type { AuthGateway } from '../../routes/auth.js';
import { phoneResult, type PhoneGateway } from './gateway.js';

export function registerIncomingCallRoutes(
  app: FastifyInstance,
  context: (request: FastifyRequest) => { token: string; organizationId: string },
  organizations: { requireAccess(token: string, organizationId: string, feature: string): Promise<string> } | undefined,
  auth: AuthGateway | undefined,
  gateway?: PhoneGateway,
) {
  const listeners = new Map<string, number>(); let total = 0; let closed = false;
  app.addHook('onClose', async () => { closed = true; });
  async function scope(request: FastifyRequest) {
    const current = context(request);
    if (!auth?.getUser || !organizations || !gateway) throw new ApiFailure(503, 'Phone inbox unavailable');
    await organizations.requireAccess(current.token, current.organizationId, 'crm.basic');
    const user = await auth.getUser(current.token);
    if (!z.uuid().safeParse(user.userId).success) throw new ApiFailure(401, 'Invalid account');
    return { ...current, userId: user.userId };
  }
  const path = '/api/v1/organizations/:organizationId/mobile/incoming-calls';
  app.post(path, async (request, reply) => {
    const current = await scope(request);
    const input = z.object({ event_id: z.uuid(), number: z.string().trim().min(1).max(40), occurred_at: z.iso.datetime({ offset: true }), retention_consent_version: z.number().int().positive().optional() }).strict().safeParse(request.body);
    if (!input.success) throw new ApiFailure(422, 'Invalid incoming call');
    const result = phoneResult('publish', await gateway!.request(current.token, current.organizationId, 'publish', input.data), current.organizationId) as {duplicate:boolean};
    return reply.header('Cache-Control', 'no-store').code(result.duplicate ? 200 : 201).send(result);
  });
  app.get(path, async (request, reply) => {
    const current = await scope(request);
    const input = z.object({ after: z.string().max(100).regex(/^[a-zA-Z0-9:-]*$/).default(''), wait_ms: z.coerce.number().int().min(0).max(8000).default(8000) }).strict().safeParse(request.query);
    if (!input.success) throw new ApiFailure(422, 'Invalid call cursor');
    const key=current.organizationId+':'+current.userId;
    if((listeners.get(key)??0)>=4||total>=256)throw new ApiFailure(429,'Too many call listeners');
    listeners.set(key,(listeners.get(key)??0)+1);total++;
    try {
      const end=Date.now()+input.data.wait_ms;
      let result:{items:unknown[];cursor:string};
      do {
        result=phoneResult('poll',await gateway!.request(current.token,current.organizationId,'poll',{after:input.data.after,limit:100}),current.organizationId) as typeof result;
        if(result.items.length||Date.now()>=end||closed||request.raw.destroyed)break;
        await new Promise(resolve=>setTimeout(resolve,Math.min(500,Math.max(0,end-Date.now()))));
      }while(!closed);
      return reply.header('Cache-Control','no-store').send(result);
    } finally {total--;const count=(listeners.get(key)??1)-1;if(count)listeners.set(key,count);else listeners.delete(key);}
  });
  const root='/api/v1/organizations/:organizationId';
  const consentInput=z.object({enabled:z.boolean(),expected_version:z.number().int().nonnegative(),operation_id:z.uuid()}).strict();
  for(const prefix of ['/phone/retention-consent','/mobile/phone-retention-consent']) {
    app.get(root+prefix,async(request,reply)=>{const c=await scope(request);return reply.header('Cache-Control','no-store').send(phoneResult('consent',await gateway!.request(c.token,c.organizationId,'consent',{}),c.organizationId));});
    app.put(root+prefix,async(request,reply)=>{const c=await scope(request);const input=consentInput.safeParse(request.body);if(!input.success)throw new ApiFailure(422,'Invalid consent');return reply.header('Cache-Control','no-store').send(phoneResult('set-consent',await gateway!.request(c.token,c.organizationId,'set-consent',input.data),c.organizationId));});
  }
  app.get(root+'/phone/inbox',async(request,reply)=>{
    const c=await scope(request);
    const input=z.object({after:z.string().max(100).optional(),limit:z.coerce.number().int().min(1).max(100).default(30),status:z.enum(['unconfirmed','seen','completed','callback_needed']).optional(),customer_id:z.uuid().optional(),from:z.iso.datetime({offset:true}).optional(),to:z.iso.datetime({offset:true}).optional()}).strict().safeParse(request.query);
    if(!input.success)throw new ApiFailure(422,'Invalid inbox query');
    return reply.header('Cache-Control','no-store').send(phoneResult('list',await gateway!.request(c.token,c.organizationId,'list',input.data),c.organizationId));
  });
  app.post(root+'/phone/inbox/:eventId/response',async(request,reply)=>{
    const c=await scope(request);const params=z.object({eventId:z.uuid()}).safeParse(request.params);
    const input=z.object({recipient_id:z.uuid(),expected_version:z.number().int().positive(),operation_id:z.uuid(),status:z.enum(['unconfirmed','seen','completed','callback_needed']).optional(),memo:z.string().trim().max(10000).optional(),customer_id:z.uuid().optional(),assignee_id:z.uuid().nullable().optional(),callback_due_at:z.iso.datetime({offset:true}).optional()}).strict().safeParse(request.body);
    if(!input.success||!params.success)throw new ApiFailure(422,'Invalid phone response');
    if(input.data.callback_due_at)await organizations!.requireAccess(c.token,c.organizationId,'task.basic');
    return reply.header('Cache-Control','no-store').send(phoneResult('update',await gateway!.request(c.token,c.organizationId,'update',{id:params.data.eventId,...input.data}),c.organizationId));
  });
  app.get(root+'/phone/inbox/:eventId',async(request,reply)=>{
    const c=await scope(request);const params=z.object({eventId:z.uuid()}).safeParse(request.params);const query=z.object({recipient_id:z.uuid().optional()}).strict().safeParse(request.query);
    if(!params.success||!query.success)throw new ApiFailure(422,'Invalid phone record');
    return reply.header('Cache-Control','no-store').send(phoneResult('record',await gateway!.request(c.token,c.organizationId,'record',{id:params.data.eventId,...query.data}),c.organizationId));
  });
  app.post(root+'/phone/inbox/:eventId/ack',async(request,reply)=>{
    const c=await scope(request);const params=z.object({eventId:z.uuid()}).safeParse(request.params);if(!params.success||!z.object({}).strict().safeParse(request.body).success)throw new ApiFailure(422,'Invalid phone acknowledgement');
    return reply.header('Cache-Control','no-store').send(phoneResult('ack',await gateway!.request(c.token,c.organizationId,'ack',{id:params.data.eventId}),c.organizationId));
  });
}
