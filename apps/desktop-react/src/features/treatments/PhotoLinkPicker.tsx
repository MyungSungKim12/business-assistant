import { useState } from 'react';
import { Modal } from '@business-assistant/react-ui';
import type { CustomerPhoto } from '../../api/schemas';
import { PhotoThumb } from '../customers/photos/PhotoThumb';
import type { ThumbnailLoader } from '../customers/photos/thumbnailLoader';
import '../customers/photos/photoGallery.css';
import type { PhotoPhase } from './api';
import { PHASE_LABEL, PHASES } from './photoLinks';

type Props = {
  /** 이 시술에 아직 연결되지 않은 고객 사진. */
  photos: CustomerPhoto[];
  loader: ThumbnailLoader;
  busy: boolean;
  onClose: () => void;
  /** 고른 사진을 같은 구분으로 연결한다. 한 장이라도 연결하면 창을 닫는다. */
  onLink: (photos: CustomerPhoto[], phase: PhotoPhase) => Promise<number>;
};

/** 고객 사진 중 이 시술에 연결할 사진을 고르고 시술 전/후/기타를 정하는 창. 사진을 다시 올리지 않는다. */
export function PhotoLinkPicker({ photos, loader, busy, onClose, onLink }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<PhotoPhase>('before');

  const toggle = (photo: CustomerPhoto) => setSelected((old) => {
    const next = new Set(old);
    if (next.has(photo.id)) next.delete(photo.id); else next.add(photo.id);
    return next;
  });
  const submit = async () => {
    const chosen = photos.filter((photo) => selected.has(photo.id));
    if (chosen.length === 0) return;
    if (await onLink(chosen, phase) > 0) onClose();
  };

  return (
    <Modal title="고객 사진에서 시술 사진 연결" size="lg" onClose={onClose}>
      <div className="tpl-picker">
        <fieldset className="tpl-picker__phase" disabled={busy}>
          <legend>구분</legend>
          {PHASES.map((value) => (
            <label key={value} className="doc-check"><input type="radio" name="photo-phase" checked={phase === value} onChange={() => setPhase(value)} />{PHASE_LABEL[value]}</label>
          ))}
        </fieldset>
        {photos.length === 0
          ? <p className="muted">연결할 수 있는 고객 사진이 없습니다. 이미 모두 연결했거나 고객 사진이 없습니다. 사진은 고객 사진 영역의 ‘사진 추가’로 먼저 등록하세요.</p>
          : (
            <div className="pg-root tpl-picker__grid" data-size="compact">
              <div className="pg-grid">
                {photos.map((photo) => (
                  <PhotoThumb key={photo.id} photo={photo} loader={loader} onOpen={toggle} showName selectMode selected={selected.has(photo.id)} onToggleSelect={toggle} />
                ))}
              </div>
            </div>
          )}
        <div className="doc-actions">
          <span className="muted" role="status">{selected.size}장 선택</span>
          <span className="doc-spacer" />
          <button type="button" className="primary-button" disabled={busy || selected.size === 0} onClick={() => void submit()}>
            {busy ? '연결 중…' : `${PHASE_LABEL[phase]} 사진으로 연결`}
          </button>
          <button type="button" onClick={onClose}>닫기</button>
        </div>
      </div>
    </Modal>
  );
}
