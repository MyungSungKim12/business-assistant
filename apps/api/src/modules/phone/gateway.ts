import {z} from 'zod';
import type {ServerConfig} from '../../config.js';
import {ApiFailure} from '../../errors.js';

export type PhoneAction='publish'|'poll'|'list'|'consent'|'set-consent'|'update'|'record'|'ack'|'directory';
export interface PhoneGateway {request(token:string,organizationId:string,action:PhoneAction,input:Record<string,unknown>):Promise<unknown>}
export const consentSchema=z.object({enabled:z.boolean(),version:z.number().int().nonnegative(),retention_days:z.literal(30)});
const match=z.object({customer_id:z.uuid(),name:z.string(),phone:z.string().nullable(),phone_e164:z.string()});
const revision=z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
const change=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('upsert'),customer_id:z.uuid(),name:z.string().max(1000),phone:z.string().max(40),phone_e164:z.string().regex(/^\+[1-9][0-9]{7,14}$/),revision:revision.optional()}),
 z.object({operation:z.literal('delete'),customer_id:z.uuid(),revision}),
]);
export const directorySchema=z.object({organization_id:z.uuid(),mode:z.enum(['snapshot','delta']),items:z.array(change).max(200),revision,next_cursor:z.string().max(512).nullable(),cursor:z.string().max(512).nullable(),reset_required:z.boolean()}).superRefine((v,c)=>{
 if(v.reset_required ? v.items.length>0||v.next_cursor!==null||v.cursor!==null : (v.next_cursor===null)===(v.cursor===null))c.addIssue({code:'custom',message:'Invalid directory continuation'});
 if(!v.reset_required && ((v.mode==='snapshot' && (v.cursor!==null || v.items.some(r=>r.operation!=='upsert'))) || (v.mode==='delta' && v.items.some(r=>!r.revision))))c.addIssue({code:'custom',message:'Invalid directory page mode'});
});
export const callSchema=z.object({id:z.uuid(),phone_e164:z.string(),occurred_at:z.string(),received_at:z.string(),expires_at:z.string(),matches:z.array(match).max(100)});
export const recordSchema=z.object({id:z.uuid(),organization_id:z.uuid(),recipient_id:z.uuid(),phone_e164:z.string(),occurred_at:z.string(),received_at:z.string(),expires_at:z.string(),customer_ids:z.array(z.uuid()).min(1).max(100),retained:z.literal(true),retained_until:z.string(),status:z.enum(['unconfirmed','seen','completed','callback_needed']),assignee_id:z.uuid().nullable(),version:z.number().int().positive(),callback_task_id:z.uuid().nullable()});
export function phoneResult(action:PhoneAction,value:unknown,organizationId:string){
 if(action==='directory'){const parsed=directorySchema.safeParse(value);if(!parsed.success||parsed.data.organization_id!==organizationId)throw new ApiFailure(503,'Phone directory unavailable');return parsed.data;}
 const schema=action==='publish'?z.object({duplicate:z.boolean(),retained:z.boolean(),event:callSchema}):action==='poll'?z.object({items:z.array(callSchema).max(100),cursor:z.string()}):action==='list'?z.object({items:z.array(recordSchema).max(100),cursor:z.string(),next_cursor:z.string().nullable()}):action==='update'||action==='record'?recordSchema:action==='ack'?z.object({acknowledged:z.boolean()}):consentSchema;
 const parsed=schema.safeParse(value);if(!parsed.success)throw new ApiFailure(503,'Phone inbox unavailable');
 const records=action==='list'?(parsed.data as {items:z.infer<typeof recordSchema>[]}).items:action==='update'||action==='record'?[parsed.data as z.infer<typeof recordSchema>]:[];
 if(records.some(row=>row.organization_id!==organizationId))throw new ApiFailure(503,'Phone inbox unavailable');
 return parsed.data;
}
export function createPhoneGateway(config:ServerConfig,fetcher:typeof fetch=fetch):PhoneGateway {
 return {async request(token,organizationId,action,input){
  try {
   const response=await fetcher(new URL('/rest/v1/rpc/'+(action==='directory'?'phone_directory':'phone_inbox'),config.APP_SUPABASE_URL),{method:'POST',headers:{apikey:config.APP_SUPABASE_PUBLISHABLE_KEY,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(action==='directory'?{p_org:organizationId,p_cursor:input.cursor??null,p_limit:200}:{p_org:organizationId,p_action:action,p_input:input}),signal:AbortSignal.timeout(10000),redirect:'error'});
   const data:unknown=await response.json();
   if(!response.ok){const code=typeof data==='object'&&data&&'code' in data?String(data.code):'';
    const status=code==='23505'||code==='40001'?409:code==='P0002'?404:code==='22023'||code==='22P02'?422:response.status===401?401:response.status===403?403:503;
    throw new ApiFailure(status,status===409?'Phone record changed; reload before retry':status===403?'Access denied':'Phone inbox request failed');
   }
   return phoneResult(action,data,organizationId);
  }catch(error){if(error instanceof ApiFailure)throw error;throw new ApiFailure(503,'Phone inbox unavailable');}
 }};
}
