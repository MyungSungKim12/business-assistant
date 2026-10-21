import { useEffect,useRef,useState } from 'react';
import { Modal,confirm } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { useDraftProtection } from '../../app/DraftBoundary';
import { resourceApi } from '../appointment-resources/api';
import type { AppointmentStaffRow } from '../appointment-resources/schemas';
import { membersApi } from '../members/api';
import type { Member } from '../members/memberRules';

export function StaffProfileDialog({api,organizationId,staff,linkedUserIds=[],onSaved,onClose}:{api:ApiClient;organizationId:string;staff:AppointmentStaffRow;linkedUserIds?:string[];onSaved:(row:AppointmentStaffRow)=>void;onClose:()=>void}){
 const [name,setName]=useState(staff.name),[active,setActive]=useState(staff.is_active),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [members,setMembers]=useState<Member[]|null>(null),[memberLoadError,setMemberLoadError]=useState(''),[linkedUserId,setLinkedUserId]=useState(staff.auth_user_id??'');
 const request=useRef<{key:string;operationId:string}|null>(null);
 const linkRequest=useRef<{key:string;operationId:string}|null>(null);
 const saving=useRef(false);
 const dirty=name!==staff.name||active!==staff.is_active||linkedUserId!==(staff.auth_user_id??'');
 useEffect(()=>{if(staff.profile_version===undefined){setMemberLoadError('직원 계정 연결은 SQL 077 적용 후 사용할 수 있습니다.');return}let active=true;void membersApi.list(api,organizationId).then(value=>{if(active)setMembers(value)}).catch(()=>{if(active)setMemberLoadError('조직 구성원 목록을 불러오지 못했습니다.')});return()=>{active=false}},[api,organizationId,staff.profile_version]);
 useDraftProtection(dirty,busy);
 async function close(){if(busy)return;if(dirty&&!(await confirm({title:'직원 정보 수정',message:'저장하지 않은 입력을 버리고 닫을까요?'})))return;onClose();}
 async function save(){
  if(busy||saving.current||staff.profile_version===undefined)return;
  if(linkedUserId!==(staff.auth_user_id??'')){setError('직원 정보와 로그인 연결은 별도로 저장합니다. 먼저 계정 연결을 저장하거나 선택을 되돌리세요.');return;}
  const trimmed=name.trim();if(!trimmed){setError('직원 이름을 입력하세요.');return;}
  saving.current=true;
  setBusy(true);setError('');
  try{
   if(staff.is_active&&!active&&!(await confirm({title:'예약 담당 중지',message:'새 예약 담당에서 제외합니다. 남은 예약·진행 중 방문이 있으면 먼저 재배정·처리해야 합니다. 중지할까요?'})))return;
   const key=JSON.stringify([trimmed,active,staff.profile_version]);
   if(request.current?.key!==key)request.current={key,operationId:crypto.randomUUID()};
   const saved=await resourceApi.updateStaffProfile(api,organizationId,staff.id,{name:trimmed,is_active:active,expected_version:staff.profile_version,operation_id:request.current.operationId});
   if(saved.organization_id!==organizationId||saved.id!==staff.id||saved.profile_version===undefined)throw new Error('Invalid staff profile');
   onSaved(saved);
  }catch(e){setError((e as {status?:number}).status===409?'직원 정보가 변경되었거나 남은 예약·방문이 있습니다. 예약을 재배정·처리하거나 창을 다시 열어 최신 정보를 확인하세요.':'직원 정보를 저장하지 못했습니다. 입력은 유지됩니다. 같은 내용으로 다시 시도하세요.');}
  finally{saving.current=false;setBusy(false);}
 }
 async function saveAccountLink(){
  if(busy||staff.profile_version===undefined||linkedUserId===(staff.auth_user_id??''))return;
  if(name!==staff.name||active!==staff.is_active){setError('직원 정보와 로그인 연결은 별도로 저장합니다. 먼저 직원 정보를 저장하거나 입력을 되돌리세요.');return;}
  const userId=linkedUserId||null,key=JSON.stringify([userId,staff.profile_version]);
  if(linkRequest.current?.key!==key)linkRequest.current={key,operationId:crypto.randomUUID()};
  setBusy(true);setError('');
  try{
   const saved=await resourceApi.assignStaffAccount(api,organizationId,staff.id,{user_id:userId,expected_version:staff.profile_version,operation_id:linkRequest.current.operationId});
   if(saved.organization_id!==organizationId||saved.id!==staff.id||saved.auth_user_id!==userId||saved.profile_version===undefined)throw new Error('Invalid staff account link');
   onSaved(saved);
  }catch(e){setError((e as {status?:number}).status===409?'이미 다른 직원에게 연결된 계정이거나 직원 정보가 변경되었습니다. 최신 정보를 다시 확인하세요.':'계정을 연결하지 못했습니다. 입력은 유지되므로 다시 시도하세요.');}
  finally{setBusy(false);}
 }
 const availableMembers=(members??[]).filter(member=>member.user_id===staff.auth_user_id||!linkedUserIds.includes(member.user_id));
 return <Modal title="직원 정보 수정" onClose={()=>void close()}><div className="inline-form">
  <label>직원 이름<input maxLength={120} value={name} disabled={busy} onChange={e=>setName(e.currentTarget.value)}/></label>
  <label><input type="checkbox" checked={active} disabled={busy} onChange={e=>setActive(e.currentTarget.checked)}/>예약 담당 사용</label>
  <p className="muted">중지해도 과거 예약·시술 기록과 근무 설정은 보존됩니다. 로그인 구성원 권한과는 별개입니다.</p>
  <label>연결된 로그인 구성원<select aria-label="연결된 로그인 구성원" value={linkedUserId} disabled={busy||members===null||staff.profile_version===undefined} onChange={event=>setLinkedUserId(event.currentTarget.value)}><option value="">연결 안 함</option>{availableMembers.map(member=><option key={member.user_id} value={member.user_id}>{member.display_name||member.email||'이름 없는 구성원'} · {member.role}</option>)}</select></label>
  {memberLoadError&&<p className="muted">{memberLoadError}</p>}
  {members===null&&!memberLoadError&&<p className="muted">조직 구성원 계정을 불러오는 중…</p>}
  <button type="button" disabled={busy||members===null||staff.profile_version===undefined||linkedUserId===(staff.auth_user_id??'')} onClick={()=>void saveAccountLink()}>{busy?'저장 중…':'계정 연결 저장'}</button>
  {staff.profile_version===undefined&&<p className="muted">SQL 063 적용 후 직원 목록을 다시 확인하세요.</p>}
  {error&&<p role="alert" className="form-error">{error}</p>}
  <button type="button" className="primary-button" disabled={busy||staff.profile_version===undefined} onClick={()=>void save()}>{busy?'저장 중…':'저장'}</button>
 </div></Modal>;
}
