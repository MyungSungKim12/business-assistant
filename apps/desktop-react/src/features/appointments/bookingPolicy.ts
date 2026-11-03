import {z} from 'zod';
import type {CallApi} from '../appointment-resources/api';
import {addDays,isDateKey} from './appointmentTime';
const clock=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const bookingPolicyValues=z.object({
 enabled:z.boolean(),timezone_name:z.string().min(1).max(100).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}}),
 minimum_notice_minutes:z.number().int().min(0).max(525600),same_day_cutoff_time:clock.nullable(),
 hours:z.array(z.object({weekday:z.number().int().min(1).max(7),start_time:clock,end_time:z.union([clock,z.literal('24:00')])}).refine(h=>h.start_time<h.end_time)).max(70),
 blocks:z.array(z.object({start_at:z.iso.datetime({offset:true}),end_at:z.iso.datetime({offset:true}),reason:z.string().max(500)}).refine(b=>Date.parse(b.end_at)>Date.parse(b.start_at)&&Date.parse(b.end_at)-Date.parse(b.start_at)<=366*86400000)).max(200),
});
export const bookingPolicySchema=bookingPolicyValues.extend({organization_id:z.uuid(),version:z.number().int().min(0)});
export type BookingPolicy=z.infer<typeof bookingPolicySchema>;
export type BookingPolicyValues=z.infer<typeof bookingPolicyValues>;
const path=(org:string)=>`/organizations/${org}/booking-policy`;
function scoped(row:BookingPolicy,org:string){if(row.organization_id!==org)throw new Error('Booking policy organization mismatch');return row;}
export const bookingPolicyApi={
 get:async(api:CallApi,org:string)=>scoped(await api.call('GET',path(org),bookingPolicySchema),org),
 save:async(api:CallApi,org:string,input:{policy:BookingPolicyValues;expected_version:number;operation_id:string})=>scoped(await api.call('PUT',path(org),bookingPolicySchema,input),org),
};
/** Convert each midnight separately, so a daylight-saving closure may be 23 or 25 hours. */
export function wholeDayBlock(date:string,timeZone:string,reason:string){
 if(!isDateKey(date))throw new Error('Invalid closure date');
 const formatter=new Intl.DateTimeFormat('en-CA',{timeZone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
 const midnight=(day:string)=>{
  const target=Date.parse(`${day}T00:00:00Z`);let candidate=target;
  for(let n=0;n<5;n++){
   const parts:Record<string,string>={};formatter.formatToParts(new Date(candidate)).forEach(p=>{parts[p.type]=p.value;});
   const local=Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`),delta=target-local;
   if(delta===0)return new Date(candidate).toISOString();candidate+=delta;
  }
  throw new Error('Local midnight does not exist in this timezone');
 };
 return {start_at:midnight(date),end_at:midnight(addDays(date,1)),reason};
}
