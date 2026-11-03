import {z} from 'zod';
import type {ApiClient} from '../../api/client';
const id=z.uuid(),status=z.enum(['queued','processing','delivered','failed','cancelled']);
export const templateSchema=z.object({id,organization_id:id,name:z.string(),channel:z.enum(['sms','kakao']),purpose:z.enum(['transactional','marketing']),body:z.string(),version:z.number(),is_active:z.boolean(),created_at:z.string(),updated_at:z.string()});
export const messageSchema=z.object({id,organization_id:id,template_id:id,customer_id:id,operation_id:id,channel:z.enum(['sms','kakao']),purpose:z.enum(['transactional','marketing']),template_name:z.string(),template_version:z.number(),scheduled_at:z.string(),status,attempt_count:z.number(),failure_code:z.string().nullable(),created_at:z.string()});
export const workspaceSchema=z.object({organization_id:id,templates:z.array(templateSchema),messages:z.array(messageSchema),provider_ready:z.literal(false)});
export const previewSchema=z.object({eligible:z.array(z.object({customer_id:id,name:z.string(),phone_masked:z.string()})),excluded:z.array(z.object({customer_id:id,name:z.string().nullable(),reason:z.enum(['customer_not_found','customer_inactive','phone_missing','marketing_consent_required'])})),template_version:z.number(),provider_ready:z.literal(false)});
export const enqueueSchema=z.object({created:z.number(),excluded:previewSchema.shape.excluded,messages:z.array(z.object({id,customer_id:id,status:z.literal('queued'),scheduled_at:z.string(),attempt_count:z.number()})),provider_ready:z.literal(false)});
export type MarketingWorkspace=z.infer<typeof workspaceSchema>;
export type MessageTemplate=z.infer<typeof templateSchema>;
export type MarketingApiClient=Pick<ApiClient,'call'>;
const base=(org:string)=>`/organizations/${org}/marketing`;
export const marketingApi={
 workspace:(api:MarketingApiClient,org:string)=>api.call('GET',base(org),workspaceSchema),
 saveTemplate:(api:MarketingApiClient,org:string,input:{template_id:string|null;expected_version:number|null;name:string;channel:'sms'|'kakao';purpose:'transactional'|'marketing';body:string})=>api.call('POST',`${base(org)}/templates`,z.object({template:templateSchema}),input),
 searchCustomers:(api:MarketingApiClient,org:string,q:string)=>{const query=new URLSearchParams({q,status:'active',limit:'50'});return api.call('GET',`/organizations/${org}/customers/search?${query}`,z.object({items:z.array(z.object({id,organization_id:id,name:z.string(),phone:z.string().nullable(),marketing_consent:z.boolean().optional()})),total:z.number(),next_cursor:z.string().nullable()}));},
 preview:(api:MarketingApiClient,org:string,input:{template_id:string;customer_ids:string[]})=>api.call('POST',`${base(org)}/preview`,previewSchema,input),
 enqueue:(api:MarketingApiClient,org:string,input:{template_id:string;customer_ids:string[];scheduled_at:string|null;operation_id:string})=>api.call('POST',`${base(org)}/enqueue`,enqueueSchema,input),
 cancel:(api:MarketingApiClient,org:string,id:string,expected_attempt_count:number)=>api.call('POST',`${base(org)}/${id}/cancel`,z.object({cancelled:z.literal(true),id}),{expected_attempt_count}),
 retry:(api:MarketingApiClient,org:string,id:string,expected_attempt_count:number,operation_id:string)=>api.call('POST',`${base(org)}/${id}/retry`,z.object({id,status:z.literal('queued'),attempt_count:z.number(),provider_ready:z.literal(false)}),{expected_attempt_count,operation_id}),
};
export const messageStatusLabel:Record<z.infer<typeof status>,string>={queued:'발송 연동 대기',processing:'발송 처리 중',delivered:'전달 완료',failed:'발송 실패',cancelled:'취소'};
export const exclusionReasonLabel={customer_not_found:'다른 매장 고객이거나 찾을 수 없음',customer_inactive:'보관된 고객',phone_missing:'연락처 없음',marketing_consent_required:'마케팅 수신 동의 없음'} as const;
