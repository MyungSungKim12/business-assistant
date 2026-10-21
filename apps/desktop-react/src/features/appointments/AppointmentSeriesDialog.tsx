import { useEffect, useRef, useState } from 'react';
import { confirm, Modal, notify } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { appointmentSchema, type AppointmentService, type AppointmentStaff, type Customer } from '../../api/schemas';
import { z } from 'zod';
import { todayKstKey, kstDateKey } from './appointmentTime';
import type { AppointmentResource } from '../appointment-resources';

const detail=z.object({series:z.object({id:z.uuid(),organization_id:z.uuid(),customer_id:z.uuid(),staff_id:z.uuid(),service_id:z.uuid(),frequency:z.enum(['weekly','monthly']),interval_count:z.number().int(),occurrence_count:z.number().int(),resource_ids:z.array(z.uuid()).default([]),created_at:z.string(),result_snapshot:z.unknown().nullable()}),occurrences:z.array(z.object({occurrence_number:z.number().int(),scheduled_start_at:z.string(),is_exception:z.boolean(),appointment:appointmentSchema})),exceptions:z.array(z.object({organization_id:z.uuid(),series_id:z.uuid(),exception_date:z.iso.date(),reason:z.string(),created_at:z.string()}))});
const details=z.array(detail);
const labels={weekly:'매주',monthly:'매월'};
const statusLabels:Record<string,string>={reserved:'예약',confirmed:'확정',checked_in:'방문',completed:'완료',canceled:'취소',no_show:'노쇼'};
const dateTime=(value:string)=>new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
const localDateTime=(value:string)=>{const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(value?new Date(value):new Date()).replace(' ','T');return parts;};

