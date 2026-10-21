import { z } from 'zod';
import type { ApiClient } from '../../api/client';

const snapshotSchema=z.object({
  id:z.uuid(),organization_id:z.uuid(),from_date:z.iso.date(),to_date:z.iso.date(),revision:z.number().int().positive(),
  result:z.object({organization_id:z.uuid(),from_date:z.iso.date(),to_date:z.iso.date(),operating_profit_after_recorded_tax:z.string(),is_final_profit:z.literal(true)}).passthrough(),
  reason:z.string().max(500),confirmed_by:z.uuid(),confirmed_at:z.string(),
});
export type ProfitSnapshot=z.infer<typeof snapshotSchema>;
const snapshotsSchema=z.array(snapshotSchema);
const base=(organizationId:string)=>`/organizations/${organizationId}/management-profit-finalizations`;

export const profitApi={
  list:(api:Pick<ApiClient,'call'>,organizationId:string,fromDate:string,toDate:string)=>api.call('GET',`${base(organizationId)}?from_date=${fromDate}&to_date=${toDate}`,snapshotsSchema),
  finalize:(api:Pick<ApiClient,'call'>,organizationId:string,input:{from_date:string;to_date:string;operation_id:string;confirmed_complete:true;reason:string})=>api.call('POST',base(organizationId),snapshotSchema,input),
};
