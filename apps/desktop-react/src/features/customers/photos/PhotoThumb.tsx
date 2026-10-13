import { useEffect, useRef, useState } from 'react';
import type { CustomerPhoto } from '../../../api/schemas';
import { describePhotoError } from './photoErrors';
import type { ThumbnailLoader } from './thumbnailLoader';

type Props = { photo: CustomerPhoto; loader: ThumbnailLoader; onOpen: (photo: CustomerPhoto) => void; showName: boolean };

/** 화면에 보일 때(IntersectionObserver, 없으면 즉시) 이미지를 불러오는 썸네일. 실패하면 '다시 시도' 칩을 보여 준다. */
export function PhotoThumb({ photo, loader, onOpen, showName }: Props) {
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
    <div className="pg-tile" ref={tile} data-photo-id={photo.id}>
      <button type="button" className="pg-open" aria-label={`${photo.original_name} 크게 보기`} title={label} onClick={() => onOpen(photo)}>
        {url ? <img src={url} alt={label} /> : <span className="pg-placeholder" title={failed ? reason : undefined}>{failed ? '불러오기 실패' : visible ? '불러오는 중…' : ''}</span>}
      </button>
      {failed && <p className="pg-reason" role="alert">{reason}</p>}
      {failed && <button type="button" className="pg-chip" onClick={() => setAttempt((count) => count + 1)}>다시 시도</button>}
      {showName && <span className="pg-name" title={photo.original_name}>{photo.original_name}</span>}
    </div>
  );
}
