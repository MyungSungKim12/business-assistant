import { useEffect,useState } from 'react';
import { z } from 'zod';
import type { ApiClient } from '../../api/client';
import { statusLabel } from './appointmentRules';

const status=z.enum(['reserved','confirmed','checked_in','completed','canceled','no_show']);
const eventsSchema=z.array(z.object({id:z.uuid(),organization_id:z.uuid(),appointment_id:z.uuid(),appointment_version:z.number().int().min(2),previous_status:status,next_status:status,reason:z.string().max(1000).nullable(),actor_id:z.uuid(),occurred_at:z.iso.datetime({offset:true})}));
type Events=z.infer<typeof eventsSchema>;
export function AppointmentStatusHistory({api,organizationId,appointmentId,version}:{api:Pick<ApiClient,'call'>;organizationId:string;appointmentId:string;version:number}){
 const [nonce,setNonce]=useState(0);
 const key=JSON.stringify([organizationId,appointmentId,version,nonce]);
 const [state,setState]=useState<{key:string;rows:Events|null}|null>(null);
 useEffect(()=>{
  let alive=true;
  void (async()=>{
   try{
    const rows=eventsSchema.parse(await api.call('GET',`/organizations/${organizationId}/appointments/${appointmentId}/status-events`,eventsSchema));
    if(new Set(rows.map(row=>row.id)).size!==rows.length||rows.some((row,index)=>row.organization_id!==organizationId||row.appointment_id!==appointmentId||(index>0&&row.appointment_version<=rows[index-1].appointment_version)))throw new Error('Invalid appointment history');
    if(alive)setState({key,rows});
   }catch{if(alive)setState({key,rows:null});}
  })();
  return()=>{alive=false;};
 },[api,key,organizationId,appointmentId]);
 const current=state?.key===key?state:null;
 return <section aria-label="예약 상태 변경 이력"><h3>상태 변경 이력</h3>
  {!current?<p className="muted">상태 변경 이력을 확인하는 중…</p>:current.rows===null?<p className="muted">상태 변경 이력을 불러오지 못했습니다. SQL 062 적용과 권한을 확인하세요. <button type="button" onClick={()=>setNonce(n=>n+1)}>이력 다시 확인</button></p>:current.rows.length===0?<p className="muted">저장된 상태 변경 이력이 없습니다. SQL 062 적용 이후 변경부터 기록됩니다.</p>:<ol>{current.rows.map(event=><li key={event.id}>
   <strong>{statusLabel(event.previous_status)} → {statusLabel(event.next_status)}</strong>
   <div>{new Date(event.occurred_at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})} · 예약 버전 {event.appointment_version}</div>
   {event.reason&&<p>{event.reason}</p>}<small className="muted">변경자 ID: {event.actor_id}</small>
  </li>)}</ol>}
 </section>;
}
