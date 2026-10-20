import { act,renderHook } from '@testing-library/react';
import { afterEach,expect,it,vi } from 'vitest';
import { useAvailability } from './AvailabilityChips';
const base={date:'2026-12-14',service_id:'svc',duration_minutes:60,buffer_minutes:0,step_minutes:30,staff:[],required_resources:[],slots:[],advisory:'안내'};
afterEach(()=>vi.useRealTimers());
it('빠른 입력 변경은 250ms 뒤 마지막 조건만 조회한다',async()=>{
 vi.useFakeTimers();const call=vi.fn(async(_method:string,_path:string)=>({...base,date:'2026-12-16'})),api={call} as never;
 const {result,rerender}=renderHook(({date})=>useAvailability(api,'org',{serviceId:'svc',date}),{initialProps:{date:'2026-12-14'}});
 rerender({date:'2026-12-15'});rerender({date:'2026-12-16'});
 expect(call).not.toHaveBeenCalled();
 await act(async()=>{await vi.advanceTimersByTimeAsync(250);});
 expect(call).toHaveBeenCalledTimes(1);expect(call.mock.calls[0]?.[1]).toContain('date=2026-12-16');
 expect(result.current.status).toBe('ready');
});
it('조건/조직 전환 시 기존 결과를 즉시 숨기고 늦은 응답을 버린다',async()=>{
 vi.useFakeTimers();let resolve!:(value:unknown)=>void;
 const call=vi.fn().mockImplementationOnce(()=>new Promise(r=>{resolve=r;})).mockResolvedValue({...base,date:'2026-12-15'}),api={call} as never;
 const {result,rerender}=renderHook(({org,date})=>useAvailability(api,org,{serviceId:'svc',date}),{initialProps:{org:'org',date:'2026-12-14'}});
 await act(async()=>{await vi.advanceTimersByTimeAsync(250);});
 rerender({org:'other',date:'2026-12-15'});expect(result.current.status).toBe('loading');
 await act(async()=>{resolve(base);});expect(result.current.status).toBe('loading');
 await act(async()=>{await vi.advanceTimersByTimeAsync(250);});expect(result.current.status).toBe('ready');
});
it('실패 후 같은 조건을 명시적으로 다시 확인할 수 있다',async()=>{
 vi.useFakeTimers();const call=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(base),api={call} as never;
 const {result}=renderHook(()=>useAvailability(api,'org',{serviceId:'svc',date:base.date}));
 await act(async()=>{await vi.advanceTimersByTimeAsync(250);});expect(result.current.status).toBe('error');
 act(()=>result.current.refresh());expect(result.current.status).toBe('loading');
 await act(async()=>{await vi.advanceTimersByTimeAsync(250);});expect(result.current.status).toBe('ready');
 expect(call).toHaveBeenCalledTimes(2);
});
it('서버가 다른 날짜·서비스의 가능 시간을 돌려주면 표시하지 않는다',async()=>{
 vi.useFakeTimers();const call=vi.fn(async()=>({...base,service_id:'other'})),api={call} as never;
 const {result}=renderHook(()=>useAvailability(api,'org',{serviceId:'svc',date:base.date}));
 await act(async()=>{await vi.advanceTimersByTimeAsync(250);});expect(result.current.status).toBe('error');
});
