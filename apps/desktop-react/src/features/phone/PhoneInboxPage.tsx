import {useEffect,useRef,useState} from 'react';
import {confirm,Modal} from '@business-assistant/react-ui';
import type {ApiClient} from '../../api/client';
import type {Customer} from '../../api/schemas';
import type {PhoneInboxRecord,PhoneInboxQuery,PhoneResponse} from '../../api/phoneInbox';
import {useDraftProtection} from '../../app/DraftBoundary';
import {maskPhone} from '../../lib/privacy';
import {searchCustomers} from '../customers/customerSearch';
import {kstIso} from '../appointments/appointmentTime';

const labels:Record<PhoneInboxRecord['status'],string>={unconfirmed:'미확인',seen:'확인',completed:'응대 완료',callback_needed:'콜백 필요'};
const statusOf=(e:unknown)=>e&&typeof e==='object'&&'status' in e?Number(e.status):0;
export function PhoneInboxPage({api,organizationId,onOpenCustomer}:{api:ApiClient;organizationId:string;onOpenCustomer?:(id:string)=>Promise<boolean>}){
 return <PhoneInboxContent key={organizationId} api={api} organizationId={organizationId} onOpenCustomer={onOpenCustomer}/>;
}
function PhoneInboxContent({api,organizationId,onOpenCustomer}:{api:ApiClient;organizationId:string;onOpenCustomer?: (id:string)=>Promise<boolean>}){
 const [items,setItems]=useState<PhoneInboxRecord[]>([]),[next,setNext]=useState<string|null>(null),[cursor,setCursor]=useState<string|undefined>();
 const [consent,setConsent]=useState<{enabled:boolean;version:number}|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [customers,setCustomers]=useState<Record<string,Customer>>({}),[people,setPeople]=useState<{user_id:string;name:string}[]>([]);
 const [peopleError,setPeopleError]=useState(false),[peopleRetry,setPeopleRetry]=useState(0),[customerError,setCustomerError]=useState(false);
 const [selected,setSelected]=useState<PhoneInboxRecord|null>(null),[memo,setMemo]=useState(''),[status,setStatus]=useState<PhoneInboxRecord['status']>('unconfirmed'),[assignee,setAssignee]=useState(''),[customerId,setCustomerId]=useState(''),[due,setDue]=useState(''),[conflict,setConflict]=useState(false);
 const [statusFilter,setStatusFilter]=useState(''),[from,setFrom]=useState(''),[to,setTo]=useState(''),[customerFilter,setCustomerFilter]=useState(''),[search,setSearch]=useState('');
 const [query,setQuery]=useState<PhoneInboxQuery>({}),[reload,setReload]=useState(0);
 const alive=useRef(true),saving=useRef(false),pending=useRef<{signature:string;input:PhoneResponse}|null>(null);
 const dirty=!!selected&&(!!memo.trim()||!!due||status!==selected.status||assignee!==(selected.assignee_id??''));
 useDraftProtection(dirty,busy);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{
  let active=true;setLoading(true);setError('');
  void Promise.all([api.listPhoneInbox(organizationId,{...query,after:cursor,limit:30}),api.getPhoneRetentionConsent(organizationId)]).then(([page,pref])=>{
   if(!active)return;setItems(page.items);setNext(page.next_cursor);setConsent(pref);
   const ids=[...new Set(page.items.flatMap(row=>row.customer_ids))];
   void Promise.allSettled(ids.map(id=>api.getCustomer(organizationId,id))).then(results=>{if(!active)return;setCustomerError(results.some(r=>r.status==='rejected'));setCustomers(old=>{const updated={...old};for(const r of results)if(r.status==='fulfilled'&&r.value.organization_id===organizationId)updated[r.value.id]=r.value;return updated;});});
  }).catch(e=>{if(active)setError(statusOf(e)===403?'전화 수신함을 조회할 권한이 없습니다.':'전화 수신함을 불러오지 못했습니다. 다시 시도해 주세요.');}).finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[api,organizationId,cursor,query,reload]);
 useEffect(()=>{let active=true;setPeopleError(false);void api.listTaskPeople(organizationId).then(rows=>{if(active)setPeople(rows);}).catch(()=>{if(active)setPeopleError(true);});return()=>{active=false;};},[api,organizationId,peopleRetry]);
 async function canLeave(){return !saving.current&&(!dirty||await confirm({title:'작성 중인 응대 기록',message:'저장하지 않은 입력을 버릴까요?',confirmLabel:'버리고 계속',cancelLabel:'계속 작성'}));}
 function select(row:PhoneInboxRecord){setSelected(row);setStatus(row.status);setAssignee(row.assignee_id??'');setCustomerId(row.customer_ids.length===1?row.customer_ids[0]!: '');setMemo('');setDue('');setConflict(false);pending.current=null;}
 async function open(row:PhoneInboxRecord){
  if(!await canLeave())return;
  select(row);setError('');
  if(row.status!=='unconfirmed')return;
  saving.current=true;setBusy(true);
  try{const updated=await api.respondPhoneInbox(organizationId,row.id,{recipient_id:row.recipient_id,expected_version:row.version,operation_id:crypto.randomUUID(),status:'seen'});if(alive.current){setItems(old=>old.map(r=>r.id===row.id&&r.recipient_id===row.recipient_id?updated:r));select(updated);}}
  catch(e){if(alive.current){setError(statusOf(e)===409?'다른 사람이 먼저 처리했습니다. 최신 상태를 불러와 주세요.':'확인 상태를 저장하지 못했습니다. 입력은 유지됩니다.');setConflict(statusOf(e)===409);}}
  finally{saving.current=false;if(alive.current)setBusy(false);}
 }
 async function save(){
  if(!selected||saving.current||conflict)return;
  if((memo.trim()||due)&&!customerId){setError('기록할 고객을 선택해 주세요.');return;}
  const input:PhoneResponse={recipient_id:selected.recipient_id,expected_version:selected.version,operation_id:'',status,assignee_id:assignee||null,...(customerId?{customer_id:customerId}:{}),...(memo.trim()?{memo:memo.trim()}:{}),...(due?{callback_due_at:kstIso(due)}:{})};
  const signature=JSON.stringify(input);if(pending.current?.signature!==signature)pending.current={signature,input:{...input,operation_id:crypto.randomUUID()}};
  saving.current=true;setBusy(true);setError('');
  try{const updated=await api.respondPhoneInbox(organizationId,selected.id,pending.current.input);if(!alive.current)return;setItems(old=>old.map(r=>r.id===updated.id&&r.recipient_id===updated.recipient_id?updated:r));select(updated);}
  catch(e){if(alive.current){const changed=statusOf(e)===409;setConflict(changed);setError(changed?'다른 사람이 먼저 처리했습니다. 작성한 메모를 유지한 채 최신 상태를 불러와 확인해 주세요.':'저장하지 못했습니다. 작성한 내용은 유지되니 다시 시도해 주세요.');}}
  finally{saving.current=false;if(alive.current)setBusy(false);}
 }
 async function refreshSelected(){
  if(!selected||saving.current)return;setBusy(true);saving.current=true;
  try{const updated=await api.getPhoneInboxRecord(organizationId,selected.id,selected.recipient_id);if(alive.current){setSelected(updated);setStatus(updated.status);setAssignee(updated.assignee_id??'');setConflict(false);setError('');pending.current=null;}}
  catch{if(alive.current)setError('최신 기록을 확인하지 못했습니다. 권한과 보유기간을 확인해 주세요. 입력은 유지됩니다.');}
  finally{saving.current=false;if(alive.current)setBusy(false);}
 }
 async function filter(after?:string){if(!await canLeave())return;setSelected(null);setCursor(after);setQuery({...(statusFilter?{status:statusFilter as PhoneInboxRecord['status']}:{}),...(customerFilter?{customer_id:customerFilter}:{}),...(from?{from:from+'T00:00:00+09:00'}:{}),...(to?{to:new Date(Date.parse(to+'T00:00:00+09:00')+86400000).toISOString()}: {})});setReload(n=>n+1);}
 async function findCustomers(){try{const page=await searchCustomers(api,organizationId,{q:search,status:'all',sort:'name',limit:30});if(alive.current)setCustomers(old=>({...old,...Object.fromEntries(page.items.map(c=>[c.id,c]))}));}catch{setError('고객 검색에 실패했습니다. 다시 시도해 주세요.');}}
 const current=customers[customerId];
 return <section className="operation-page">
  <h1>전화 수신함</h1><p>본인이 받았거나 담당자로 배정받은 기록입니다. 실제 통화 응답·종료 여부는 휴대폰에서 전달하지 않습니다.</p>
  <p>{consent?`수신 기록 보관: ${consent.enabled?'켜짐':'꺼짐'} · 선택 동의한 새 요청만 30일 보관합니다.`:'보관 동의 상태 확인 중…'} 기존 APK는 2분 알림만 복구합니다. 보관 동의는 새 휴대폰 앱에서 선택할 수 있습니다.</p>
  {consent?.enabled&&<button type="button" disabled={busy} onClick={()=>void(async()=>{if(!await canLeave())return;try{setBusy(true);setConsent(await api.setPhoneRetentionConsent(organizationId,{enabled:false,expected_version:consent.version,operation_id:crypto.randomUUID()}));}catch{setError('동의 변경에 실패했습니다. 상태를 다시 불러와 주세요.');}finally{setBusy(false);}})()}>보관 동의 철회</button>}
  <p className="muted">철회 후 새 이력은 보관하지 않으며 기존 기록은 원래 30일 만료일에 제외됩니다. 저장한 고객 활동·콜백 할 일은 각 업무 기록의 보유정책을 따릅니다.</p>
  <div className="toolbar"><label>시작일<input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label><label>종료일<input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label>
   <label>상태<select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}><option value="">전체</option>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
   <label>고객 검색<input value={search} onChange={e=>setSearch(e.target.value)} maxLength={100}/></label><button type="button" onClick={()=>void findCustomers()}>고객 검색</button>
   <label>고객 필터<select value={customerFilter} onChange={e=>setCustomerFilter(e.target.value)}><option value="">전체 고객</option>{Object.values(customers).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><button type="button" disabled={busy} onClick={()=>void filter()}>조회</button>
  </div>
  {loading&&<p role="status">불러오는 중…</p>}{error&&!selected&&<p role="alert">{error}</p>}
  <button type="button" disabled={busy} onClick={()=>setReload(n=>n+1)}>다시 불러오기</button>
  {!loading&&!items.length&&<p>보관 중인 수신 기록이 없습니다.</p>}
  {customerError&&<p>일부 고객 정보를 확인하지 못했습니다. 다시 불러오기로 재시도할 수 있습니다.</p>}
  <table><thead><tr><th>수신 시각</th><th>고객</th><th>수신 번호</th><th>상태</th><th>응대</th></tr></thead><tbody>{items.map(row=><tr key={row.recipient_id+row.id}><td>{new Date(row.occurred_at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})}</td><td>{row.customer_ids.map(id=>customers[id]?.name??'고객 정보 확인 중').join(' · ')}</td><td>{maskPhone(row.phone_e164)}</td><td>{labels[row.status]}</td><td><button type="button" disabled={busy} onClick={()=>void open(row)}>응대 기록 열기</button></td></tr>)}</tbody></table>
  <button type="button" disabled={busy||!cursor} onClick={()=>void filter()}>첫 페이지</button><button type="button" disabled={busy||!next} onClick={()=>void filter(next!)}>다음 페이지</button>
  {selected&&<Modal title="전화 응대 기록" onClose={()=>void(async()=>{if(await canLeave())setSelected(null);})()}>
   <p>수신 당시 번호: {maskPhone(selected.phone_e164)} · {labels[selected.status]}</p>
   <p>메모는 수신 당시 연결된 고객에게 기록합니다. 현재 번호가 바뀌어도 당시 고객 연결을 사용합니다.</p>
   <fieldset disabled={busy}><label>기록 고객<select value={customerId} onChange={e=>setCustomerId(e.target.value)}><option value="">고객 선택</option>{selected.customer_ids.map(id=><option key={id} value={id}>{customers[id]?.name??'고객 정보 확인 중'}</option>)}</select></label>
   {current&&<div><p>현재 고객 번호: {maskPhone(current.phone)}</p>{current.allergies&&<p>주의사항: {current.allergies}</p>}{current.notes&&<p>현재 프로필 메모: {current.notes}</p>}{onOpenCustomer&&<button type="button" onClick={()=>void(async()=>{if(!saving.current&&await onOpenCustomer(current.id))setSelected(null);})()}>고객 상세 보기</button>}</div>}
   <label>응대 메모<textarea value={memo} onChange={e=>setMemo(e.target.value)} maxLength={10000}/></label>
   <label>처리 상태<select value={status} onChange={e=>setStatus(e.target.value as PhoneInboxRecord['status'])}>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
   <label>담당자<select value={assignee} onChange={e=>setAssignee(e.target.value)} disabled={peopleError}><option value="">미배정</option>{assignee&&!people.some(p=>p.user_id===assignee)&&<option value={assignee}>현재 담당자</option>}{people.map(p=><option key={p.user_id} value={p.user_id}>{p.name}</option>)}</select></label>
   {peopleError&&<p>담당자 목록 조회 권한이나 연결을 확인해 주세요. <button type="button" onClick={()=>setPeopleRetry(n=>n+1)}>담당자 다시 불러오기</button></p>}
   <label>콜백 기한 (KST)<input type="datetime-local" value={due} onChange={e=>setDue(e.target.value)} disabled={!!selected.callback_task_id}/></label>{selected.callback_task_id&&<p>연결된 콜백 할 일이 있습니다. 기한 변경·완료는 할 일 메뉴에서 처리하세요.</p>}
   </fieldset>
   {error&&<p role="alert">{error}</p>}{conflict&&<button type="button" disabled={busy} onClick={()=>void refreshSelected()}>최신 상태 불러오기</button>}
   <button type="button" disabled={busy} onClick={()=>void(async()=>{if(await canLeave())setSelected(null);})()}>닫기</button><button type="button" disabled={busy||conflict||!dirty} onClick={()=>void save()}>응대 저장</button>
  </Modal>}
 </section>;
}
