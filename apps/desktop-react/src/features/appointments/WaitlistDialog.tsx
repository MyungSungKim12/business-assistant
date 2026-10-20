import { useDraftProtection } from '../../app/DraftBoundary';
import { todayKstKey } from './appointmentTime';
import { canStaffDoService, type ServiceStaffMap } from './serviceStaff';
import { AvailabilityChips } from './AvailabilityChips';
import { ResourcePicker, missingRequirements, type ResourceRequirement } from '../appointment-resources';
import { useEffect, useRef, useState } from 'react';
import { Modal, Select, notify, confirm } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { appointmentsSchema, type Appointment } from '../../api/schemas';
import type { AppointmentService, AppointmentStaff, Customer } from '../../api/schemas';
import type { AppointmentResource } from '../appointment-resources';
import { z } from 'zod';

const entry=z.object({id:z.uuid(),organization_id:z.uuid(),customer_id:z.uuid(),service_id:z.uuid(),staff_id:z.uuid().nullable(),preferred_date:z.iso.date().nullable(),note:z.string(),status:z.enum(['waiting','contacted','booked','canceled']),version:z.number().int(),created_at:z.string()});
const entries=z.array(entry);type Entry=z.infer<typeof entry>;
const labels:Record<Entry['status'],string>={waiting:'대기 중',contacted:'연락함',booked:'예약 처리',canceled:'취소'};

