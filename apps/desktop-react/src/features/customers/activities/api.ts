import type { ApiClient } from '../../../api/client';
export type ActivityInput={activity_type:string;title:string;description:string;occurred_at:string|null};
export const activityKeys={detail:(organizationId:string,customerId:string)=>['organizations',organizationId,'customers',customerId,'activities'] as const};
export const activityApi={list:(api:ApiClient,o:string,c:string)=>api.listCustomerActivities(o,c),create:(api:ApiClient,o:string,c:string,input:ActivityInput)=>api.createCustomerActivity(o,c,input),remove:(api:ApiClient,o:string,c:string,id:string)=>api.deleteCustomerActivity(o,c,id)};
