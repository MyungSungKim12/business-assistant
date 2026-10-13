import { useEffect, useRef, useState } from 'react';
import type { CustomerPhoto } from '../../../api/schemas';
import { describePhotoError } from './photoErrors';
import type { ThumbnailLoader } from './thumbnailLoader';

type Props = {
  photo: CustomerPhoto;
  loader: ThumbnailLoader;
  onOpen: (photo: CustomerPhoto) => void;
  showName: boolean;
  /** 선택 모드: 체크 표시를 보여 주고 클릭하면 크게 보기 대신 선택을 바꾼다. */
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (photo: CustomerPhoto) => void;
  /** 있으면 썸네일 모서리에 삭제 버튼을 보여 준다(보기 전용이면 넘기지 않는다). */
  onDelete?: (photo: CustomerPhoto) => void;
};

/** 화면에 보일 때(IntersectionObserver, 없으면 즉시) 이미지를 불러오는 썸네일. 실패하면 '다시 시도' 칩을 보여 준다. */
export function PhotoThumb({ photo, loader, onOpen, showName, selectMode = false, selected = false, onToggleSelect, onDelete }: Props) {
  const tile = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');
  const [url, setUrl] = useState<string | null>(() => loader.peek(photo.id));
  const [failed, setFailed] = useState(false);
  const [reason, setReason] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (visible || !tile.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '120px' });
    observer.observe(tile.current);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible || url) return;
    let alive = true;
    setFailed(false);
    loader.load(photo).then((next) => { if (alive) setUrl(next); }).catch((error) => { if (alive) { setFailed(true); setReason(describePhotoError(error)); } });
    return () => { alive = false; };
  }, [visible, url, attempt, loader, photo]);

  const label = photo.caption || photo.original_name;
  return (
    <div className={`pg-tile${selected ? ' is-selected' : ''}`} ref={tile} data-photo-id={photo.id}>
      <button type="button" className="pg-open" aria-label={selectMode ? `${photo.original_name} 선택` : `${photo.original_name} 크게 보기`} aria-pressed={selectMode ? selected : undefined} title={label} onClick={() => (selectMode ? onToggleSelect?.(photo) : onOpen(photo))}>
        {url ? <img src={url} alt={label} /> : <span className="pg-placeholder" title={failed ? reason : undefined}>{failed ? '불러오기 실패' : visible ? '불러오는 중…' : ''}</span>}
      </button>
      {selectMode && <span className={`pg-check${selected ? ' is-on' : ''}`} aria-hidden="true">{selected ? '✓' : ''}</span>}
      {!selectMode && onDelete && <button type="button" className="pg-delete" aria-label={`${photo.original_name} 삭제`} title="삭제" onClick={() => onDelete(photo)}>×</button>}
      {failed && <p className="pg-reason" role="alert">{reason}</p>}
      {failed && <button type="button" className="pg-chip" onClick={() => setAttempt((count) => count + 1)}>다시 시도</button>}
      {showName && <span className="pg-name" title={photo.original_name}>{photo.original_name}</span>}
    </div>
  );
}
