import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {ApiFailure} from '../../errors.js';
import {bearerToken} from '../../routes/organizations.js';
import type {OrgAccess} from '../catalog/routes.js';
import type {MarketingGateway} from './gateway.js';
import {audienceInput,cancelInput,enqueueInput,retryInput,templateInput} from './schemas.js';
const paramsSchema=z.object({organizationId:z.uuid()}),messageParams=paramsSchema.extend({messageId:z.uuid()});
export function registerMarketingRoutes(app:FastifyInstance,organizations:OrgAccess|undefined,gateway:MarketingGateway){
 const base='/api/v1/organizations/:organizationId/marketing';
 function context(request:FastifyRequest){const token=bearerToken(request),parsed=paramsSchema.safeParse(request.params);if(!parsed.success)throw new ApiFailure(422,'Invalid organization ID');if(!organizations)throw new ApiFailure(503,'Marketing service unavailable');return{token,organizationId:parsed.data.organizationId};}
 app.get(base,async request=>{const c=context(request);await organizations!.requireAccess(c.token,c.organizationId,'crm.basic');const workspace=await gateway.workspace(c.token,c.organizationId);if(workspace.organization_id!==c.organizationId||workspace.templates.some(row=>row.organization_id!==c.organizationId)||workspace.messages.some(row=>row.organization_id!==c.organizationId))throw new ApiFailure(503,'Marketing service unavailable');return workspace});
 app.post(base+'/templates',async(request,reply)=>{const c=context(request),input=templateInput.safeParse(request.body);if(!input.success)throw new ApiFailure(422,'Invalid message template');await organizations!.requireAccess(c.token,c.organizationId,'crm.basic',true);return reply.code(input.data.template_id?200:201).send(await gateway.saveTemplate(c.token,c.organizationId,input.data))});
 app.post(base+'/preview',async request=>{const c=context(request),input=audienceInput.safeParse(request.body);if(!input.success)throw new ApiFailure(422,'Invalid message audience');await organizations!.requireAccess(c.token,c.organizationId,'crm.basic');return gateway.preview(c.token,c.organizationId,input.data.template_id,input.data.customer_ids)});
 app.post(base+'/enqueue',async request=>{const c=context(request),input=enqueueInput.safeParse(request.body);if(!input.success)throw new ApiFailure(422,'Invalid outbox request');await organizations!.requireAccess(c.token,c.organizationId,'crm.basic',true);return gateway.enqueue(c.token,c.organizationId,input.data)});
 app.post(base+'/:messageId/cancel',async request=>{const c=context(request),p=messageParams.safeParse(request.params),input=cancelInput.safeParse(request.body);if(!p.success||!input.success)throw new ApiFailure(422,'Invalid cancellation');await organizations!.requireAccess(c.token,c.organizationId,'crm.basic',true);return gateway.cancel(c.token,c.organizationId,p.data.messageId,input.data.expected_attempt_count)});
 app.post(base+'/:messageId/retry',async request=>{const c=context(request),p=messageParams.safeParse(request.params),input=retryInput.safeParse(request.body);if(!p.success||!input.success)throw new ApiFailure(422,'Invalid retry');await organizations!.requireAccess(c.token,c.organizationId,'crm.basic',true);return gateway.retry(c.token,c.organizationId,p.data.messageId,input.data.expected_attempt_count,input.data.operation_id)});
}
