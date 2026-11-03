import {z} from 'zod';
import type {ServerConfig} from '../../config.js';
import {ApiFailure} from '../../errors.js';
import {createRest} from '../../supabase/rest.js';
import {withPgErrorMap} from '../catalog/pgErrors.js';
import {audiencePreviewSchema,enqueueResultSchema,marketingWorkspaceSchema,messageTemplateSchema} from './schemas.js';
const saveTemplateResult=z.object({template:messageTemplateSchema});
const cancelResult=z.object({cancelled:z.literal(true),id:z.uuid()});
const retryResult=z.object({id:z.uuid(),status:z.literal('queued'),attempt_count:z.number().int().min(0).max(3),provider_ready:z.literal(false)});
export type MarketingGateway=ReturnType<typeof createMarketingGateway>;
export function createMarketingGateway(config:ServerConfig,fetcher:typeof fetch=fetch){
 const rest=createRest(config,withPgErrorMap(fetcher),'Marketing service unavailable');
 async function rpc<T>(token:string,name:string,args:Record<string,unknown>,schema:z.ZodType<T>):Promise<T>{return rest.rpc(token,name,args,schema)}
 function scoped<T extends {organization_id?:string}>(value:T,org:string):T{if(value.organization_id!==org)throw new ApiFailure(503,'Marketing service unavailable');return value}
 return {
  async workspace(token:string,org:string){const value=scoped(await rpc(token,'get_organization_message_workspace',{p_organization_id:org},marketingWorkspaceSchema),org);if(value.templates.some(row=>row.organization_id!==org)||value.messages.some(row=>row.organization_id!==org))throw new ApiFailure(503,'Marketing service unavailable');return value},
  async saveTemplate(token:string,org:string,input:{template_id:string|null;expected_version:number|null;name:string;channel:'sms'|'kakao';purpose:'transactional'|'marketing';body:string}){const value=await rpc(token,'save_organization_message_template',{p_organization_id:org,...input},saveTemplateResult);return {template:scoped(value.template,org)}},
  async preview(token:string,org:string,templateId:string,customerIds:string[]){return rpc(token,'preview_organization_message_audience',{p_organization_id:org,p_template_id:templateId,p_customer_ids:customerIds},audiencePreviewSchema)},
  async enqueue(token:string,org:string,input:{template_id:string;customer_ids:string[];scheduled_at:string|null;operation_id:string}){return rpc(token,'enqueue_organization_messages',{p_organization_id:org,p_template_id:input.template_id,p_customer_ids:input.customer_ids,p_scheduled_at:input.scheduled_at,p_operation_id:input.operation_id},enqueueResultSchema)},
  async cancel(token:string,org:string,id:string,expectedAttemptCount:number){return rpc(token,'cancel_organization_message',{p_organization_id:org,p_message_id:id,p_expected_version:expectedAttemptCount},cancelResult)},
  async retry(token:string,org:string,id:string,expectedAttemptCount:number,operationId:string){return rpc(token,'retry_organization_message',{p_organization_id:org,p_message_id:id,p_expected_attempt_count:expectedAttemptCount,p_operation_id:operationId},retryResult)},
 };
}
