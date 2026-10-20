import { useEffect, useState } from 'react';
import { z } from 'zod';
import type { ApiClient } from '../../api/client';
import type { Customer } from './types';
import { kstDateKey } from '../appointments/appointmentTime';

export const visitFactSchema=z.object({organization_id:z.uuid(),customer_id:z.uuid(),last_actual_visit_date:z.iso.date().nullable(),next_appointment_at:z.iso.datetime({offset:true}).nullable(),recommended_return_date:z.iso.date().nullable(),as_of:z.iso.datetime({offset:true})});
export type VisitFact=z.infer<typeof visitFactSchema>;
export type VisitFactsState={status:'loading'|'ready'|'error';facts:Map<string,VisitFact>;retry:()=>void};
type Caller=Pick<ApiClient,'call'>;
export async function loadVisitFacts(api:Caller,organizationId:string,ids:string[]):Promise<Map<string,VisitFact>>{
 const unique=[...new Set(ids)],result=new Map<string,VisitFact>();
 const batches=Array.from({length:Math.ceil(unique.length/200)},(_,index)=>unique.slice(index*200,(index+1)*200));
 // 한 고객당 요청을 만들지 않고 최대 세 배치만 동시에 전송한다.
 for(let offset=0;offset<batches.length;offset+=3){
  await Promise.all(batches.slice(offset,offset+3).map(async customerIds=>{
   const rows=z.array(visitFactSchema).parse(await api.call('POST',`/organizations/${organizationId}/customers/visit-facts`,z.array(visitFactSchema),{customer_ids:customerIds}));
   if(rows.length!==customerIds.length||new Set(rows.map(row=>row.customer_id)).size!==rows.length||rows.some(row=>row.organization_id!==organizationId||!customerIds.includes(row.customer_id)))throw new Error('Invalid customer facts');
   for(const row of rows)result.set(row.customer_id,row);
  }));
 }
 return result;
}
export function useVisitFacts(api:Caller,organizationId:string,ids:string[],refreshKey=0):VisitFactsState{
 const [nonce,setNonce]=useState(0);
 const key=JSON.stringify([organizationId,[...new Set(ids)].sort(),refreshKey,nonce]);
 const [state,setState]=useState<{key:string;status:'ready'|'error';facts:Map<string,VisitFact>}|null>(null);
 useEffect(()=>{let alive=true;setState(null);void loadVisitFacts(api,organizationId,ids).then(facts=>{if(alive)setState({key,status:'ready',facts});}).catch(()=>{if(alive)setState({key,status:'error',facts:new Map()});});return()=>{alive=false;};},[api,key]); // eslint-disable-line react-hooks/exhaustive-deps
 return {status:state?.key===key?state.status:'loading',facts:state?.key===key?state.facts:new Map(),retry:()=>setNonce(n=>n+1)};
}
/** 계산용 복사본이다. 폼·선택·프로필 저장에는 이 복사본을 넘기지 않는다. */
export function operationalCustomers(customers:Customer[],facts:Map<string,VisitFact>):Customer[]{
 return customers.flatMap(customer=>{const fact=facts.get(customer.id);return fact?[{...customer,last_visit_date:fact.last_actual_visit_date,next_visit_date:fact.next_appointment_at?kstDateKey(fact.next_appointment_at):null}]:[];});
}
