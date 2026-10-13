import { useEffect, useState } from 'react';
import { Modal } from '@business-assistant/react-ui';
import type { CustomerPhoto } from '../../../api/schemas';
import { kstDateTime } from '../kst';
import { formatPhotoSize } from './photoGroups';
import type { ThumbnailLoader } from './thumbnailLoader';

type Props = {
  photos: CustomerPhoto[];
  index: number;
  loader: ThumbnailLoader;
  readOnly: boolean;
  error: string;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  onArchive: (photo: CustomerPhoto) => void;
};

/** 사진 크게 보기. 이전/다음(버튼·방향키), 캡션·파일명·크기·등록일, 다운로드, 보관. Esc로 닫는다. */
export function PhotoLightbox({ photos, index, loader, readOnly, error, onIndexChange, onClose, onArchive }: Props) {
  const photo = photos[index];
  const [url, setUrl] = useState<string | null>(() => loader.peek(photo.id));
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const hasPrevious = index > 0;
  const hasNext = index < photos.length - 1;

  useEffect(() => {
    let alive = true;
    setUrl(loader.peek(photo.id));
    setFailed(false);
    loader.load(photo, true).then((next) => { if (alive) setUrl(next); }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [loader, photo, attempt]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft' && hasPrevious) { event.preventDefault(); onIndexChange(index - 1); }
      if (event.key === 'ArrowRight' && hasNext) { event.preventDefault(); onIndexChange(index + 1); }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [index, hasPrevious, hasNext, onIndexChange]);

  return (
    <Modal title={photo.original_name} size="lg" onClose={onClose}>
      <div className="pg-lightbox">
        <div className="pg-stage">
          <button type="button" className="pg-nav" aria-label="이전 사진" disabled={!hasPrevious} onClick={() => onIndexChange(index - 1)}>‹</button>
          <div className="pg-stage__image">
            {url ? <img src={url} alt={photo.caption || photo.original_name} /> : <span className="muted">{failed ? '사진을 불러오지 못했습니다.' : '불러오는 중…'}</span>}
          </div>
          <button type="button" className="pg-nav" aria-label="다음 사진" disabled={!hasNext} onClick={() => onIndexChange(index + 1)}>›</button>
        </div>
        <dl className="pg-meta">
          <div><dt>파일명</dt><dd>{photo.original_name}</dd></div>
          <div><dt>캡션</dt><dd>{photo.caption || '-'}</dd></div>
          <div><dt>크기</dt><dd>{formatPhotoSize(photo.size_bytes)}</dd></div>
          <div><dt>등록일</dt><dd>{kstDateTime(photo.created_at)}</dd></div>
          <div><dt>순서</dt><dd>{index + 1} / {photos.length}</dd></div>
        </dl>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="pg-lightbox__actions">
          {failed && <button type="button" onClick={() => setAttempt((count) => count + 1)}>다시 시도</button>}
          {url ? <a className="pg-download" href={url} download={photo.original_name}>다운로드</a> : <button type="button" disabled>다운로드</button>}
          {!readOnly && <button type="button" className="ba-danger" onClick={() => onArchive(photo)}>보관</button>}
        </div>
      </div>
    </Modal>
  );
}
