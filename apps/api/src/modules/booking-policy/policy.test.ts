import { expect, it } from 'vitest';
import { bookingPolicyBlock } from './policy.js';
import type {BookingPolicyInput} from './schemas.js';
const policy:BookingPolicyInput = { enabled:true, timezone_name:'Asia/Seoul', minimum_notice_minutes:0, same_day_cutoff_time:null, hours:[{weekday:1,start_time:'09:00',end_time:'12:00'},{weekday:1,start_time:'13:00',end_time:'24:00'}], blocks:[] };
const now=new Date('2026-11-02T00:00:00Z');
const check=(start:string,end:string,p=policy,n=now)=>bookingPolicyBlock(p,Date.parse(start),Date.parse(end),n);
it('preserves disabled defaults and covers the full occupied interval including lunch and midnight',()=>{
 expect(check('2026-11-02T11:00+09:00','2026-11-02T12:00+09:00')).toBeNull();
 expect(check('2026-11-02T11:00+09:00','2026-11-02T12:01+09:00')).toBe('booking_policy_hours');
 expect(check('2026-11-02T23:00+09:00','2026-11-03T00:00+09:00')).toBeNull();
 expect(check('2026-11-02T23:00+09:00','2026-11-03T00:01+09:00')).toBe('booking_policy_hours');
 expect(check('2026-11-03T11:00+09:00','2026-11-03T12:00+09:00')).toBe('booking_policy_hours');
 expect(check('2026-11-03T11:00+09:00','2026-11-03T12:00+09:00',{...policy,enabled:false})).toBeNull();
});
it('uses intake time for cutoff and minimum notice, local timezone dates, and half open blocks',()=>{
 expect(check('2026-11-02T11:00+09:00','2026-11-02T12:00+09:00',{...policy,same_day_cutoff_time:'09:00'} as typeof policy)).toBe('booking_policy_cutoff');
 expect(check('2026-11-09T11:00+09:00','2026-11-09T12:00+09:00',{...policy,same_day_cutoff_time:'09:00'} as typeof policy)).toBeNull();
 expect(check('2026-11-02T09:30+09:00','2026-11-02T10:30+09:00',{...policy,minimum_notice_minutes:31})).toBe('booking_policy_notice');
 const blocked={...policy,blocks:[{start_at:'2026-11-02T10:00+09:00',end_at:'2026-11-02T11:00+09:00',reason:'휴무'}]} as typeof policy;
 expect(check('2026-11-02T09:00+09:00','2026-11-02T10:00+09:00',blocked)).toBeNull();
 expect(check('2026-11-02T10:59+09:00','2026-11-02T12:00+09:00',blocked)).toBe('booking_policy_block');
 expect(check('2026-11-02T11:00+09:00','2026-11-02T12:00+09:00',blocked)).toBeNull();
 expect(check('2026-11-03T00:00+09:00','2026-11-03T01:00+09:00',{...policy,timezone_name:'America/New_York'})).toBeNull();
});
it('uses absolute opening/closing boundaries during a DST fold rather than accepting a reversed wall-clock interval',()=>{
 const sunday={...policy,timezone_name:'America/New_York',hours:[{weekday:7,start_time:'01:30',end_time:'02:30'}]};
 expect(check('2026-11-01T01:45:00-04:00','2026-11-01T01:15:00-05:00',sunday,new Date('2026-10-01T00:00Z'))).toBe('booking_policy_timezone_transition');
 expect(check('2026-11-01T01:45:00-05:00','2026-11-01T02:15:00-05:00',sunday,new Date('2026-10-01T00:00Z'))).toBeNull();
 expect(check('2026-11-01T01:45:00-04:00','2026-11-01T01:00:00-05:00',sunday,new Date('2026-10-01T00:00Z'))).toBeNull();
 const spring={...sunday,hours:[{weekday:7,start_time:'01:00',end_time:'04:00'}]};
 expect(check('2027-03-14T01:30:00-05:00','2027-03-14T03:30:00-04:00',spring,new Date('2026-10-01T00:00Z'))).toBe('booking_policy_timezone_transition');
 expect(check('2027-03-14T01:30:00-05:00','2027-03-14T03:00:00-04:00',spring,new Date('2026-10-01T00:00Z'))).toBeNull();
});
