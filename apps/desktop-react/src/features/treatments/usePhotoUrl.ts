import { useEffect, useState } from 'react';
import type { CustomerPhoto } from '../../api/schemas';
import type { ThumbnailLoader } from '../customers/photos/thumbnailLoader';

export type PhotoUrl = { url: string | null; failed: boolean };

/** 고객 사진 한 장의 objectURL. 로더가 캐시하므로 같은 사진을 여러 곳에서 써도 한 번만 내려받는다. */
export function usePhotoUrl(loader: ThumbnailLoader | null, photo: CustomerPhoto | null, priority = false): PhotoUrl {
  const [state, setState] = useState<PhotoUrl>(() => ({ url: loader && photo ? loader.peek(photo.id) : null, failed: false }));

  useEffect(() => {
    if (!loader || !photo) {
      setState({ url: null, failed: false });
      return;
    }
    let alive = true;
    setState({ url: loader.peek(photo.id), failed: false });
    loader.load(photo, priority)
      .then((url) => { if (alive) setState({ url, failed: false }); })
      .catch(() => { if (alive) setState({ url: null, failed: true }); });
    return () => { alive = false; };
  }, [loader, photo, priority]);

  return state;
}
