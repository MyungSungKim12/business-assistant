import { useEffect, useState } from 'react';
import { Modal, notify } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import type { BinarySource } from '../../platform/types';
import { fileApi } from './api';
import { formatSize } from './fileValidation';
import type { FileAsset } from './schemas';

type Version = { id:string; version_number:number; original_name:string; content_type:string; size_bytes:number; created_at:string };
export function FileVersionDialog({api,organizationId,file,readOnly,onClose,onSaved}:{api:ApiClient;organizationId:string;file:FileAsset;readOnly:boolean;onClose:()=>void;onSaved:(file:FileAsset)=>void}){
  const [versions,setVersions]=useState<Version[]>([]);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const load=async()=>{setError('');try{setVersions(await fileApi.versions(api,organizationId,file.id));}catch{setError('파일 버전 이력을 불러오지 못했습니다.')}};
  useEffect(()=>{void load()},[api,organizationId,file.id]);
  async function upload(source:BinarySource){setBusy(true);setError('');try{const saved=await fileApi.uploadVersion(api,organizationId,file.id,file.version_number,source);onSaved(saved);await load();notify.success(`새 버전 ${saved.version_number}을 저장했습니다.`)}catch{setError('새 버전을 올리지 못했습니다. 현재 파일은 유지됩니다. 다시 시도해 주세요.')}finally{setBusy(false)}}
  async function choose(){const picker=api.filePlatform.pickFiles;if(!picker){setError('이 환경에서 파일 선택을 지원하지 않습니다.');return}try{const selected=await picker();if(selected[0])await upload(selected[0])}catch{setError('파일을 선택하지 못했습니다.')}}
  return <Modal title={`${file.original_name} · 버전 이력`} size="md" onClose={onClose}><div className="file-version-dialog">
    <p className="muted">현재 버전 {file.version_number} · 파일당 50MB 이하</p>
    {!readOnly&&<button type="button" className="primary-button" disabled={busy} onClick={()=>void choose()}>{busy?'업로드 중…':'새 버전 올리기'}</button>}
    {error&&<p role="alert" className="form-error">{error}</p>}
    <ol>{versions.map(version=><li key={version.id}><div><strong>버전 {version.version_number}</strong><span>{version.original_name} · {formatSize(version.size_bytes)}</span><time>{new Date(version.created_at).toLocaleString('ko-KR')}</time></div><button type="button" disabled={busy} onClick={async()=>{setBusy(true);try{await fileApi.downloadVersion(api,organizationId,file.id,version.version_number)}catch{setError('이 버전을 다운로드하지 못했습니다.')}finally{setBusy(false)}}}>다운로드</button></li>)}</ol>
  </div></Modal>
}
