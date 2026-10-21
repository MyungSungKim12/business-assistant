import { z } from 'zod';
import type { ServerConfig } from '../../config.js';
import { ApiFailure } from '../../errors.js';
import { createRest } from '../../supabase/rest.js';
import { withPgErrorMap } from '../catalog/pgErrors.js';

const UNAVAILABLE = 'Management service unavailable';
/** 금액은 문자열로 돌려준다(Python Decimal 직렬화와 같다). 숫자·문자열 둘 다 받고 유한한 십진수만 허용한다. */
const decimal = z.union([z.string(), z.number()])
  .refine((value) => /^-?\d+(\.\d+)?$/.test(String(value).trim()), 'Invalid money')
  .transform((value) => String(value).trim());
const nonNegativeDecimal = decimal.refine((value) => !value.startsWith('-'), 'Must not be negative');

export const managementPreviewSchema = z.object({
  organization_id: z.uuid(),
  from_date: z.iso.date(),
  to_date: z.iso.date(),
  recorded_income: decimal,
  recorded_expense: decimal,
  recorded_net: decimal,
  transaction_count: z.number().int().min(0),
  visit_receipts: decimal,
  visit_refunds: decimal,
  inventory_cogs: decimal,
  inventory_cost_unknown_units: z.number().int().min(0),
  recorded_tax_expense: decimal,
  operating_profit_before_commission_tax: decimal.nullable(),
  commission_settlement_complete:z.boolean(),
  commission_expense:decimal.nullable(),
  operating_profit_after_commission_before_tax:decimal.nullable(),
  operating_profit_after_recorded_tax:decimal.nullable(),
  staff_sales_basis: z.array(z.object({
    staff_id: z.uuid().nullable(),
    staff_name_snapshot: z.string(),
    line_count: z.number().int().min(0),
    gross_line_total: nonNegativeDecimal,
  })),
  is_final_profit: z.boolean(),
  excluded_costs: z.array(z.string()),
  staff_basis_is_commission: z.boolean(),
});
export type ManagementPreview = z.infer<typeof managementPreviewSchema>;

export const commissionRuleSchema=z.object({id:z.uuid(),organization_id:z.uuid(),staff_id:z.uuid().nullable(),commission_scope:z.enum(['service','product','membership']),service_id:z.uuid().nullable(),product_id:z.uuid().nullable(),rate_basis_points:z.number().int().min(0).max(10000),basis:z.literal('net_paid'),effective_from:z.iso.date(),effective_to:z.iso.date().nullable(),version:z.number().int().positive(),is_active:z.boolean(),created_by:z.uuid(),created_at:z.string()});
export type CommissionRule=z.infer<typeof commissionRuleSchema>;
const commissionLineSchema=z.object({source_event_id:z.uuid(),event_kind:z.enum(['receipt','wallet','refund']),sale_line_id:z.uuid(),staff_id:z.uuid().nullable(),staff_name_snapshot:z.string(),commission_scope:z.enum(['service','product','membership']),source_id:z.uuid(),rule_id:z.uuid().nullable(),rule_rate_basis_points:z.number().int().nullable(),rule_snapshot:z.record(z.string(),z.unknown()),net_paid_amount:decimal,commission_amount:decimal,warning:z.string().nullable(),attribution_override_version:z.number().int().min(0).optional()});
const commissionAttributionSchema=z.object({organization_id:z.uuid(),sale_line_id:z.uuid(),staff_id:z.uuid(),version:z.number().int().positive(),reason:z.string(),replayed:z.boolean()});
const commissionStaffSchema=z.object({id:z.uuid(),organization_id:z.uuid(),name:z.string(),is_active:z.boolean()});
const commissionPreviewSchema=z.object({organization_id:z.uuid(),from_date:z.iso.date(),to_date:z.iso.date(),lines:z.array(commissionLineSchema)});
const commissionSettlementSchema=z.object({id:z.uuid(),organization_id:z.uuid(),from_date:z.iso.date(),to_date:z.iso.date(),status:z.literal('confirmed'),total_commission:decimal,lines:z.array(z.unknown())});
export const managementProfitFinalizationSchema=z.object({id:z.uuid(),organization_id:z.uuid(),from_date:z.iso.date(),to_date:z.iso.date(),revision:z.number().int().positive(),result:managementPreviewSchema,reason:z.string().max(500),confirmed_by:z.uuid(),confirmed_at:z.string()});
export type ManagementProfitFinalization=z.infer<typeof managementProfitFinalizationSchema>;

