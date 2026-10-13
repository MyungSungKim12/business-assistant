import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { confirm, notify } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import type { BinarySource } from '../../platform/types';
import { fileApi, type FilePlatform } from './api';
import { formatTime, messageFor } from './errors';
import { formatSize, validateFile } from './fileValidation';
import type { FileAsset } from './schemas';
import './documents.css';

export interface FilePageProps { api: ApiClient; organizationId: string; readOnly: boolean }

/** 매장 파일 자료: 목록, 서명 URL 업로드(50MB 이하), 다운로드, 보관. */
export function FilePage({ api, organizationId, readOnly }: FilePageProps) {
  const [files, setFiles] = useState<FileAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [uploading, setUploading] = useState('');
  const [working, setWorking] = useState('');
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setFiles(await fileApi.list(api, organizationId, includeArchived));
      setLoadError('');
    } catch (e) { setLoadError(messageFor(e, { 403: '파일 접근 권한이 없습니다.' }, '파일을 불러오지 못했습니다.')); }
    finally { setLoading(false); }
  }, [api, organizationId, includeArchived]);
  useEffect(() => { void load(); }, [load]);

  const upload = async (sources: BinarySource[]) => {
    setError('');
    for (const source of sources) {
      try { validateFile(source); }
      catch (e) { setError(`${source.name}: ${e instanceof Error ? e.message : '올릴 수 없는 파일입니다.'}`); break; }
      setUploading(source.name);
      try {
        const saved = await fileApi.upload(api, organizationId, source);
        setFiles((old) => [saved, ...old.filter((row) => row.id !== saved.id)]);
        notify.success(`${source.name} 파일을 업로드했습니다.`);
      } catch (e) {
        setError(messageFor(e, { 403: '파일 업로드 권한이 없습니다.', 422: '파일 형식이나 크기를 확인하세요.' }, `${source.name} 업로드에 실패했습니다. 다시 시도해 주세요.`));
        break;
      } finally { setUploading(''); }
    }
  };

  const choose = async () => {
    setError('');
    const platform = api.filePlatform as FilePlatform;
    if (platform.pickFiles) {
      try { await upload(await platform.pickFiles()); }
      catch { setError('파일을 선택하지 못했습니다. 다시 시도해 주세요.'); }
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

  const download = async (file: FileAsset) => {
    setWorking(file.id);
    setError('');
    try { await fileApi.download(api, organizationId, file.id); notify.success(`${file.original_name} 다운로드를 시작했습니다.`); }
    catch (e) { setError(messageFor(e, { 403: '파일 다운로드 권한이 없습니다.', 404: '파일을 찾을 수 없습니다. 목록을 새로고침하세요.' }, `${file.original_name} 다운로드에 실패했습니다. 다시 시도해 주세요.`)); }
    finally { setWorking(''); }
  };
  const archive = async (file: FileAsset) => {
    if (!(await confirm({ title: '파일 보관', message: `${file.original_name} 파일을 보관하시겠습니까? 보관한 파일은 다운로드할 수 없습니다.`, confirmLabel: '보관', tone: 'danger' }))) return;
    setWorking(file.id);
    setError('');
    try {
      const saved = await fileApi.archive(api, organizationId, file.id);
      setFiles((old) => (includeArchived ? old.map((row) => (row.id === saved.id ? saved : row)) : old.filter((row) => row.id !== saved.id)));
      notify.success('파일을 보관했습니다.');
    } catch (e) { setError(messageFor(e, { 403: '파일 보관 권한이 없습니다(관리자만 가능).', 404: '파일을 찾을 수 없습니다.' }, '파일을 보관하지 못했습니다. 다시 시도해 주세요.')); }
    finally { setWorking(''); }
  };

  const rows = files.filter((row) => row.original_name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return (
    <section className="doc-page file-page">
      <div className="page-toolbar">
        <div><p className="eyebrow">FILES</p><h1>파일·자료</h1><p className="muted">매장 파일을 안전하게 보관합니다. 한 파일은 50MB 이하만 올릴 수 있습니다.</p></div>
        <div className="doc-actions">
          <input aria-label="파일 검색" placeholder="파일명 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
          <label className="doc-check"><input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />보관 파일 포함</label>
          <button type="button" onClick={() => void load()}>새로고침</button>
          {!readOnly && <button type="button" className="primary-button" disabled={uploading !== ''} onClick={() => void choose()}>{uploading ? `${uploading} 업로드 중…` : '파일 올리기'}</button>}
          <input ref={input} type="file" multiple hidden aria-label="업로드할 파일" onChange={(e) => void picked(e)} />
        </div>
      </div>
      {error && <p role="alert" className="form-error">{error}</p>}
      {loadError && <p role="alert" className="form-error">{loadError} <button type="button" onClick={() => void load()}>다시 시도</button></p>}
      <div className="data-surface">
        {loading ? <p className="muted">파일을 불러오는 중…</p> : <table aria-label="파일 목록">
          <thead><tr><th>파일명</th><th>형식</th><th>크기</th><th>등록일</th><th>작업</th></tr></thead>
          <tbody>{rows.map((file) => <tr key={file.id}>
            <td>{file.original_name}{file.is_archived && <span className="doc-badge">보관됨</span>}</td><td>{file.content_type}</td><td>{formatSize(file.size_bytes)}</td><td>{formatTime(file.created_at)}</td>
            <td className="row-actions">
              <button type="button" disabled={file.is_archived || working === file.id} onClick={() => void download(file)}>다운로드</button>
              {!readOnly && <button type="button" className="danger-button" disabled={file.is_archived || working === file.id} onClick={() => void archive(file)}>보관</button>}
            </td></tr>)}</tbody>
        </table>}
        {!loading && !loadError && rows.length === 0 && <p className="empty-state">등록된 파일이 없습니다.</p>}
      </div>
    </section>
  );
}
