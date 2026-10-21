import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { confirm, notify } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { fileApi, type FilePlatform } from './api';
import { formatTime, messageFor } from './errors';
import { isPreviewable } from './filePreview';
import { FilePreviewModal } from './FilePreviewModal';
import { FileVersionDialog } from './FileVersionDialog';
import { formatSize } from './fileValidation';
import type { FileAsset, FileStorageUsage } from './schemas';
import { UploadList } from './UploadList';
import { useFileUploads } from './useFileUploads';
import './documents.css';

export interface FilePageProps { api: ApiClient; organizationId: string; readOnly: boolean }

/** 매장 파일 자료: 목록, 서명 URL 업로드(50MB 이하, 진행률·취소), 이미지·PDF 미리보기, 다운로드, 보관. */
export function FilePage({ api, organizationId, readOnly }: FilePageProps) {
  const [files, setFiles] = useState<FileAsset[]>([]);
  const [storageUsage,setStorageUsage]=useState<FileStorageUsage|null>(null);
  const [quotaGiB,setQuotaGiB]=useState('5');
  const [quotaBusy,setQuotaBusy]=useState(false);
  const [folders,setFolders]=useState<Array<{id:string;name:string}>>([]);
  const [folderId,setFolderId]=useState('');
  const [folderName,setFolderName]=useState('');
  const [tagEdits,setTagEdits]=useState<Record<string,string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [working, setWorking] = useState('');
  const [query, setQuery] = useState('');
  const [tagQuery,setTagQuery]=useState('');
  const [previewId, setPreviewId] = useState('');
  const [versionFileId,setVersionFileId]=useState('');
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextFiles,nextFolders,usage]=await Promise.all([fileApi.list(api, organizationId, includeArchived),fileApi.folders(api,organizationId),fileApi.storageUsage(api,organizationId)]);
      setFiles(nextFiles);setFolders(nextFolders);setStorageUsage(usage);setQuotaGiB((usage.organization_quota_bytes/1024**3).toString());
      setLoadError('');
    } catch (e) { setLoadError(messageFor(e, { 403: '파일 접근 권한이 없습니다.' }, '파일을 불러오지 못했습니다.')); }
    finally { setLoading(false); }
  }, [api, organizationId, includeArchived]);
  useEffect(() => { void load(); }, [load]);

  const uploads = useFileUploads(api, organizationId, {
    onSaved: (saved, uploadedName) => {
      setFiles((old) => [saved, ...old.filter((row) => row.id !== saved.id)]);
      void fileApi.storageUsage(api,organizationId).then(setStorageUsage).catch(()=>undefined);
      notify.success(`${uploadedName} 파일을 업로드했습니다.`);
    },
    onError: setError,
    onCancelled: (name) => notify.info(`${name} 업로드를 취소했습니다.`),
  });

  const upload = async (sources: Parameters<typeof uploads.start>[0]) => {
    setError('');
    await uploads.start(sources);
  };

  const saveQuota=async()=>{
    const value=Number(quotaGiB);
    if(!Number.isFinite(value)||value<0||value>1024){setError('저장 한도는 0~1,024 GiB 범위로 입력하세요.');return;}
    const bytes=Math.round(value*1024**3);
    if(storageUsage&&bytes<storageUsage.used_bytes+storageUsage.reserved_bytes&&!await confirm({title:'사용량보다 작은 한도',message:'현재 사용량과 업로드 예약보다 한도가 작아집니다. 초과 상태에서는 새 업로드가 차단됩니다. 계속할까요?',confirmLabel:'한도 변경'}))return;
    setQuotaBusy(true);setError('');
    try{setStorageUsage(await fileApi.setStorageQuota(api,organizationId,bytes));notify.success('조직 저장 한도를 변경했습니다.');}
    catch(e){setError(messageFor(e,{403:'저장 한도 변경은 관리자만 할 수 있습니다.'},'저장 한도를 변경하지 못했습니다. 090 SQL 적용 상태를 확인하세요.'));}
    finally{setQuotaBusy(false);}
  };

  const choose = async () => {
    setError('');
    const platform = api.filePlatform as FilePlatform;
    if (platform.pickFiles) {
      let picked;
      try { picked = await platform.pickFiles(); }
      catch { setError('파일을 선택하지 못했습니다. 다시 시도해 주세요.'); return; }
      await upload(picked);
      return;
    }
    if (platform.kind === 'tauri') { setError('이 환경에서는 파일 선택을 지원하지 않습니다. 앱을 업데이트해 주세요.'); return; }
    input.current?.click();
  };
  const picked = async (event: ChangeEvent<HTMLInputElement>) => {
    const list = [...(event.target.files ?? [])];
    event.target.value = '';
    await upload(list.map((file) => ({ kind: 'blob' as const, name: file.name, contentType: file.type || 'application/octet-stream', size: file.size, blob: file })));
  };

  /** 다운로드 후 성공 여부를 돌려준다. 오류는 화면 오류 문구로 알린다. */
  const download = async (file: FileAsset): Promise<boolean> => {
    setWorking(file.id);
    setError('');
    try { await fileApi.download(api, organizationId, file.id); notify.success(`${file.original_name} 다운로드를 시작했습니다.`); return true; }
    catch (e) { setError(messageFor(e, { 403: '파일 다운로드 권한이 없습니다.', 404: '파일을 찾을 수 없습니다. 목록을 새로고침하세요.' }, `${file.original_name} 다운로드에 실패했습니다. 다시 시도해 주세요.`)); return false; }
    finally { setWorking(''); }
  };
  /** 확인을 받아 보관한다. 보관했으면 true. */
  const archive = async (file: FileAsset): Promise<boolean> => {
    if (!(await confirm({ title: '파일 보관', message: `${file.original_name} 파일을 보관하시겠습니까? 보관한 파일은 다운로드할 수 없습니다.`, confirmLabel: '보관', tone: 'danger' }))) return false;
    setWorking(file.id);
    setError('');
    try {
      const saved = await fileApi.archive(api, organizationId, file.id);
      setFiles((old) => (includeArchived ? old.map((row) => (row.id === saved.id ? saved : row)) : old.filter((row) => row.id !== saved.id)));
      notify.success('파일을 보관했습니다.');
      return true;
    } catch (e) { setError(messageFor(e, { 403: '파일 보관 권한이 없습니다(관리자만 가능).', 404: '파일을 찾을 수 없습니다.' }, '파일을 보관하지 못했습니다. 다시 시도해 주세요.')); return false; }
    finally { setWorking(''); }
  };

  const closePreview = useCallback(() => setPreviewId(''), []);
  async function saveFolder(){const name=folderName.trim();if(!name)return;try{const created=await fileApi.createFolder(api,organizationId,name);setFolders(old=>[...old,created].sort((a,b)=>a.name.localeCompare(b.name)));setFolderName('');notify.success('폴더를 만들었습니다.')}catch{setError('폴더를 만들지 못했습니다. 이름 중복 여부와 권한을 확인하세요.')}}
  async function deleteFolder(folder:{id:string;name:string}){const count=files.filter(file=>file.folder_id===folder.id).length;if(!(await confirm({title:'폴더 삭제',message:`${folder.name} 폴더를 삭제할까요? 포함된 파일 ${count}개는 미분류로 이동합니다. 파일 자체는 삭제되지 않습니다.`,confirmLabel:'폴더 삭제',tone:'danger'})))return;try{await fileApi.deleteFolder(api,organizationId,folder.id);setFolders(old=>old.filter(item=>item.id!==folder.id));if(folderId===folder.id)setFolderId('');setFiles(old=>old.map(file=>file.folder_id===folder.id?{...file,folder_id:null}:file));notify.success('폴더를 삭제하고 파일을 미분류로 옮겼습니다.')}catch{setError('폴더를 삭제하지 못했습니다. 권한이나 최신 폴더 상태를 확인하세요.')}}
  async function saveMetadata(file:FileAsset){const tags=(tagEdits[file.id]??file.tags.join(',')).split(',').map(x=>x.trim()).filter(Boolean);try{const saved=await fileApi.updateMetadata(api,organizationId,file.id,{folder_id:file.folder_id,tags:[...new Set(tags)]});setFiles(old=>old.map(row=>row.id===saved.id?saved:row));setTagEdits(old=>({...old,[file.id]:saved.tags.join(', ')}));notify.success('파일 분류를 저장했습니다.')}catch{setError('파일 분류를 저장하지 못했습니다. 태그는 최대 10개입니다.')}}
  const rows = files.filter((row) => (!folderId||row.folder_id===folderId)&&row.original_name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())&&(!tagQuery.trim()||row.tags.some(tag=>tag.toLocaleLowerCase().includes(tagQuery.trim().toLocaleLowerCase()))));
  const previewable = rows.filter(isPreviewable);
  const uploading = uploads.items.find((item) => item.status === 'uploading')?.name ?? '';
  return (
    <section className="doc-page file-page">
      <div className="page-toolbar">
        <div><p className="eyebrow">FILES</p><h1>파일·자료</h1><p className="muted">매장 파일을 안전하게 보관합니다. 한 파일은 50MB 이하입니다.{storageUsage&&` 저장 공간 ${formatSize(storageUsage.used_bytes)} / ${formatSize(storageUsage.quota_bytes)} 사용 중`}{storageUsage?.plan_quota_bytes!==null&&storageUsage?.plan_quota_bytes!==undefined?` · 요금제 상한 ${formatSize(storageUsage.plan_quota_bytes)}`:''}{storageUsage?.reserved_bytes?` · 업로드 예약 ${formatSize(storageUsage.reserved_bytes)}`:''}</p></div>
        <div className="doc-actions">
          <input aria-label="파일 검색" placeholder="파일명 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
          <input aria-label="태그 검색" placeholder="태그 검색" value={tagQuery} onChange={e=>setTagQuery(e.currentTarget.value)} />
          <select aria-label="폴더 필터" value={folderId} onChange={e=>setFolderId(e.currentTarget.value)}><option value="">모든 폴더</option>{folders.map(folder=><option key={folder.id} value={folder.id}>{folder.name}</option>)}</select>
          {!readOnly&&<><input aria-label="새 폴더 이름" placeholder="새 폴더 이름" maxLength={80} value={folderName} onChange={e=>setFolderName(e.currentTarget.value)}/><button type="button" disabled={!folderName.trim()} onClick={()=>void saveFolder()}>폴더 추가</button><div aria-label="폴더 관리">{folders.map(folder=><button key={folder.id} type="button" disabled={working!==""} aria-label={`${folder.name} 폴더 삭제`} onClick={()=>void deleteFolder(folder)}>{folder.name} 삭제</button>)}</div></>}
          <label className="doc-check"><input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />보관 파일 포함</label>
          <button type="button" onClick={() => void load()}>새로고침</button>
          {!readOnly && <button type="button" className="primary-button" disabled={uploads.busy} onClick={() => void choose()}>{uploading ? `${uploading} 업로드 중…` : uploads.busy ? '업로드 대기 중…' : '파일 올리기'}</button>}
          <input ref={input} type="file" multiple hidden aria-label="업로드할 파일" onChange={(e) => void picked(e)} />
        </div>
      </div>
      {error && <p role="alert" className="form-error">{error}</p>}
      {loadError && <p role="alert" className="form-error">{loadError} <button type="button" onClick={() => void load()}>다시 시도</button></p>}
      <UploadList items={uploads.items} onCancel={uploads.cancel} />
      {!readOnly&&storageUsage&&<section className="file-quota-settings" aria-label="조직 저장 한도 설정"><label>조직 저장 한도(GiB)<input aria-label="조직 저장 한도 GiB" type="number" min="0" max="1024" step="0.1" value={quotaGiB} onChange={event=>setQuotaGiB(event.currentTarget.value)} /></label><button type="button" disabled={quotaBusy||Number(quotaGiB)===storageUsage.organization_quota_bytes/1024**3} onClick={()=>void saveQuota()}>{quotaBusy?'저장 중…':'한도 저장'}</button><span className="muted">0~1,024 GiB · 요금제와 조직 한도 중 더 작은 값이 실제 상한입니다. 기존 파일은 유지되며 한도 초과 후 새 업로드가 차단됩니다.</span></section>}
      <div className="data-surface">
        {loading ? <p className="muted">파일을 불러오는 중…</p> : <table aria-label="파일 목록">
          <thead><tr><th>파일명</th><th>폴더 · 태그</th><th>형식</th><th>크기</th><th>등록일</th><th>작업</th></tr></thead>
          <tbody>{rows.map((file) => <tr key={file.id}>
            <td>{file.original_name}{file.is_archived && <span className="doc-badge">보관됨</span>}</td><td><select aria-label={`${file.original_name} 폴더`} disabled={readOnly||file.is_archived} value={file.folder_id??''} onChange={async e=>{const folder_id=e.currentTarget.value||null;try{const saved=await fileApi.updateMetadata(api,organizationId,file.id,{folder_id,tags:file.tags});setFiles(old=>old.map(row=>row.id===saved.id?saved:row))}catch{setError('폴더를 변경하지 못했습니다.')}}}><option value="">미분류</option>{folders.map(folder=><option key={folder.id} value={folder.id}>{folder.name}</option>)}</select><input aria-label={`${file.original_name} 태그`} placeholder="태그, 쉼표로 구분" disabled={readOnly||file.is_archived} value={tagEdits[file.id]??file.tags.join(', ')} onChange={e=>{const value=e.currentTarget.value;setTagEdits(old=>({...old,[file.id]:value}))}}/>{!readOnly&&<button type="button" disabled={file.is_archived} onClick={()=>void saveMetadata(file)}>태그 저장</button>}</td><td>{file.content_type}</td><td>{formatSize(file.size_bytes)}</td><td>{formatTime(file.created_at)}</td>
            <td className="row-actions">
              {isPreviewable(file) && <button type="button" aria-label={`${file.original_name} 미리보기`} disabled={working === file.id} onClick={() => setPreviewId(file.id)}>미리보기</button>}
              <button type="button" aria-label={`${file.original_name} 버전 이력`} disabled={file.is_archived||working===file.id} onClick={()=>setVersionFileId(file.id)}>버전 {file.version_number}</button>
              <button type="button" disabled={file.is_archived || working === file.id} onClick={() => void download(file)}>다운로드</button>
              {!readOnly && <button type="button" className="danger-button" disabled={file.is_archived || working === file.id} onClick={() => void archive(file)}>보관</button>}
            </td></tr>)}</tbody>
        </table>}
        {!loading && !loadError && rows.length === 0 && <p className="empty-state">등록된 파일이 없습니다.</p>}
      </div>
      {previewId && previewable.some((file) => file.id === previewId) && (
        <FilePreviewModal api={api} organizationId={organizationId} files={previewable} startId={previewId} readOnly={readOnly} onClose={closePreview}
          onDownload={async (file) => { await download(file); }} onArchive={archive} />
      )}
      {versionFileId&&files.find(row=>row.id===versionFileId)&&<FileVersionDialog api={api} organizationId={organizationId} file={files.find(row=>row.id===versionFileId)!} readOnly={readOnly} onClose={()=>setVersionFileId('')} onSaved={saved=>{setFiles(rows=>rows.map(row=>row.id===saved.id?saved:row));void fileApi.storageUsage(api,organizationId).then(setStorageUsage).catch(()=>undefined)}}/>}
    </section>
  );
}
