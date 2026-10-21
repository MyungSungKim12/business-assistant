import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiFailure } from '../../errors.js';
import { bearerToken } from '../../routes/organizations.js';
import type { OrgAccess } from '../catalog/routes.js';
import type { ManagementGateway } from './gateway.js';

const query = z.object({ from_date: z.iso.date(), to_date: z.iso.date() });
const ruleInput=z.object({staff_id:z.uuid().nullable(),commission_scope:z.enum(['service','product','membership']),service_id:z.uuid().nullable(),product_id:z.uuid().nullable(),rate_basis_points:z.number().int().min(0).max(10000),effective_from:z.iso.date(),effective_to:z.iso.date().nullable()}).strict();
const endRuleInput=z.object({effective_to:z.iso.date(),expected_version:z.number().int().positive()}).strict();
const settlementInput=z.object({from_date:z.iso.date(),to_date:z.iso.date(),operation_id:z.uuid().optional()}).strict();
const attributionInput=z.object({staff_id:z.uuid(),expected_version:z.number().int().min(0),reason:z.string().trim().min(1).max(500),operation_id:z.uuid()}).strict();
const profitFinalizationInput=z.object({from_date:z.iso.date(),to_date:z.iso.date(),operation_id:z.uuid(),confirmed_complete:z.literal(true),reason:z.string().max(500).default('')}).strict();
const DAY = 86_400_000;

