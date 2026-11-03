import {useEffect,useRef,useState} from 'react';
import {confirm,ErrorState,LoadingState,Modal,notify} from '@business-assistant/react-ui';
import {useDraftProtection} from '../../app/DraftBoundary';
import type {CallApi} from '../appointment-resources/api';
import {useOperationTracker} from '../appointment-resources/operationIds';
import {bookingPolicyApi,bookingPolicyValues,wholeDayBlock,type BookingPolicy,type BookingPolicyValues} from './bookingPolicy';
import {kstIso,toKstLocalInput} from './appointmentTime';

const weekdays=['월','화','수','목','금','토','일'];
export function BookingPolicyDialog({api,organizationId,readOnly,onClose}:{api:CallApi;organizationId:string;readOnly:boolean;onClose:()=>void}){
 const [row,setRow]=useState<BookingPolicy|null>(null),[draft,setDraft]=useState<BookingPolicyValues|null>(null);
 const [loading,setLoading]=useState(true),[failed,setFailed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [blockStart,setBlockStart]=useState(''),[blockEnd,setBlockEnd]=useState(''),[blockReason,setBlockReason]=useState(''),[closureDate,setClosureDate]=useState('');
 const operations=useOperationTracker(),generation=useRef(0),saving=useRef(false);
 const savedValues=row?bookingPolicyValues.parse(row):null;
 const dirty=!readOnly&&!!draft&&(JSON.stringify(draft)!==JSON.stringify(savedValues)||!!blockStart||!!blockEnd||!!blockReason||!!closureDate);
 useDraftProtection(dirty,busy);
 async function load(){
  const run=++generation.current;setLoading(true);setFailed(false);setError('');
  try{const next=await bookingPolicyApi.get(api,organizationId);if(run!==generation.current)return;setRow(next);setDraft(bookingPolicyValues.parse(next));operations.reset();}
  catch{if(run===generation.current){setFailed(true);setError('예약 정책을 불러오지 못했습니다. 기존 입력은 유지됩니다.');}}finally{if(run===generation.current)setLoading(false);}
 }
 useEffect(()=>{setRow(null);setDraft(null);setBlockStart('');setBlockEnd('');setBlockReason('');setClosureDate('');setBusy(false);saving.current=false;void load();return()=>{generation.current++;};},[api,organizationId]); // eslint-disable-line react-hooks/exhaustive-deps
 async function close(){
  if(saving.current)return;
  if(dirty&&!await confirm({title:'예약 정책 편집 취소',message:'저장하지 않은 입력을 버리고 닫을까요?',confirmLabel:'버리고 닫기',cancelLabel:'계속 편집'}))return;
  onClose();
 }
 async function reload(){
  if(saving.current)return;
  if(dirty&&!await confirm({title:'예약 정책 다시 불러오기',message:'입력을 버리고 서버의 최신 정책을 불러올까요?',confirmLabel:'다시 불러오기',cancelLabel:'계속 편집'}))return;
  setBlockStart('');setBlockEnd('');setBlockReason('');setClosureDate('');await load();
 }
 function change(patch:Partial<BookingPolicyValues>){setDraft(old=>old?{...old,...patch}:old);}
 async function save(){
  if(readOnly||!row||!draft||saving.current)return;
  const input=bookingPolicyValues.safeParse(draft);
  if(!input.success){setError('시간대와 영업 구간, 차단 범위를 확인해 주세요. 종료는 시작 이후여야 하며 차단은 최대 366일입니다.');return;}
  const operation_id=operations.idFor(JSON.stringify([row.version,input.data]));
  saving.current=true;setBusy(true);setError('');const run=generation.current;
  try{
   const next=await bookingPolicyApi.save(api,organizationId,{policy:input.data,expected_version:row.version,operation_id});
   if(run!==generation.current)return;setRow(next);setDraft(bookingPolicyValues.parse(next));operations.reset();notify.success('예약 정책을 저장했습니다.');
  }catch{if(run===generation.current)setError('예약 정책을 저장하지 못했습니다. 입력은 유지됩니다. 다시 저장하거나 다른 관리자가 변경했다면 최신 정책을 불러와 주세요.');}
  finally{if(run===generation.current){saving.current=false;setBusy(false);}}
 }
 function addBlock(fullDay=false){
  if(!draft||draft.blocks.length>=200)return;
  try{
   const block=fullDay?wholeDayBlock(closureDate,draft.timezone_name,blockReason):{start_at:kstIso(blockStart),end_at:kstIso(blockEnd),reason:blockReason};
   if(!bookingPolicyValues.shape.blocks.element.safeParse(block).success)throw new Error('Invalid block');
   change({blocks:[...draft.blocks,block]});setBlockStart('');setBlockEnd('');setBlockReason('');setClosureDate('');setError('');
  }catch{setError('차단 시작·종료와 시간대를 확인해 주세요. 하루 휴무는 매장 시간대의 자정부터 다음 자정까지이며, 존재하지 않는 현지 자정은 직접 차단 구간을 입력해 주세요.');}
 }
 return <Modal title="매장 예약 정책" size="lg" onClose={()=>void close()}>
  {loading?<LoadingState/>:failed&&!draft?<ErrorState message="예약 정책을 불러오지 못했습니다." onRetry={()=>void load()}/>:draft&&<div className="booking-policy-dialog">
   <p className="muted">조직 전체에 적용됩니다. 기존 예약은 자동 변경하지 않습니다. 예약 화면의 날짜와 차단 시각 입력은 KST이며 영업시간·접수 마감·하루 휴무는 매장 시간대 기준입니다.</p>
   {readOnly&&<p className="muted">조회 전용입니다. 소유자·관리자만 변경할 수 있습니다.</p>}
   <fieldset disabled={readOnly||busy} className="resource-form"><legend>예약 접수 기준</legend>
    <label><input aria-label="예약 정책 사용" type="checkbox" checked={draft.enabled} onChange={e=>change({enabled:e.currentTarget.checked})}/>예약 정책 사용</label>
    <label>매장 시간대<input aria-label="매장 시간대" maxLength={100} value={draft.timezone_name} onChange={e=>change({timezone_name:e.currentTarget.value})}/></label>
    <label>최소 사전 시간 (분)<input aria-label="최소 사전 시간 (분)" type="number" min={0} max={525600} value={draft.minimum_notice_minutes} onChange={e=>change({minimum_notice_minutes:Number(e.currentTarget.value)})}/></label>
    <label>당일 접수 마감<input aria-label="당일 접수 마감" type="time" value={draft.same_day_cutoff_time??''} onChange={e=>change({same_day_cutoff_time:e.currentTarget.value||null})}/></label>
   </fieldset>
   <p className="muted">마감 이후에는 오늘의 신규 예약·시간 변경을 받지 않습니다. 미래 날짜 예약은 접수할 수 있습니다. 정책 사용 시 영업 구간이 없는 요일은 휴무입니다. 매장 시간대의 시계 변경을 가로지르는 예약은 지원하지 않습니다.</p>
   <fieldset disabled={readOnly||busy}><legend>주간 영업시간 (최대 70구간)</legend>
    <p className="muted">점심은 구간을 나누어 입력합니다. 시술과 여유 시간 전체가 한 구간에 들어와야 합니다. 자정 종료는 24:00으로 입력합니다.</p>
    {draft.hours.map((h,index)=><div className="resource-form" key={index}>
     <select aria-label={`영업 요일 ${index+1}`} value={h.weekday} onChange={e=>change({hours:draft.hours.map((item,n)=>n===index?{...item,weekday:Number(e.currentTarget.value)}:item)})}>{weekdays.map((day,n)=><option key={day} value={n+1}>{day}</option>)}</select>
     <input aria-label={`영업 시작 ${index+1}`} type="time" value={h.start_time} onChange={e=>change({hours:draft.hours.map((item,n)=>n===index?{...item,start_time:e.currentTarget.value}:item)})}/>
     <input aria-label={`영업 종료 ${index+1}`} placeholder="18:00 또는 24:00" value={h.end_time} maxLength={5} onChange={e=>change({hours:draft.hours.map((item,n)=>n===index?{...item,end_time:e.currentTarget.value}:item)})}/>
     {!readOnly&&<button type="button" aria-label={`영업 구간 삭제 ${index+1}`} onClick={()=>change({hours:draft.hours.filter((_,n)=>n!==index)})}>삭제</button>}
    </div>)}
    {!readOnly&&<button type="button" disabled={draft.hours.length>=70} onClick={()=>change({hours:[...draft.hours,{weekday:1,start_time:'09:00',end_time:'18:00'}]})}>영업 구간 추가</button>}
   </fieldset>
   <fieldset disabled={readOnly||busy}><legend>날짜별 휴무·차단 (최대 200구간)</legend>
    {draft.blocks.length===0&&<p className="muted">등록된 차단이 없습니다.</p>}
    <ul>{draft.blocks.map((b,index)=><li key={index}>{toKstLocalInput(b.start_at).replace('T',' ')} ~ {toKstLocalInput(b.end_at).replace('T',' ')} KST · {b.reason||'사유 없음'} {!readOnly&&<button type="button" aria-label={`차단 삭제 ${index+1}`} onClick={()=>change({blocks:draft.blocks.filter((_,n)=>n!==index)})}>삭제</button>}</li>)}</ul>
    {!readOnly&&<><div className="resource-form">
     <label>차단 시작 (KST)<input aria-label="차단 시작 (KST)" type="datetime-local" value={blockStart} onChange={e=>setBlockStart(e.currentTarget.value)}/></label>
     <label>차단 종료 (KST)<input aria-label="차단 종료 (KST)" type="datetime-local" value={blockEnd} onChange={e=>setBlockEnd(e.currentTarget.value)}/></label>
     <label>차단 사유<input aria-label="차단 사유" maxLength={500} value={blockReason} onChange={e=>setBlockReason(e.currentTarget.value)}/></label>
     <button type="button" disabled={!blockStart||!blockEnd||draft.blocks.length>=200} onClick={()=>addBlock()}>차단 추가</button>
    </div><div className="resource-form"><label>하루 휴무 (매장 날짜)<input aria-label="하루 휴무 (매장 날짜)" type="date" value={closureDate} onChange={e=>setClosureDate(e.currentTarget.value)}/></label><button type="button" disabled={!closureDate||draft.blocks.length>=200} onClick={()=>addBlock(true)}>하루 휴무 추가</button></div>
    <p className="muted">입력한 차단·하루 휴무는 추가를 누른 뒤 저장해야 적용됩니다. 겹치는 차단은 허용되며 하나라도 겹치면 예약할 수 없습니다.</p></>}
   </fieldset>
   {error&&<p role="alert" className="form-error">{error}</p>}
   <div className="dialog-actions"><button type="button" disabled={busy} onClick={()=>void reload()}>최신 정책 불러오기</button><button type="button" disabled={busy} onClick={()=>void close()}>{readOnly?'닫기':'취소'}</button>{!readOnly&&<button type="button" className="primary-button" disabled={busy} onClick={()=>void save()}>{busy?'저장 중…':'저장'}</button>}</div>
  </div>}
 </Modal>;
}