export function WaitlistDialog({api,organizationId,customers,staff,services,resources,readOnly,onBooked,onClose,serviceStaff={}}:{api:ApiClient;organizationId:string;customers:Customer[];staff:AppointmentStaff[];services:AppointmentService[];resources:AppointmentResource[];readOnly:boolean;onBooked:(appointment:Appointment)=>void;onClose:()=>void;serviceStaff?:ServiceStaffMap}){
 const [rows,setRows]=useState<Entry[]>([]),[customer,setCustomer]=useState(''),[service,setService]=useState(''),[staffId,setStaffId]=useState(''),[date,setDate]=useState(''),[note,setNote]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[booking,setBooking]=useState<Entry|null>(null),[bookStaff,setBookStaff]=useState(''),[bookDate,setBookDate]=useState(''),[bookTime,setBookTime]=useState('10:00'),[resourceIds,setResourceIds]=useState<string[]>([]);
 const createOperation=useRef(crypto.randomUUID()), createFingerprint=useRef(''), bookingOperation=useRef(crypto.randomUUID()), bookingFingerprint=useRef('');
 const createDirty=Boolean(customer||service||staffId||date||note);
 const [needs,setNeeds]=useState<ResourceRequirement[]>([]);
 useDraftProtection(createDirty||booking!==null,busy);
 const eligible=(serviceId:string)=>staff.filter(person=>canStaffDoService(serviceStaff,serviceId,person.id));
 async function discard(message:string){return await confirm({title:'작성 중인 대기 예약',message,confirmLabel:'버리고 닫기',cancelLabel:'계속 작성'})}
 async function close(){if(busy)return;if((createDirty||booking)&&!(await discard('저장하지 않은 대기·예약 입력을 버리고 닫을까요?')))return;onClose()}
 async function closeBooking(){if(busy)return;if(booking&&!(await discard('예약 전환 입력을 버릴까요?')))return;setBooking(null)}
 async function openBooking(row:Entry){if(busy)return;if((createDirty||booking)&&!(await discard('작성 중인 입력을 버리고 이 고객의 예약을 만들까요?')))return;setCustomer('');setService('');setStaffId('');setDate('');setNote('');setBooking(row);const allowed=eligible(row.service_id);setBookStaff(row.staff_id&&allowed.some(x=>x.id===row.staff_id)?row.staff_id:allowed[0]?.id??'');setBookDate(row.preferred_date??todayKstKey());setBookTime('10:00');setResourceIds([]);setNeeds([]);bookingOperation.current=crypto.randomUUID();bookingFingerprint.current=''}
 const base=`/organizations/${organizationId}/appointment-waitlist`;
 async function load(){try{setRows(await api.call('GET',base,entries));setError('')}catch{setError('대기 목록을 불러오지 못했습니다.')}}
 useEffect(()=>{void load()},[api,organizationId]);
 async function create(){if(busy||readOnly)return;if(!customer||!service){setError('고객과 시술을 선택하세요.');return}const input={customer_id:customer,service_id:service,staff_id:staffId||null,preferred_date:date||null,note};const fingerprint=JSON.stringify(input);if(createFingerprint.current!==fingerprint){createOperation.current=crypto.randomUUID();createFingerprint.current=fingerprint}setBusy(true);try{const saved=await api.call('POST',base,entry,{...input,operation_id:createOperation.current});setRows(old=>[...old.filter(row=>row.id!==saved.id),saved]);createOperation.current=crypto.randomUUID();createFingerprint.current='';setCustomer('');setService('');setStaffId('');setDate('');setNote('');notify.success('대기 고객을 등록했습니다.')}catch{setError('대기 고객을 등록하지 못했습니다. 재시도하면 같은 요청으로 안전하게 처리됩니다.')}finally{setBusy(false)}}
 async function status(row:Entry,next:Entry['status']){if(busy||readOnly)return;setBusy(true);try{const saved=await api.call('PATCH',`${base}/${row.id}`,entry,{status:next,expected_version:row.version});setRows(old=>old.map(item=>item.id===saved.id?saved:item))}catch{setError('상태가 바뀌었거나 저장에 실패했습니다. 목록을 새로고침해 주세요.')}finally{setBusy(false)}}
 async function book(){if(busy||readOnly)return;if(!booking||!bookStaff||!bookDate||!bookTime){setError('예약 담당자와 날짜·시간을 입력하세요.');return}if(!canStaffDoService(serviceStaff,booking.service_id,bookStaff)){setError('이 시술을 맡을 수 있는 담당자를 선택하세요.');return}if(missingRequirements(needs,resources,resourceIds).length){setError('필수 공간·장비를 선택하세요.');return}const input={staff_id:bookStaff,start_at:new Date(`${bookDate}T${bookTime}:00+09:00`).toISOString(),resource_ids:resourceIds,expected_version:booking.version};const fingerprint=JSON.stringify([booking.id,input]);if(bookingFingerprint.current!==fingerprint){bookingOperation.current=crypto.randomUUID();bookingFingerprint.current=fingerprint}setBusy(true);try{const saved=await api.call('POST',`${base}/${booking.id}/book`,z.object({appointment:appointmentsSchema.element,waitlist:entry,replayed:z.boolean()}),{...input,operation_id:bookingOperation.current});setRows(old=>old.map(row=>row.id===saved.waitlist.id?saved.waitlist:row));setBooking(null);bookingOperation.current=crypto.randomUUID();bookingFingerprint.current='';onBooked(saved.appointment);notify.success('대기 고객을 예약으로 전환했습니다.')}catch{setError('예약을 만들지 못했습니다. 시간이 겹치거나 대기 상태가 바뀌었을 수 있습니다. 같은 입력은 중복 없이 재시도됩니다.')}finally{setBusy(false)}}
 const name=(id:string,list:Array<{id:string;name:string}>)=>list.find(x=>x.id===id)?.name??'정보 없음';
 return <Modal title="예약 대기 목록" size="lg" onClose={()=>void close()}><div className="apt-waitlist">
  {error&&<p role="alert" className="form-error">{error}<button type="button" onClick={()=>void load()}>다시 불러오기</button></p>}
  {!readOnly&&<fieldset disabled={busy} className="apt-waitlist__form"><legend>대기 고객 등록</legend>
   <label>고객<Select aria-label="대기 고객" value={customer} onChange={setCustomer} options={[{value:'',label:'고객 선택'},...customers.filter(x=>x.status==='active').map(x=>({value:x.id,label:x.phone?x.name+' · '+x.phone:x.name}))]}/></label>
   <label>희망 시술<Select aria-label="희망 시술" value={service} onChange={value=>{setService(value);if(staffId&&!canStaffDoService(serviceStaff,value,staffId))setStaffId('')}} options={[{value:'',label:'시술 선택'},...services.map(x=>({value:x.id,label:x.name}))]}/></label>
   <label>희망 담당자<Select aria-label="희망 담당자" value={staffId} onChange={setStaffId} options={[{value:'',label:'담당자 무관'},...eligible(service).map(x=>({value:x.id,label:x.name}))]}/></label>
   <label>희망 날짜<input aria-label="희망 날짜" type="date" value={date} onChange={e=>setDate(e.currentTarget.value)}/></label>
   <label className="apt-waitlist__note">메모<input aria-label="대기 메모" maxLength={1000} value={note} onChange={e=>setNote(e.currentTarget.value)}/></label>
   <button type="button" className="primary-button" onClick={()=>void create()}>대기 등록</button>
  </fieldset>}
  <table aria-label="대기 고객 목록"><thead><tr><th>고객</th><th>시술 · 담당</th><th>희망 날짜</th><th>메모</th><th>상태</th><th>예약</th></tr></thead><tbody>{rows.map(row=><tr key={row.id}><td>{name(row.customer_id,customers)}</td><td>{name(row.service_id,services)} · {row.staff_id?name(row.staff_id,staff):'무관'}</td><td>{row.preferred_date??'미정'}</td><td>{row.note||'—'}</td><td>{readOnly?labels[row.status]:<Select<Entry['status']> aria-label={`${name(row.customer_id,customers)} 상태`} value={row.status} disabled={busy||row.status==='booked'} onChange={value=>void status(row,value)} options={Object.entries(labels).map(([value,label])=>({value:value as Entry['status'],label,disabled:value==='booked'}))}/>}</td><td>{!readOnly&&(row.status==='waiting'||row.status==='contacted')&&<button type="button" disabled={busy} onClick={()=>void openBooking(row)}>예약 만들기</button>}</td></tr>)}</tbody></table>
  {booking&&<fieldset className="apt-waitlist__form" disabled={busy}><legend>{name(booking.customer_id,customers)} 예약 만들기</legend><label>담당자<Select aria-label="예약 담당자" value={bookStaff} onChange={setBookStaff} options={[{value:'',label:'담당자 선택'},...eligible(booking.service_id).map(x=>({value:x.id,label:x.name}))]}/></label><label>날짜<input aria-label="예약 날짜" type="date" value={bookDate} onChange={e=>setBookDate(e.currentTarget.value)}/></label><label>시간<input aria-label="예약 시간" type="time" value={bookTime} onChange={e=>setBookTime(e.currentTarget.value)}/></label><ResourcePicker api={api} organizationId={organizationId} serviceId={booking.service_id} value={resourceIds} onChange={setResourceIds} onRequirementsChange={(items)=>setNeeds(items)} autoSelect/><AvailabilityChips api={api} organizationId={organizationId} query={bookDate?{serviceId:booking.service_id,date:bookDate,staffId:bookStaff||undefined,resourceIds}:null} startAt={bookDate&&bookTime?bookDate+'T'+bookTime:''} onPick={(time,ids)=>{setBookTime(time);if(!bookStaff)setBookStaff(ids[0]??'')}}/><button type="button" onClick={()=>void book()}>예약 저장</button><button type="button" onClick={()=>void closeBooking()}>닫기</button></fieldset>}
  {!rows.length&&<p className="empty-state">등록된 대기 고객이 없습니다.</p>}
 </div></Modal>
}
