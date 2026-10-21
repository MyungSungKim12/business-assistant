import { useState } from 'react';
import { Modal,Select } from '@business-assistant/react-ui';
import { z } from 'zod';
import type { ApiClient } from '../../api/client';

const searchResult=z.object({service_id:z.string(),from_date:z.string(),to_date:z.string(),step_minutes:z.number(),advisory:z.string(),recommendations:z.array(z.object({date:z.string(),start:z.string(),start_at:z.string(),end_at:z.string(),staff_ids:z.array(z.string()),available_staff_count:z.number(),duration_minutes:z.number(),buffer_minutes:z.number(),required_resources:z.array(z.object({kind:z.enum(['room','equipment']),quantity:z.number()})),reason:z.string()}))});
type Result=z.infer<typeof searchResult>['recommendations'][number];
export function AvailabilitySearch({api,organizationId,serviceId,staffId,resourceIds,excludeAppointmentId,startDate,staff,onPick}:{api:ApiClient;organizationId:string;serviceId:string;staffId:string;resourceIds:string[];excludeAppointmentId?:string;startDate:string;staff:Array<{id:string;name:string}>;onPick:(date:string,time:string,staffId:string)=>void}){
 const [open,setOpen]=useState(false),[from,setFrom]=useState(startDate),[days,setDays]=useState<'7'|'14'>('7'),[rows,setRows]=useState<Result[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[searched,setSearched]=useState(false);
 async function search(){if(busy)return;setBusy(true);setError('');setSearched(false);try{const p=new URLSearchParams({service_id:serviceId,from_date:from,days});if(staffId)p.set('staff_id',staffId);if(resourceIds.length)p.set('resource_ids',[...resourceIds].sort().join(','));if(excludeAppointmentId)p.set('exclude_appointment_id',excludeAppointmentId);const result=await api.call('GET',`/organizations/${organizationId}/appointment-availability-search?${p}`,searchResult);if(result.service_id!==serviceId||result.from_date!==from)throw new Error('Invalid availability response');setRows(result.recommendations);setSearched(true);}catch{setError('빈 시간을 찾지 못했습니다. 근무·휴무 및 자원 기준을 확인하고 다시 시도하세요.');}finally{setBusy(false);}}
 return <>
  <button type="button" className="apt-form__availability-search" disabled={!serviceId} onClick={()=>{setFrom(startDate);setOpen(true);}}>빈 시간 추천</button>
  {open&&<Modal title="빈 시간 추천" size="lg" onClose={()=>!busy&&setOpen(false)}>
   <p className="muted">선택한 시술의 소요 시간·여유, 담당자 근무·휴무, 기존 예약과 필수 공간·장비를 함께 확인합니다. 저장 시 충돌을 다시 검사합니다.</p>
   <div className="inline-form"><label>검색 시작일<input aria-label="추천 시작일" type="date" value={from} onChange={e=>{const value=e.currentTarget.value;setFrom(value);}}/></label><label>검색 기간<Select<'7'|'14'> aria-label="추천 검색 기간" value={days} onChange={setDays} options={[{value:'7',label:'7일'},{value:'14',label:'14일'}]}/></label><button type="button" disabled={busy||!from} onClick={()=>void search()}>{busy?'찾는 중…':'추천 찾기'}</button></div>
   {error&&<p role="alert" className="form-error">{error}</p>}
   {searched&&!rows.length&&<p className="empty-state">선택한 기간에 모든 조건을 만족하는 시간이 없습니다. 기간을 늘리거나 담당자·공간·장비 조건을 바꿔 보세요.</p>}
   <div className="apt-availability-search__results" aria-label="추천 시간 목록">{rows.map(row=>{const staffNames=row.staff_ids.map(id=>staff.find(x=>x.id===id)?.name??'담당자').join(', ');const resourceText=row.required_resources.length?row.required_resources.map(item=>`${item.kind==='room'?'공간':'장비'} ${item.quantity}개`).join(' · '):'없음';return <button type="button" key={`${row.start_at}:${row.staff_ids.join(',')}`} disabled={busy} onClick={()=>{const chosen=staffId&&row.staff_ids.includes(staffId)?staffId:row.staff_ids[0]??'';onPick(row.date,row.start,chosen);setOpen(false);}}><strong>{row.date} · {row.start}</strong><span>{staffNames} · {row.duration_minutes}분 시술{row.buffer_minutes?` + ${row.buffer_minutes}분 여유`:''}</span><small>필수 자원 조건 통과: {resourceText}</small><small>{row.reason}</small></button>;})}</div>
  </Modal>}
 </>;
}
