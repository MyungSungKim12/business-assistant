import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { loadVisitFacts, useVisitFacts, type VisitFact } from './visitFacts';

const org='11111111-1111-4111-8111-111111111111';
const id=(n:number)=>`22222222-2222-4222-8222-${String(n).padStart(12,'0')}`;
const row=(customer_id:string):VisitFact=>({organization_id:org,customer_id,last_actual_visit_date:null,next_appointment_at:null,recommended_return_date:null,as_of:'2026-10-19T01:00:00Z'});

it('고객별 요청 대신 200명 배치·최대 세 동시 요청을 사용한다',async()=>{
 let active=0,peak=0;
 const call=vi.fn(async(_m:string,_p:string,_s:unknown,body:{customer_ids:string[]})=>{
  active++;peak=Math.max(peak,active);
  expect(body.customer_ids.length).toBeLessThanOrEqual(200);
  await new Promise(resolve=>setTimeout(resolve,0));
  active--;return body.customer_ids.map(row);
 });
 const ids=Array.from({length:801},(_,n)=>id(n));
 const result=await loadVisitFacts({call} as never,org,[...ids,ids[0]]);
 expect(result.size).toBe(801);expect(call).toHaveBeenCalledTimes(5);expect(peak).toBe(3);
});

it('고객 전환의 늦은 결과를 무시하고 실패 후 재시도한다',async()=>{
 let resolveOld!:(value:VisitFact[])=>void;
 const call=vi.fn().mockImplementationOnce(()=>new Promise<VisitFact[]>(resolve=>{resolveOld=resolve;}))
  .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([row(id(2))]);
 const api={call} as never;
 const {result,rerender}=renderHook(({customer})=>useVisitFacts(api,org,[customer]),{initialProps:{customer:id(1)}});
 rerender({customer:id(2)});
 await waitFor(()=>expect(result.current.status).toBe('error'));
 await act(async()=>{resolveOld([row(id(1))]);});
 expect(result.current.facts.size).toBe(0);
 act(()=>result.current.retry());
 await waitFor(()=>expect(result.current.status).toBe('ready'));
 expect([...result.current.facts.keys()]).toEqual([id(2)]);
});
