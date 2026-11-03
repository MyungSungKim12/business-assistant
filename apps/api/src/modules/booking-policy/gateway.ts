import type { ServerConfig } from '../../config.js';
import { ApiFailure } from '../../errors.js';
import { createRest } from '../../supabase/rest.js';
import { withPgErrorMap } from '../catalog/pgErrors.js';
import { bookingPolicySchema, type BookingPolicyInput } from './schemas.js';
export function createBookingPolicyGateway(config:ServerConfig,fetcher:typeof fetch=fetch){
 const rest=createRest(config,withPgErrorMap(fetcher),'Booking policy unavailable');
 async function rpc(token:string,organizationId:string,name:string,args:Record<string,unknown>={}){
  const row=await rest.rpc(token,name,{p_organization_id:organizationId,...args},bookingPolicySchema);
  if(row.organization_id!==organizationId)throw new ApiFailure(503,'Booking policy unavailable');return row;
 }
 return {getBookingPolicy:(token:string,organizationId:string)=>rpc(token,organizationId,'get_organization_booking_policy'),
  saveBookingPolicy:(token:string,organizationId:string,input:{expected_version:number;operation_id:string;policy:BookingPolicyInput})=>rpc(token,organizationId,'save_organization_booking_policy',{p_expected_version:input.expected_version,p_operation_id:input.operation_id,p_policy:input.policy})};
}
export type BookingPolicyGateway=ReturnType<typeof createBookingPolicyGateway>;
