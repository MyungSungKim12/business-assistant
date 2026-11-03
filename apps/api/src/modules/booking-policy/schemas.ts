import { z } from 'zod';
const clock=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const bookingPolicyInput=z.object({
 enabled:z.boolean(), timezone_name:z.string().min(1).max(100).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}}),
 minimum_notice_minutes:z.number().int().min(0).max(525600), same_day_cutoff_time:clock.nullable(),
 hours:z.array(z.object({weekday:z.number().int().min(1).max(7),start_time:clock,end_time:z.union([clock,z.literal('24:00')])}).strict().refine(h=>h.start_time<h.end_time)).max(70),
 blocks:z.array(z.object({start_at:z.iso.datetime({offset:true}),end_at:z.iso.datetime({offset:true}),reason:z.string().max(500)}).strict().refine(b=>Date.parse(b.end_at)>Date.parse(b.start_at)&&Date.parse(b.end_at)-Date.parse(b.start_at)<=366*86400000)).max(200),
}).strict();
export const bookingPolicySchema=bookingPolicyInput.extend({organization_id:z.uuid(),version:z.number().int().min(0)});
export const bookingPolicySave= z.object({expected_version:z.number().int().min(0),operation_id:z.uuid(),policy:bookingPolicyInput}).strict();
export type BookingPolicy=z.infer<typeof bookingPolicySchema>;
export type BookingPolicyInput=z.infer<typeof bookingPolicyInput>;
