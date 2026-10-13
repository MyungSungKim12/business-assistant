import { useEffect, useRef, useState } from 'react';
import { Modal } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { fileApi } from './api';
import { messageFor } from './errors';
import { formatSize } from './fileValidation';
import type { FileAsset } from './schemas';

type Loaded = { fileId: string; url: string; kind: 'image' | 'pdf' };

type Props = {
  api: ApiClient;
  organizationId: string;
  /** 미리보기를 지원하는 파일만, 목록 순서대로. */
  files: FileAsset[];
  startId: string;
  readOnly: boolean;
  onClose: () => void;
  onDownload: (file: FileAsset) => Promise<void>;
  /** 확인 후 보관했으면 true. 보관하면 이 창은 닫힌다. */
  onArchive: (file: FileAsset) => Promise<boolean>;
};

const errorMessages = { 403: '파일 접근 권한이 없습니다.', 404: '파일을 찾을 수 없습니다. 목록을 새로고침하세요.' } as const;

/** 이미지(png/jpg/webp)와 PDF 를 서명 URL → 바이트 → blob URL 로 보여 주는 창. 이전/다음 파일로 넘기고 다운로드·보관을 할 수 있다. */
export function FilePreviewModal({ api, organizationId, files, startId, readOnly, onClose, onDownload, onArchive }: Props) {
  const [currentId, setCurrentId] = useState(startId);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const index = files.findIndex((file) => file.id === currentId);
  const file = index >= 0 ? files[index] : undefined;
  const fileId = file?.id;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!fileId) {
      closeRef.current();
      return;
    }
    let alive = true;
    let objectUrl = '';
    setLoaded(null);
    setError('');
    fileApi.fetchPreview(api, organizationId, fileId).then(({ blob, kind }) => {
      if (!alive) return;
      objectUrl = URL.createObjectURL(blob);
      setLoaded({ fileId, url: objectUrl, kind });
    }).catch((reason: unknown) => {
      if (alive) setError(messageFor(reason, errorMessages, '미리보기를 불러오지 못했습니다. 다운로드로 확인해 주세요.'));
    });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, organizationId, fileId]);

  if (!file) return null;
  const ready = loaded !== null && loaded.fileId === file.id;
  const move = (step: number) => {
    const next = files[index + step];
    if (next) setCurrentId(next.id);
  };
  const archive = async () => {
    setBusy(true);
    try {
      if (await onArchive(file)) onClose();
    } finally { setBusy(false); }
  };
  const download = async () => {
    setBusy(true);
    try { await onDownload(file); } finally { setBusy(false); }
  };

  return (
    <Modal title={`미리보기 · ${file.original_name} (${index + 1}/${files.length})`} size="xl" onClose={onClose}>
      <div className="file-preview">
        <div className="file-preview__stage" aria-busy={!ready && !error}>
          {error && <p role="alert" className="form-error">{error}</p>}
          {!ready && !error && <p className="muted">미리보기를 불러오는 중…</p>}
          {ready && loaded.kind === 'image' && <img className="file-preview__image" src={loaded.url} alt={file.original_name} />}
          {ready && loaded.kind === 'pdf' && <iframe className="file-preview__frame" title={`${file.original_name} PDF 미리보기`} src={loaded.url} />}
        </div>
        <p className="muted file-preview__info">{file.content_type} · {formatSize(file.size_bytes)}{loaded?.kind === 'pdf' ? ' · PDF가 보이지 않으면 다운로드해서 확인하세요.' : ''}</p>
        <div className="doc-actions">
          <button type="button" disabled={index <= 0} onClick={() => move(-1)}>이전 파일</button>
          <button type="button" disabled={index >= files.length - 1} onClick={() => move(1)}>다음 파일</button>
          <span className="doc-spacer" />
          <button type="button" disabled={busy} onClick={() => void download()}>다운로드</button>
          {!readOnly && <button type="button" className="danger-button" disabled={busy} onClick={() => void archive()}>보관</button>}
          <button type="button" onClick={onClose}>닫기</button>
        </div>
      </div>
    </Modal>
  );
}