/** 관리 미리보기(Python api/management.py): finance.basic 기능 + 관리자(owner/admin)만. 기간은 최대 366일. */
export function registerManagementRoutes(app: FastifyInstance, organizations: OrgAccess | undefined, gateway: ManagementGateway | undefined): void {
  app.get('/api/v1/organizations/:organizationId/management-preview', async (request) => {
    const token = bearerToken(request);
    const params = z.object({ organizationId: z.uuid() }).safeParse(request.params);
    if (!params.success) throw new ApiFailure(422, 'Invalid organization ID');
    const period = query.safeParse(request.query);
    if (!period.success) throw new ApiFailure(422, 'Invalid report period');
    const days = (Date.parse(period.data.to_date) - Date.parse(period.data.from_date)) / DAY;
    if (days < 0 || days > 366) throw new ApiFailure(422, 'Invalid report period');
    if (!organizations || !gateway) throw new ApiFailure(503, 'Management service unavailable');
    await organizations.requireAccess(token, params.data.organizationId, 'finance.basic', true);
    return gateway.getPreview(token, params.data.organizationId, period.data.from_date, period.data.to_date);
  });
  app.get('/api/v1/organizations/:organizationId/management-profit-finalizations',async request=>{
    const token=bearerToken(request),params=z.object({organizationId:z.uuid()}).safeParse(request.params),period=query.safeParse(request.query);
    if(!params.success)throw new ApiFailure(422,'Invalid organization ID');if(!period.success)throw new ApiFailure(422,'Invalid management profit period');if(!organizations||!gateway)throw new ApiFailure(503,'Management service unavailable');
    const days=(Date.parse(period.data.to_date)-Date.parse(period.data.from_date))/DAY;if(days<0||days>366||period.data.to_date>=new Date().toISOString().slice(0,10))throw new ApiFailure(422,'Invalid management profit period');
    await organizations.requireAccess(token,params.data.organizationId,'finance.basic',true);
    return gateway.listProfitFinalizations(token,params.data.organizationId,period.data.from_date,period.data.to_date);
  });
  app.post('/api/v1/organizations/:organizationId/management-profit-finalizations',async request=>{
    const token=bearerToken(request),params=z.object({organizationId:z.uuid()}).safeParse(request.params),input=profitFinalizationInput.safeParse(request.body);
    if(!params.success)throw new ApiFailure(422,'Invalid organization ID');if(!input.success)throw new ApiFailure(422,'Invalid management profit confirmation');if(!organizations||!gateway)throw new ApiFailure(503,'Management service unavailable');
    const days=(Date.parse(input.data.to_date)-Date.parse(input.data.from_date))/DAY;if(days<0||days>366||input.data.to_date>=new Date().toISOString().slice(0,10))throw new ApiFailure(422,'Invalid management profit period');
    await organizations.requireAccess(token,params.data.organizationId,'finance.basic',true);
    return gateway.finalizeProfit(token,params.data.organizationId,input.data);
  });
  app.get('/api/v1/organizations/:organizationId/staff-commission-rules',async request=>{
    const token=bearerToken(request),params=z.object({organizationId:z.uuid()}).safeParse(request.params);
    if(!params.success)throw new ApiFailure(422,'Invalid organization ID');if(!organizations||!gateway)throw new ApiFailure(503,'Management service unavailable');
    await organizations.requireAccess(token,params.data.organizationId,'finance.basic',true);return gateway.listCommissionRules(token,params.data.organizationId);
  });
  app.post('/api/v1/organizations/:organizationId/staff-commission-rules',async request=>{
    const token=bearerToken(request),params=z.object({organizationId:z.uuid()}).safeParse(request.params),input=ruleInput.safeParse(request.body);
    if(!params.success)throw new ApiFailure(422,'Invalid organization ID');if(!input.success)throw new ApiFailure(422,'Invalid commission rule');if(!organizations||!gateway)throw new ApiFailure(503,'Management service unavailable');
    await organizations.requireAccess(token,params.data.organizationId,'finance.basic',true);return gateway.createCommissionRule(token,params.data.organizationId,input.data);
  });
  app.post('/api/v1/organizations/:organizationId/staff-commission-rules/:ruleId/end',async request=>{
    const token=bearerToken(request),params=z.object({organizationId:z.uuid(),ruleId:z.uuid()}).safeParse(request.params),input=endRuleInput.safeParse(request.body);
    if(!params.success)throw new ApiFailure(422,'Invalid rule ID');if(!input.success)throw new ApiFailure(422,'Invalid rule end date');if(!organizations||!gateway)throw new ApiFailure(503,'Management service unavailable');
    await organizations.requireAccess(token,params.data.organizationId,'finance.basic',true);return gateway.endCommissionRule(token,params.data.organizationId,params.data.ruleId,input.data.effective_to,input.data.expected_version);
  });
  app.get('/api/v1/organizations/:organizationId/staff-commission-settlements',async request=>{
    const token=bearerToken(request),params=z.object({organizationId:z.uuid()}).safeParse(request.params);
    if(!params.success)throw new ApiFailure(422,'Invalid organization ID');if(!organizations||!gateway)throw new ApiFailure(503,'Management service unavailable');
    await organizations.requireAccess(token,params.data.organizationId,'finance.basic',false);return gateway.listCommissionSettlements(token,params.data.organizationId);
  });
  app.get('/api/v1/organizations/:organizationId/staff-commission-attribution-staff',async request=>{
    const token=bearerToken(request),params=z.object({organizationId:z.uuid()}).safeParse(request.params);
    if(!params.success)throw new ApiFailure(422,'Invalid organization ID');if(!organizations||!gateway)throw new ApiFailure(503,'Management service unavailable');
    await organizations.requireAccess(token,params.data.organizationId,'finance.basic',true);return gateway.listCommissionAttributionStaff(token,params.data.organizationId);
  });
  app.post('/api/v1/organizations/:organizationId/staff-commission-settlements/preview',async request=>{
    const token=bearerToken(request),params=z.object({organizationId:z.uuid()}).safeParse(request.params),input=settlementInput.omit({operation_id:true}).safeParse(request.body);
    if(!params.success)throw new ApiFailure(422,'Invalid organization ID');if(!input.success)throw new ApiFailure(422,'Invalid settlement period');if(!organizations||!gateway)throw new ApiFailure(503,'Management service unavailable');
    await organizations.requireAccess(token,params.data.organizationId,'finance.basic',true);return gateway.previewCommissionSettlement(token,params.data.organizationId,input.data.from_date,input.data.to_date);
  });
  app.patch('/api/v1/organizations/:organizationId/staff-commission-attributions/:saleLineId',async request=>{
    const token=bearerToken(request),params=z.object({organizationId:z.uuid(),saleLineId:z.uuid()}).safeParse(request.params),input=attributionInput.safeParse(request.body);
    if(!params.success)throw new ApiFailure(422,'Invalid commission sale line');if(!input.success)throw new ApiFailure(422,'Invalid commission attribution');if(!organizations||!gateway)throw new ApiFailure(503,'Management service unavailable');
    await organizations.requireAccess(token,params.data.organizationId,'finance.basic',true);
    return gateway.assignCommissionAttribution(token,params.data.organizationId,params.data.saleLineId,input.data);
  });
  app.post('/api/v1/organizations/:organizationId/staff-commission-settlements',async request=>{
    const token=bearerToken(request),params=z.object({organizationId:z.uuid()}).safeParse(request.params),input=settlementInput.safeParse(request.body);
    if(!params.success)throw new ApiFailure(422,'Invalid organization ID');if(!input.success)throw new ApiFailure(422,'Invalid commission settlement');if(!organizations||!gateway)throw new ApiFailure(503,'Management service unavailable');
    await organizations.requireAccess(token,params.data.organizationId,'finance.basic',true);return gateway.confirmCommissionSettlement(token,params.data.organizationId,input.data.from_date,input.data.to_date,input.data.operation_id??crypto.randomUUID());
  });
}
