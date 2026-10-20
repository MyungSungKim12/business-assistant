import { useRef,useState } from 'react';
import { Modal,confirm } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { useDraftProtection } from '../../app/DraftBoundary';
import { resourceApi } from '../appointment-resources/api';
import type { AppointmentStaffRow } from '../appointment-resources/schemas';

export function StaffProfileDialog({api,organizationId,staff,onSaved,onClose}:{api:ApiClient;organizationId:string;staff:AppointmentStaffRow;onSaved:(row:AppointmentStaffRow)=>void;onClose:()=>void}){
 const [name,setName]=useState(staff.name),[active,setActive]=useState(staff.is_active),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const request=useRef<{key:string;operationId:string}|null>(null);
 const saving=useRef(false);
 const dirty=name!==staff.name||active!==staff.is_active;
 useDraftProtection(dirty,busy);
 async function close(){if(busy)return;if(dirty&&!(await confirm({title:'직원 정보 수정',message:'저장하지 않은 입력을 버리고 닫을까요?'})))return;onClose();}
 async function save(){
  if(busy||saving.current||staff.profile_version===undefined)return;
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
 return <Modal title="직원 정보 수정" onClose={()=>void close()}><div className="inline-form">
  <label>직원 이름<input maxLength={120} value={name} disabled={busy} onChange={e=>setName(e.currentTarget.value)}/></label>
  <label><input type="checkbox" checked={active} disabled={busy} onChange={e=>setActive(e.currentTarget.checked)}/>예약 담당 사용</label>
  <p className="muted">중지해도 과거 예약·시술 기록과 근무 설정은 보존됩니다. 로그인 구성원 권한과는 별개입니다.</p>
  {staff.profile_version===undefined&&<p className="muted">SQL 063 적용 후 직원 목록을 다시 확인하세요.</p>}
  {error&&<p role="alert" className="form-error">{error}</p>}
  <button type="button" className="primary-button" disabled={busy||staff.profile_version===undefined} onClick={()=>void save()}>{busy?'저장 중…':'저장'}</button>
 </div></Modal>;
}