export function createManagementGateway(config: ServerConfig, fetcher: typeof fetch = fetch) {
  const rest = createRest(config, withPgErrorMap(fetcher), UNAVAILABLE);
  return {
    /** 확정 손익이 아닌 읽기 전용 미리보기. 확정(최종 이익·수당 확정) 표시가 오면 닫힌 실패로 처리한다. */
    async getPreview(token: string, organizationId: string, fromDate: string, toDate: string): Promise<ManagementPreview> {
      const result = await rest.rpc(token, 'get_management_preview', { p_organization_id: organizationId, p_from_date: fromDate, p_to_date: toDate }, managementPreviewSchema);
      if (result.organization_id !== organizationId || result.from_date !== fromDate || result.to_date !== toDate || result.is_final_profit) {
        throw new ApiFailure(503, UNAVAILABLE);
      }
      return result;
    },
    async finalizeProfit(token:string,organizationId:string,input:{from_date:string;to_date:string;operation_id:string;confirmed_complete:true;reason:string}):Promise<ManagementProfitFinalization>{
      const result=await rest.rpc(token,'finalize_management_profit',{p_organization_id:organizationId,p_from_date:input.from_date,p_to_date:input.to_date,p_operation_id:input.operation_id,p_confirmed_complete:input.confirmed_complete,p_reason:input.reason},managementProfitFinalizationSchema);
      if(result.organization_id!==organizationId||result.from_date!==input.from_date||result.to_date!==input.to_date||!result.result.is_final_profit||result.result.organization_id!==organizationId||result.result.from_date!==input.from_date||result.result.to_date!==input.to_date)throw new ApiFailure(503,UNAVAILABLE);
      return result;
    },
    async listProfitFinalizations(token:string,organizationId:string,fromDate:string,toDate:string):Promise<ManagementProfitFinalization[]>{
      const rows=await rest.rpc(token,'list_management_profit_finalizations',{p_organization_id:organizationId,p_from_date:fromDate,p_to_date:toDate},z.array(managementProfitFinalizationSchema));
      if(rows.some(row=>row.organization_id!==organizationId||row.from_date!==fromDate||row.to_date!==toDate||!row.result.is_final_profit||row.result.organization_id!==organizationId||row.result.from_date!==fromDate||row.result.to_date!==toDate))throw new ApiFailure(503,UNAVAILABLE);
      return rows;
    },
    async listCommissionRules(token:string,organizationId:string):Promise<CommissionRule[]>{
      const rows=await rest.rpc(token,'list_staff_commission_rules',{p_organization_id:organizationId},z.array(commissionRuleSchema));
      if(rows.some(row=>row.organization_id!==organizationId))throw new ApiFailure(503,UNAVAILABLE);return rows;
    },
    async createCommissionRule(token:string,organizationId:string,input:{staff_id:string|null;commission_scope:'service'|'product'|'membership';service_id:string|null;product_id:string|null;rate_basis_points:number;effective_from:string;effective_to:string|null}):Promise<CommissionRule>{
      const row=await rest.rpc(token,'create_staff_commission_rule',{p_organization_id:organizationId,p_staff_id:input.staff_id,p_scope:input.commission_scope,p_service_id:input.service_id,p_product_id:input.product_id,p_rate_basis_points:input.rate_basis_points,p_effective_from:input.effective_from,p_effective_to:input.effective_to},commissionRuleSchema);
      if(row.organization_id!==organizationId)throw new ApiFailure(503,UNAVAILABLE);return row;
    },
    async endCommissionRule(token:string,organizationId:string,ruleId:string,effectiveTo:string,expectedVersion:number):Promise<CommissionRule>{
      const row=await rest.rpc(token,'end_staff_commission_rule',{p_organization_id:organizationId,p_rule_id:ruleId,p_effective_to:effectiveTo,p_expected_version:expectedVersion},commissionRuleSchema);
      if(row.organization_id!==organizationId||row.id!==ruleId)throw new ApiFailure(503,UNAVAILABLE);return row;
    },
    async previewCommissionSettlement(token:string,organizationId:string,fromDate:string,toDate:string){
      const row=await rest.rpc(token,'preview_staff_commission_settlement',{p_organization_id:organizationId,p_from_date:fromDate,p_to_date:toDate},commissionPreviewSchema);
      if(row.organization_id!==organizationId||row.from_date!==fromDate||row.to_date!==toDate)throw new ApiFailure(503,UNAVAILABLE);return row;
    },
    async assignCommissionAttribution(token:string,organizationId:string,saleLineId:string,input:{staff_id:string;expected_version:number;reason:string;operation_id:string}){
      const row=await rest.rpc(token,'assign_staff_commission_attribution',{p_organization_id:organizationId,p_sale_line_id:saleLineId,p_staff_id:input.staff_id,p_expected_version:input.expected_version,p_reason:input.reason,p_operation_id:input.operation_id},commissionAttributionSchema);
      if(row.organization_id!==organizationId||row.sale_line_id!==saleLineId||row.staff_id!==input.staff_id)throw new ApiFailure(503,UNAVAILABLE);return row;
    },
    async listCommissionAttributionStaff(token:string,organizationId:string){
      const rows=await rest.rpc(token,'list_staff_commission_attribution_staff',{p_organization_id:organizationId},z.array(commissionStaffSchema));
      if(rows.some(row=>row.organization_id!==organizationId||!row.is_active))throw new ApiFailure(503,UNAVAILABLE);return rows;
    },
    async confirmCommissionSettlement(token:string,organizationId:string,fromDate:string,toDate:string,operationId:string){
      const row=await rest.rpc(token,'confirm_staff_commission_settlement',{p_organization_id:organizationId,p_from_date:fromDate,p_to_date:toDate,p_operation_id:operationId},commissionSettlementSchema);
      if(row.organization_id!==organizationId||row.from_date!==fromDate||row.to_date!==toDate)throw new ApiFailure(503,UNAVAILABLE);return row;
    },
    async listCommissionSettlements(token:string,organizationId:string){
      const row=await rest.rpc(token,'list_staff_commission_settlements',{p_organization_id:organizationId},z.array(z.object({settlement:z.record(z.string(),z.unknown()),lines:z.array(z.record(z.string(),z.unknown()))})));
      if(row.some(item=>item.settlement.organization_id!==organizationId||item.lines.some(line=>line.organization_id!==organizationId)))throw new ApiFailure(503,UNAVAILABLE);return row;
    },
  };
}
export type ManagementGateway = ReturnType<typeof createManagementGateway>;
