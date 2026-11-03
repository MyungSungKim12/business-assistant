import {expect,it} from 'vitest';
import {bookingPolicyApi,wholeDayBlock} from './bookingPolicy';
import {fakeApi} from '../appointment-resources/testApi';
it('stores whole-day closures using each local midnight, including 23/25-hour DST dates',()=>{
 expect(wholeDayBlock('2030-01-07','Asia/Seoul','휴무')).toEqual({start_at:'2030-01-06T15:00:00.000Z',end_at:'2030-01-07T15:00:00.000Z',reason:'휴무'});
 const spring=wholeDayBlock('2027-03-14','America/New_York','휴무'),fall=wholeDayBlock('2026-11-01','America/New_York','휴무');
 expect(Date.parse(spring.end_at)-Date.parse(spring.start_at)).toBe(23*3600000);expect(Date.parse(fall.end_at)-Date.parse(fall.start_at)).toBe(25*3600000);
 expect(()=>wholeDayBlock('2030-02-30','Asia/Seoul','')).toThrow();expect(()=>wholeDayBlock('2030-01-07','Invalid/Zone','')).toThrow();
});
it('refuses a different organization in successful API responses',async()=>{
 const {api}=fakeApi(()=>({organization_id:'22222222-2222-4222-8222-222222222222',version:0,enabled:false,timezone_name:'Asia/Seoul',minimum_notice_minutes:0,same_day_cutoff_time:null,hours:[],blocks:[]}));
 await expect(bookingPolicyApi.get(api,'11111111-1111-4111-8111-111111111111')).rejects.toThrow('organization mismatch');
});
