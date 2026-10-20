import { useEffect, useState } from 'react';
import { Modal, confirm } from '@business-assistant/react-ui';
import { useDraftProtection } from '../../app/DraftBoundary';
import type { ApiClient } from '../../api/client';
import { treatmentApi } from './api';
import { errorStatus, localTime, newOperationId } from './logic';
import type { Treatment } from './schemas';
import type { TreatmentContext, VisitLinkInput } from './visitContext';
import { statusLabels } from '../appointments/appointmentRules';

type Props={api:ApiClient;organizationId:string;customerId:string;record:Treatment;preferredAppointmentId?:string;readOnly:boolean;onSaved:(record:Treatment)=>void;onClose:()=>void};
const visitLabels:Record<string,string>={open:'방문 중',checkout_ready:'수납 준비',closed:'종료',canceled:'취소'};
export function TreatmentVisitLink(props:Props){return <LinkContent key={`${props.organizationId}/${props.customerId}/${props.record.id}`} {...props}/>;}
function LinkContent({api,organizationId,customerId,record,preferredAppointmentId,readOnly,onSaved,onClose}:Props){
 const editable=!readOnly && ['draft','in_progress'].includes(record.status);
 const [options,setOptions]=useState<TreatmentContext|null>(null),[load,setLoad]=useState(0),[loading,setLoading]=useState(true);
 const [appointmentId,setAppointmentId]=useState(record.appointment_id??''),[visitId,setVisitId]=useState(record.visit_id??'');
 const [reason,setReason]=useState(''),[message,setMessage]=useState(''),[saving,setSaving]=useState(false),[conflict,setConflict]=useState(false);
 const [pending,setPending]=useState<VisitLinkInput|null>(null);
 const [baseline,setBaseline]=useState({appointmentId:record.appointment_id??'',visitId:record.visit_id??''});
 const dirty=editable && (appointmentId!==baseline.appointmentId || visitId!==baseline.visitId || Boolean(reason) || Boolean(pending));
 useDraftProtection(dirty,saving);
 useEffect(()=>{
  let active=true;setLoading(true);setOptions(null);setMessage('예약·방문을 불러오는 중…');
  void treatmentApi.contextOptions(api,organizationId,customerId).then(result=>{
   if(!active)return;
   if([...result.appointments,...result.visits].some(row=>row.organization_id!==organizationId||row.customer_id!==customerId))throw new Error('scope');
   setOptions(result);setMessage('연결할 예약·기존 방문을 선택하고 사유와 함께 저장하세요.');
   if(!record.appointment_id&&!record.visit_id&&preferredAppointmentId){
    if(result.appointments.some(row=>row.id===preferredAppointmentId&&!['canceled','no_show'].includes(row.status)))setAppointmentId(preferredAppointmentId);
    else setMessage('진입한 예약을 찾을 수 없거나 취소·노쇼 상태입니다. 최신 기록을 확인하세요.');
   }
  }).catch(()=>{if(active){setOptions(null);setMessage('예약·방문을 불러오지 못했습니다. 권한과 연결을 확인한 뒤 다시 시도하세요.');}}).finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[api,organizationId,customerId,preferredAppointmentId,record.appointment_id,record.visit_id,load]);
 async function close(){
  if(saving)return;
  if(dirty&&!await confirm({title:'예약·방문 연결',message:pending?'저장 결과가 아직 확인되지 않았습니다. 같은 요청으로 재시도할 수 있습니다. 닫으시겠습니까?':'저장하지 않은 연결 선택과 사유를 버리고 닫으시겠습니까?',confirmLabel:'닫기',tone:'danger'}))return;
  onClose();
 }
 async function send(input:VisitLinkInput){
  if(saving||!editable)return;setSaving(true);setMessage('연결을 저장하는 중…');
  try{
   const saved=await treatmentApi.linkVisit(api,organizationId,customerId,record.id,input);
   if(saved.organization_id!==organizationId||saved.customer_id!==customerId||saved.id!==record.id)throw new Error('scope');
   setPending(null);setReason('');setBaseline({appointmentId:saved.appointment_id??'',visitId:saved.visit_id??''});onSaved(saved);onClose();
  }catch(error){
   const status=errorStatus(error);
   if(status===409){setPending(null);setConflict(true);setMessage('시술 기록이 변경되었습니다. 입력을 보관한 뒤 닫고 시술 이력을 새로고침하세요.');}
   else if(status===422||status===403||status===404){setPending(null);setMessage('연결 대상·상태 또는 변경 권한을 확인하세요. 입력은 유지됩니다.');}
   else setMessage('저장 결과를 확인하지 못했습니다. 같은 연결 요청 재시도로 중복 없이 확인하세요.');
  }finally{setSaving(false);}
 }
 function save(){
  if(!editable||saving||loading||!options||pending||conflict)return;
  if(!reason.trim()){setMessage('연결·해제 사유를 입력하세요.');return;}
  const a=options.appointments.find(row=>row.id===appointmentId),v=options.visits.find(row=>row.id===visitId);
  if((appointmentId&&(!a||['canceled','no_show'].includes(a.status)))||(visitId&&(!v||v.status==='canceled'||v.appointment_id!==(appointmentId||null)))){setMessage('예약과 방문의 고객·상태·연결 조합을 확인하세요.');return;}
  const input={appointment_id:appointmentId||null,visit_id:visitId||null,expected_version:record.version,operation_id:newOperationId(),reason:reason.trim()};
  setPending(input);void send(input);
 }
 const disabled=!editable||loading||saving||Boolean(pending)||conflict||!options;
 const visits=options?.visits.filter(row=>row.appointment_id===(appointmentId||null))??[];
 return <Modal title="시술 예약·방문 연결" size="lg" onClose={()=>void close()}><div className="treatment-dialog">
  <p className="muted">선택한 시술: {record.treatment_name} · {record.treatment_date}. 기존 예약·방문에 연결하며 시술일·서비스·금액은 그대로 보존합니다.</p>
  <p className="muted">현재 예약 ID: {record.appointment_id||'미연결'} · 방문 ID: {record.visit_id||'미연결'}</p>
  <label>연결 예약<select aria-label="연결 예약" disabled={disabled} value={appointmentId} onChange={event=>{setAppointmentId(event.target.value);setVisitId('');}}>
   <option value="">예약 미연결 · 워크인</option>
   {options?.appointments.map(row=><option key={row.id} value={row.id} disabled={['canceled','no_show'].includes(row.status)}>{localTime(row.start_at)} · {row.service_name_snapshot} · {statusLabels[row.status]}</option>)}
   {appointmentId&&options&&!options.appointments.some(row=>row.id===appointmentId)&&<option value={appointmentId}>기존 예약 · 선택지에서 확인 불가</option>}
  </select></label>
  <label>연결 방문<select aria-label="연결 방문" disabled={disabled} value={visitId} onChange={event=>setVisitId(event.target.value)}>
   <option value="">방문 미연결</option>
   {visits.map(row=><option key={row.id} value={row.id} disabled={row.status==='canceled'}>{localTime(row.opened_at)} · {visitLabels[row.status]} · {row.id}</option>)}
   {visitId&&options&&!visits.some(row=>row.id===visitId)&&<option value={visitId}>기존 방문 · 선택지에서 확인 불가</option>}
  </select></label>
  {editable&&<label>연결·해제 사유<textarea aria-label="연결·해제 사유" value={reason} maxLength={2000} disabled={disabled} onChange={event=>setReason(event.target.value)}/></label>}
  {!editable&&<p className="muted">조회 전용입니다. 완료·중단 기록의 연결은 보존합니다.</p>}
  <p role="status">{message}</p>
  <div className="ba-actions">
   <button type="button" disabled={saving||Boolean(pending)||dirty} onClick={()=>setLoad(value=>value+1)}>선택지 다시 불러오기</button>
   {editable&&<button type="button" disabled={disabled} onClick={save}>연결 저장</button>}
   {pending&&<button type="button" disabled={saving} onClick={()=>void send(pending)}>같은 연결 요청 재시도</button>}
   <button type="button" disabled={saving} onClick={()=>void close()}>닫기</button>
  </div>
 </div></Modal>;
}
