import { z } from 'zod';
import type { ApiClient } from '../../api/client';

export const commissionRuleSchema=z.object({id:z.string(),organization_id:z.string(),staff_id:z.string().nullable(),commission_scope:z.enum(['service','product','membership']),service_id:z.string().nullable(),product_id:z.string().nullable(),rate_basis_points:z.number().int(),basis:z.literal('net_paid'),effective_from:z.string(),effective_to:z.string().nullable(),version:z.number().int(),is_active:z.boolean(),created_by:z.string(),created_at:z.string()});
export const commissionRulesSchema=z.array(commissionRuleSchema);
export type CommissionRule=z.infer<typeof commissionRuleSchema>;
export const commissionLineSchema=z.object({source_event_id:z.string(),event_kind:z.enum(['receipt','wallet','refund']),sale_line_id:z.string(),staff_id:z.string().nullable(),staff_name_snapshot:z.string(),commission_scope:z.enum(['service','product','membership']),source_id:z.string(),rule_id:z.string().nullable(),rule_rate_basis_points:z.number().int().nullable(),rule_snapshot:z.record(z.string(),z.unknown()),net_paid_amount:z.string(),commission_amount:z.string(),warning:z.string().nullable(),attribution_override_version:z.number().int().min(0).default(0)});
export const commissionStaffSchema=z.array(z.object({id:z.string(),organization_id:z.string(),name:z.string(),is_active:z.boolean()}));
export const commissionPreviewSchema=z.object({organization_id:z.string(),from_date:z.string(),to_date:z.string(),lines:z.array(commissionLineSchema)});
export type CommissionPreview=z.infer<typeof commissionPreviewSchema>;
export const commissionSettlementSchema=z.object({id:z.string(),organization_id:z.string(),from_date:z.string(),to_date:z.string(),status:z.literal('confirmed'),total_commission:z.string(),lines:z.array(z.unknown())});
export const commissionHistorySchema=z.array(z.object({settlement:z.object({id:z.string(),organization_id:z.string(),from_date:z.string(),to_date:z.string(),status:z.literal('confirmed'),total_commission:z.union([z.string(),z.number()]).transform(String)}),lines:z.array(z.object({id:z.string(),source_event_id:z.string(),event_kind:z.enum(['receipt','wallet','refund']),sale_line_id:z.string(),staff_id:z.string().nullable(),staff_name_snapshot:z.string(),commission_scope:z.enum(['service','product','membership']),net_paid_amount:z.union([z.string(),z.number()]).transform(String),commission_amount:z.union([z.string(),z.number()]).transform(String)}))}));
export type CommissionHistory=z.infer<typeof commissionHistorySchema>;
type CallApi=Pick<ApiClient,'call'>;
const base=(organizationId:string)=>`/organizations/${organizationId}/staff-commission-rules`;
export const commissionApi={
 list:(api:CallApi,organizationId:string)=>api.call('GET',base(organizationId),commissionRulesSchema),
 create:(api:CallApi,organizationId:string,input:{staff_id:string|null;commission_scope:CommissionRule['commission_scope'];service_id:string|null;product_id:string|null;rate_basis_points:number;effective_from:string;effective_to:string|null})=>api.call('POST',base(organizationId),commissionRuleSchema,input),
 end:(api:CallApi,organizationId:string,id:string,input:{effective_to:string;expected_version:number})=>api.call('POST',`${base(organizationId)}/${id}/end`,commissionRuleSchema,input),
 previewSettlement:(api:CallApi,organizationId:string,input:{from_date:string;to_date:string})=>api.call('POST',`${base(organizationId).replace('-rules','-settlements')}/preview`,commissionPreviewSchema,input),
  listStaff:(api:CallApi,organizationId:string)=>api.call('GET',`/organizations/${organizationId}/staff-commission-attribution-staff`,commissionStaffSchema),
  assignAttribution:(api:CallApi,organizationId:string,saleLineId:string,input:{staff_id:string;expected_version:number;reason:string;operation_id:string})=>api.call('PATCH',`/organizations/${organizationId}/staff-commission-attributions/${saleLineId}`,z.object({organization_id:z.string(),sale_line_id:z.string(),staff_id:z.string(),version:z.number().int().positive(),reason:z.string(),replayed:z.boolean()}),input),
 confirmSettlement:(api:CallApi,organizationId:string,input:{from_date:string;to_date:string;operation_id:string})=>api.call('POST',base(organizationId).replace('-rules','-settlements'),commissionSettlementSchema,input),
 history:(api:CallApi,organizationId:string)=>api.call('GET',base(organizationId).replace('-rules','-settlements'),commissionHistorySchema),
};