export function AppointmentSeriesDialog({api,organizationId,customers,staff,services,resources,canManage,onClose}:{api:ApiClient;organizationId:string;customers:Customer[];staff:AppointmentStaff[];services:AppointmentService[];resources:AppointmentResource[];canManage:boolean;onClose:()=>void}){
 const [rows,setRows]=useState<z.infer<typeof details>>([]),[selected,setSelected]=useState(''),[busy,setBusy]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState(''),[fromDate,setFromDate]=useState(todayKstKey()),[reason,setReason]=useState('정기 예약 일정 종료');
 const cancelOperation=useRef({fingerprint:'',id:''}),updateOperation=useRef({fingerprint:'',id:''}),scheduleOperation=useRef({fingerprint:'',id:''});
 const [editStaff,setEditStaff]=useState(''),[editService,setEditService]=useState('');
 const [scheduleFromNumber,setScheduleFromNumber]=useState(1),[scheduleStart,setScheduleStart]=useState(''),[scheduleFrequency,setScheduleFrequency]=useState<'weekly'|'monthly'>('weekly'),[scheduleInterval,setScheduleInterval]=useState('1'),[scheduleResources,setScheduleResources]=useState<string[]>([]);
 useEffect(()=>{let active=true;void api.call('GET',`/organizations/${organizationId}/appointment-series?limit=100`,details).then(value=>{if(active){setRows(value);setSelected(value[0]?.series.id??'')}}).catch(()=>{if(active)setError('반복 예약 목록을 불러오지 못했습니다. 다시 열어 재시도해 주세요.')}).finally(()=>{if(active)setBusy(false)});return()=>{active=false}},[api,organizationId]);
 const current=rows.find(row=>row.series.id===selected);
 useEffect(()=>{if(current){setEditStaff(current.series.staff_id);setEditService(current.series.service_id);setScheduleFrequency(current.series.frequency);setScheduleInterval(String(current.series.interval_count));setScheduleResources(current.series.resource_ids);const next=current.occurrences.find(item=>!item.is_exception&&['reserved','confirmed'].includes(item.appointment.status)&&kstDateKey(item.appointment.start_at)>=todayKstKey());if(next){setScheduleFromNumber(next.occurrence_number);setScheduleStart(localDateTime(next.appointment.start_at))}}},[current?.series.id]);
 const updatable=current?.occurrences.filter(item=>!item.is_exception&&['reserved','confirmed'].includes(item.appointment.status)&&kstDateKey(item.appointment.start_at)>=todayKstKey())??[];
 const cancelable=current?.occurrences.filter(item=>['reserved','confirmed'].includes(item.appointment.status)&&kstDateKey(item.appointment.start_at)>=fromDate)??[];
 async function updateFuture(){
  if(!current||!canManage||!updatable.length||!editStaff||!editService||saving)return;
  if(!await confirm({title:'반복 예약의 미래 기본 회차 변경',message:`개별 변경이 없는 미래 예약 ${updatable.length}건의 담당자와 시술을 변경합니다. 개별 변경·취소·방문 회차는 유지됩니다. 예약 충돌이 있으면 전체 변경이 저장되지 않습니다.`,confirmLabel:`${updatable.length}건 적용`,cancelLabel:'돌아가기'}))return;
  const fingerprint=JSON.stringify([current.series.id,editStaff,editService]);if(updateOperation.current.fingerprint!==fingerprint)updateOperation.current={fingerprint,id:crypto.randomUUID()};
  setSaving(true);setError('');
  try{
   const saved=await api.call('POST',`/organizations/${organizationId}/appointment-series/${current.series.id}/update-future`,z.object({series_id:z.uuid(),staff_id:z.uuid(),service_id:z.uuid(),updated:z.array(appointmentSchema),replayed:z.boolean()}),{staff_id:editStaff,service_id:editService,operation_id:updateOperation.current.id});
   const latest=await api.call('GET',`/organizations/${organizationId}/appointment-series?limit=100`,details);setRows(latest);setEditStaff(saved.staff_id);setEditService(saved.service_id);notify.success(`미래 반복 예약 ${saved.updated.length}건을 변경했습니다.`);updateOperation.current={fingerprint:'',id:''};
  }catch{setError('미래 회차를 변경하지 못했습니다. 예약 충돌이나 최신 상태 변경이 있을 수 있습니다. 목록을 다시 확인한 뒤 재시도해 주세요.')}finally{setSaving(false)}
 }
 const scheduleTargets=current?.occurrences.filter(item=>item.occurrence_number>=scheduleFromNumber&&!item.is_exception&&['reserved','confirmed'].includes(item.appointment.status)&&kstDateKey(item.appointment.start_at)>=todayKstKey())??[];
 async function rescheduleFuture(){
  const interval=Number(scheduleInterval);
  if(!current||!canManage||!scheduleTargets.length||!scheduleStart||!Number.isInteger(interval)||interval<1||interval>12||saving)return;
  const anchor=current.occurrences.find(item=>item.occurrence_number===scheduleFromNumber);
  if(!anchor)return;
  const targetDate=new Date(`${scheduleStart}:00+09:00`);
  if(!Number.isFinite(targetDate.getTime())||scheduleStart.length<16){setError('새 예약 날짜와 시간을 확인하세요.');return}
  const message=`${dateTime(targetDate.toISOString())}부터 개별 변경이 없는 미래 회차 ${scheduleTargets.length}건의 날짜·주기·자원을 다시 배치합니다. 예약 충돌이 한 건이라도 있으면 전체 변경이 취소됩니다.`;
  if(!await confirm({title:'반복 예약 일정 변경',message,confirmLabel:`${scheduleTargets.length}건 적용`,cancelLabel:'돌아가기'}))return;
  const fingerprint=JSON.stringify([current.series.id,scheduleFromNumber,scheduleStart,scheduleFrequency,interval,scheduleResources]);if(scheduleOperation.current.fingerprint!==fingerprint)scheduleOperation.current={fingerprint,id:crypto.randomUUID()};
  setSaving(true);setError('');
  try{
   const saved=await api.call('POST',`/organizations/${organizationId}/appointment-series/${current.series.id}/reschedule-future`,z.object({series_id:z.uuid(),from_occurrence_number:z.number().int(),start_at:z.string(),frequency:z.enum(['weekly','monthly']),interval_count:z.number().int(),resource_ids:z.array(z.uuid()),updated:z.array(appointmentSchema),replayed:z.boolean()}),{from_occurrence_number:scheduleFromNumber,start_at:targetDate.toISOString(),frequency:scheduleFrequency,interval_count:interval,resource_ids:scheduleResources,operation_id:scheduleOperation.current.id});
   const latest=await api.call('GET',`/organizations/${organizationId}/appointment-series?limit=100`,details);setRows(latest);setScheduleFrequency(saved.frequency);setScheduleInterval(String(saved.interval_count));setScheduleResources(saved.resource_ids);notify.success(`반복 예약 일정 ${saved.updated.length}건을 변경했습니다.`);scheduleOperation.current={fingerprint:'',id:''};
  }catch{setError('반복 예약 일정을 변경하지 못했습니다. 자원·담당자 충돌이나 최신 상태 변경이 있을 수 있습니다. 목록을 다시 확인한 뒤 재시도해 주세요.')}finally{setSaving(false)}
 }
 async function cancelFuture(){
  if(!current||!canManage||!cancelable.length||!reason.trim()||saving)return;
  const message=`${fromDate} 이후 예정된 예약 ${cancelable.length}건을 취소합니다. 진행 중이거나 완료된 회차와 선택 날짜 이전 예약은 유지됩니다.`;
  if(!await confirm({title:'반복 예약의 남은 회차 취소',message:`${message}\n취소 사유: ${reason.trim()}`,confirmLabel:`${cancelable.length}건 취소`,cancelLabel:'돌아가기',tone:'danger'}))return;
  const fingerprint=JSON.stringify([current.series.id,fromDate,reason.trim()]);if(cancelOperation.current.fingerprint!==fingerprint)cancelOperation.current={fingerprint,id:crypto.randomUUID()};
  setSaving(true);setError('');
  try{
   const saved=await api.call('POST',`/organizations/${organizationId}/appointment-series/${current.series.id}/cancel-future`,z.object({series_id:z.uuid(),from_date:z.iso.date(),reason:z.string(),canceled:z.array(appointmentSchema),replayed:z.boolean()}),{from_date:fromDate,reason:reason.trim(),operation_id:cancelOperation.current.id});
   const latest=await api.call('GET',`/organizations/${organizationId}/appointment-series?limit=100`,details);setRows(latest);notify.success(`반복 예약 ${saved.canceled.length}건을 취소했습니다.`);cancelOperation.current={fingerprint:'',id:''};
  }catch{setError('회차를 취소하지 못했습니다. 다른 사용자가 예약을 변경했을 수 있습니다. 다시 불러온 뒤 재시도해 주세요.')}finally{setSaving(false)}
 }
 const name=(id:string,list:Array<{id:string;name:string}>)=>list.find(row=>row.id===id)?.name??'알 수 없음';
 const result=current?.series.result_snapshot as {skipped?:Array<{number:number;date:string;reason:string}>}|null;
 return <Modal title="반복 예약 회차" onClose={onClose} size="lg">
  <div className="apt-series-manager">
   {error&&<p role="alert" className="form-error">{error}</p>}
   {busy?<p role="status" className="muted">반복 예약을 불러오는 중…</p>:rows.length===0?<p className="empty-state">등록된 반복 예약이 없습니다.</p>:<>
    <label>시리즈 선택<select aria-label="반복 예약 선택" value={selected} onChange={event=>setSelected(event.currentTarget.value)}>{rows.map(row=><option key={row.series.id} value={row.series.id}>{name(row.series.customer_id,customers)} · {name(row.series.service_id,services)} · {dateTime(row.occurrences[0]?.scheduled_start_at??row.series.created_at)}</option>)}</select></label>
    {current&&<>
     <p className="muted">{name(current.series.customer_id,customers)} · {name(current.series.service_id,services)} · 담당 {name(current.series.staff_id,staff)} · {labels[current.series.frequency]}{current.series.interval_count>1?` ${current.series.interval_count}${current.series.frequency==='weekly'?'주':'개월'} 간격`:''} · {current.series.occurrence_count}회 예정</p>
     <table aria-label="반복 예약 회차 목록"><thead><tr><th>회차</th><th>현재 예약 일시</th><th>상태</th><th>변경</th></tr></thead><tbody>{current.occurrences.map(item=><tr key={item.appointment.id}><td>{item.occurrence_number}</td><td>{dateTime(item.appointment.start_at)}{item.is_exception&&item.appointment.start_at!==item.scheduled_start_at&&<small>원래 {dateTime(item.scheduled_start_at)}</small>}</td><td>{statusLabels[item.appointment.status]??item.appointment.status}</td><td>{item.is_exception?'개별 변경됨':'시리즈 기본'}</td></tr>)}</tbody></table>
     {result?.skipped?.length? <section><h3>건너뛴 회차</h3><ul>{result.skipped.map(item=><li key={item.number}>#{item.number} · {item.date} · {item.reason==='exception_date'?'예외일':'예약 충돌'}</li>)}</ul></section>:null}
     {current.exceptions.length>0&&<section><h3>예외일</h3><ul>{current.exceptions.map(item=><li key={item.exception_date}>{item.exception_date}{item.reason?` · ${item.reason}`:''}</li>)}</ul></section>}
     <p className="muted">개별 회차 수정은 예약 화면에서 처리합니다. 개별 변경은 해당 회차에만 적용됩니다.</p>
     {canManage&&<fieldset className="apt-series-manager__cancel" disabled={saving}><legend>미래 기본 회차 담당자·시술 변경</legend><label>담당자<select aria-label="시리즈 담당자" value={editStaff} onChange={event=>setEditStaff(event.currentTarget.value)}>{staff.filter(row=>row.is_active).map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label><label>시술<select aria-label="시리즈 시술" value={editService} onChange={event=>setEditService(event.currentTarget.value)}>{services.filter(row=>row.is_active).map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label><p className="muted">오늘 이후 예약·확정 상태이고 개별 변경이 없는 {updatable.length}건에 적용합니다. 시술 소요 시간과 자원 충돌을 다시 확인하며, 하나라도 충돌하면 모두 취소됩니다.</p><button type="button" disabled={!updatable.length||saving} onClick={()=>void updateFuture()}>{saving?'변경 중…':'미래 회차 담당자·시술 변경'}</button></fieldset>}
     {canManage&&<fieldset className="apt-series-manager__cancel" disabled={saving}><legend>미래 회차 날짜·주기·자원 변경</legend><label>적용 시작 회차<select aria-label="일정 변경 시작 회차" value={scheduleFromNumber} onChange={event=>{const number=Number(event.currentTarget.value);setScheduleFromNumber(number);const item=current.occurrences.find(row=>row.occurrence_number===number);if(item)setScheduleStart(localDateTime(item.appointment.start_at))}}>{scheduleTargets.map(item=><option key={item.occurrence_number} value={item.occurrence_number}>{item.occurrence_number}회 · {dateTime(item.appointment.start_at)}</option>)}</select></label><label>새 시작 일시<input aria-label="새 반복 예약 시작 일시" type="datetime-local" value={scheduleStart} onChange={event=>setScheduleStart(event.currentTarget.value)}/></label><label>반복 주기<select aria-label="반복 예약 주기" value={scheduleFrequency} onChange={event=>setScheduleFrequency(event.currentTarget.value as 'weekly'|'monthly')}><option value="weekly">매주</option><option value="monthly">매월</option></select></label><label>간격<input aria-label="반복 간격" type="number" min={1} max={12} value={scheduleInterval} onChange={event=>setScheduleInterval(event.currentTarget.value)}/></label><fieldset className="apt-series-manager__resources"><legend>사용 공간·장비</legend>{resources.filter(row=>row.is_active).length?resources.filter(row=>row.is_active).map(row=><label key={row.id}><input type="checkbox" aria-label={`${row.name} 사용`} checked={scheduleResources.includes(row.id)} onChange={event=>{const checked=event.currentTarget.checked;setScheduleResources(currentIds=>checked?[...currentIds,row.id]:currentIds.filter(id=>id!==row.id))}}/>{row.name} · {row.kind==='room'?'공간':'장비'}</label>):<p className="muted">등록된 공간·장비가 없습니다.</p>}</fieldset><p className="muted">선택한 회차부터 뒤의 개별 변경이 없는 예약·확정 회차에 적용합니다. 회차 번호 간 간격을 반영해 새 주기로 계산하며, 예외·취소·방문 회차는 유지됩니다. 자원과 시간이 충돌하면 전부 롤백합니다.</p><button type="button" disabled={!scheduleTargets.length||!scheduleStart||saving} onClick={()=>void rescheduleFuture()}>{saving?'일정 변경 중…':`미래 일정 ${scheduleTargets.length}건 재배치`}</button></fieldset>}
     {canManage&&<fieldset className="apt-series-manager__cancel" disabled={saving}><legend>남은 회차 일괄 취소</legend><label>취소 시작일<input aria-label="취소 시작일" type="date" value={fromDate} onChange={event=>setFromDate(event.currentTarget.value)}/></label><label>취소 사유<input aria-label="시리즈 취소 사유" maxLength={1000} value={reason} onChange={event=>setReason(event.currentTarget.value)}/></label><p className="muted">현재 예약 날짜가 시작일 이후이고 아직 예약·확정 상태인 회차만 취소합니다. 취소는 원자적으로 처리되며 충돌이나 최신 상태 변경이 발견되면 전체 요청이 취소됩니다.</p><button type="button" className="danger-button" disabled={!cancelable.length||!reason.trim()||saving} onClick={()=>void cancelFuture()}>{saving?'취소 처리 중…':`이후 회차 ${cancelable.length}건 취소`}</button></fieldset>}
    </>}
   </>}
  </div>
 </Modal>;
}
