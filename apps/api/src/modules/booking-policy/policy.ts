import { clockSeconds, zonedParts } from '../appointment-resources/availability.js';
import type { BookingPolicyInput } from './schemas.js';
export type BookingPolicyReason='booking_policy_hours'|'booking_policy_block'|'booking_policy_notice'|'booking_policy_cutoff'|'booking_policy_timezone_transition';
/** SQL102 uses the same local calendar and [start,end) occupied interval, including buffer. */
export function bookingPolicyBlock(policy:BookingPolicyInput,startMs:number,endMs:number,now:Date):BookingPolicyReason|null {
 if(!policy.enabled)return null;
 if(startMs<now.getTime()+policy.minimum_notice_minutes*60000)return 'booking_policy_notice';
 const start=zonedParts(startMs,policy.timezone_name),last=zonedParts(endMs-1,policy.timezone_name),today=zonedParts(now.getTime(),policy.timezone_name);
 if(policy.same_day_cutoff_time&&start.date===today.date&&today.secondOfDay>=clockSeconds(policy.same_day_cutoff_time))return 'booking_policy_cutoff';
 const wallMs=(parts:ReturnType<typeof zonedParts>)=>Date.parse(`${parts.date}T00:00:00Z`)+parts.secondOfDay*1000;
 const offset=(parts:ReturnType<typeof zonedParts>,ms:number)=>wallMs(parts)-Math.floor(ms/1000)*1000;
 // Conservative until ambiguous/nonexistent local-time interval authoring is supported.
 if(offset(start,startMs)!==offset(last,endMs-1))return 'booking_policy_timezone_transition';
 if(!policy.hours.some(h=>h.weekday===start.isoWeekday&&start.date===last.date&&clockSeconds(h.start_time)<=start.secondOfDay&&last.secondOfDay<clockSeconds(h.end_time)))return 'booking_policy_hours';
 if(policy.blocks.some(b=>startMs<Date.parse(b.end_at)&&Date.parse(b.start_at)<endMs))return 'booking_policy_block';
 return null;
}
