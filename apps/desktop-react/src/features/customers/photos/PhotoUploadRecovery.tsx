import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../../api/client';
import type { PhotoUploadStatus } from '../../../api/schemas';

const reasons={object_missing:'파일을 찾을 수 없음',metadata_mismatch:'파일 크기 또는 형식 불일치',upload_not_completed:'등록 완료 전 중단'};
const time=(value:string)=>new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'});

/** No old upload token is stored. A retry always asks the user for a local file. */
export function PhotoUploadRecovery({api,organizationId,customerId,uploading,onReselect,onRefresh}:{api:ApiClient;organizationId:string;customerId:string;uploading:boolean;onReselect:()=>Promise<void>;onRefresh:()=>Promise<void>}) {
  const [status,setStatus]=useState<PhotoUploadStatus|null>(null);
  const [error,setError]=useState(false);
  const [refresh,setRefresh]=useState(0);
  const [refreshing,setRefreshing]=useState(false);
  const previousUploading=useRef(uploading);
  useEffect(()=>{
    if(previousUploading.current&&!uploading)setRefresh(n=>n+1);
    previousUploading.current=uploading;
  },[uploading]);
  useEffect(()=>{
    let current=true;setError(false);
    // Some embedded consumers/test fixtures predate this optional diagnostics UI.
    if(typeof api.getCustomerPhotoUploadStatus!=='function')return;
    void api.getCustomerPhotoUploadStatus(organizationId,customerId).then(value=>{if(current)setStatus(value);},()=>{if(current)setError(true);});
    return()=>{current=false;};
  },[api,organizationId,customerId,refresh]);
  if(!status&&!error)return null;
  return <section className="pg-recovery" aria-label="사진 등록 복구">
    <div className="pg-recovery__head"><strong>사진 등록 상태</strong><button type="button" disabled={uploading||refreshing} onClick={()=>{
      setRefreshing(true);void onRefresh().finally(()=>{setRefresh(n=>n+1);setRefreshing(false);});
    }}>등록 상태 새로고침</button></div>
    {error&&<p role="alert">사진 등록 상태를 불러오지 못했습니다. 다시 새로고침해 주세요.</p>}
    {status&&(status.maintenance?<p className="muted">자동 확인 최근 실행: {time(status.maintenance.attempted_at)} · {status.maintenance.state==='succeeded'?'정상':'실패 (관리자 점검 필요)'}</p>:<p className="muted">자동 확인 실행 기록이 없습니다. 관리자에게 설정 확인을 요청해 주세요.</p>)}
    {!!status?.items.length&&<><p className="muted">확인 중인 전송은 자동으로 복구될 수 있습니다. 다시 등록하려면 이 기기에서 사진을 선택하세요. 이전 등록 기록은 보존됩니다.</p>
      <ul>{status.items.map(row=><li key={row.id}><strong>{row.original_name}</strong> · {row.upload_state==='pending'?'전송 결과 확인 대기':`등록 실패 · ${row.upload_failure_reason?reasons[row.upload_failure_reason]:'원인 미기록'}`}
        <span> · 등록 시각: {time(row.created_at)}{row.upload_state==='failed'&&` · 실패 시각: ${row.upload_failed_at?time(row.upload_failed_at):'미기록'}`}</span>
      </li>)}</ul><button type="button" disabled={uploading} onClick={()=>void onReselect()}>사진 다시 선택</button></>}
    {status?.has_more&&<p className="muted">실패 항목 우선 최대 {status.limit}건을 표시합니다. 이전 기록이 더 있습니다.</p>}
  </section>;
}
