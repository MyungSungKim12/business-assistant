import { useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { Modal } from '@business-assistant/react-ui';
import type { ThumbnailLoader } from '../customers/photos/thumbnailLoader';
import { clampPan, clampSlider, clampZoom, MAX_ZOOM, MIN_ZOOM, photoLabel, ZOOM_STEP, type AlivePhoto, type Pan } from './photoLinks';
import { usePhotoUrl, type PhotoUrl } from './usePhotoUrl';

type Mode = 'side' | 'slider';

type Props = {
  before: AlivePhoto[];
  after: AlivePhoto[];
  loader: ThumbnailLoader;
  onClose: () => void;
};

/** 확대한 사진을 끌어서 옮기는 틀. 확대하지 않았으면(배율 1) 끌어도 움직이지 않는다. */
function Frame({ zoom, pan, onPan, label, children }: { zoom: number; pan: Pan; onPan: (pan: Pan) => void; label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; pan: Pan } | null>(null);
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (zoom <= MIN_ZOOM) return;
    drag.current = { x: event.clientX, y: event.clientY, pan };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    const element = ref.current;
    if (!start || !element) return;
    onPan(clampPan({ x: start.pan.x + event.clientX - start.x, y: start.pan.y + event.clientY - start.y }, zoom, element.clientWidth, element.clientHeight));
  };
  const end = () => { drag.current = null; };
  return (
    <div ref={ref} className={`cmp-frame${zoom > MIN_ZOOM ? ' is-zoomed' : ''}`} role="group" aria-label={label} onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      {children}
    </div>
  );
}

/** 같은 크기의 틀 안에 사진을 맞춰(contain) 넣고, 두 사진이 같은 배율·위치로 움직이게 한다. */
function Layer({ source, alt, zoom, pan }: { source: PhotoUrl; alt: string; zoom: number; pan: Pan }) {
  if (!source.url) return <span className="cmp-status muted">{source.failed ? '사진을 불러오지 못했습니다.' : '불러오는 중…'}</span>;
  return (
    <div className="cmp-layer" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
      <img src={source.url} alt={alt} draggable={false} />
    </div>
  );
}

function PhotoSelect({ label, items, value, onChange }: { label: string; items: AlivePhoto[]; value: string; onChange: (id: string) => void }) {
  return (
    <label className="cmp-select">{label}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {items.map((item) => <option key={item.link.id} value={item.link.id}>{photoLabel(item)}</option>)}
      </select>
    </label>
  );
}

/**
 * 시술 전/후 사진 비교 창: 좌우 나란히 또는 슬라이더 겹쳐 보기, 확대(1~4배)와 끌어서 이동, 같은 크기 틀 맞춤.
 * 읽기 전용 멤버도 쓸 수 있다(저장하는 것이 없다).
 */
export function PhotoCompare({ before, after, loader, onClose }: Props) {
  const [beforeId, setBeforeId] = useState(before[0]?.link.id ?? '');
  const [afterId, setAfterId] = useState(after[0]?.link.id ?? '');
  const [mode, setMode] = useState<Mode>('side');
  const [zoom, setZoomState] = useState(MIN_ZOOM);
  const [pan, setPan] = useState<Pan>({ x: 0, y: 0 });
  const [slider, setSlider] = useState(50);
  const stage = useRef<HTMLDivElement>(null);

  const beforeItem = before.find((item) => item.link.id === beforeId) ?? before[0];
  const afterItem = after.find((item) => item.link.id === afterId) ?? after[0];
  const beforeUrl = usePhotoUrl(loader, beforeItem?.photo ?? null, true);
  const afterUrl = usePhotoUrl(loader, afterItem?.photo ?? null, true);

  const setZoom = (value: number) => {
    const next = clampZoom(value);
    setZoomState(next);
    const frame = stage.current?.querySelector<HTMLElement>('.cmp-frame');
    setPan((old) => clampPan(old, next, frame?.clientWidth ?? 0, frame?.clientHeight ?? 0));
  };
  const reset = () => { setZoomState(MIN_ZOOM); setPan({ x: 0, y: 0 }); };

  return (
    <Modal title="시술 전/후 비교" size="xl" onClose={onClose}>
      <div className="cmp">
        <div className="cmp-controls">
          <PhotoSelect label="시술 전" items={before} value={beforeItem?.link.id ?? ''} onChange={setBeforeId} />
          <PhotoSelect label="시술 후" items={after} value={afterItem?.link.id ?? ''} onChange={setAfterId} />
          <div role="radiogroup" aria-label="비교 방식" className="doc-actions">
            <label className="doc-check"><input type="radio" name="cmp-mode" checked={mode === 'side'} onChange={() => setMode('side')} />나란히 보기</label>
            <label className="doc-check"><input type="radio" name="cmp-mode" checked={mode === 'slider'} onChange={() => setMode('slider')} />슬라이더 비교</label>
          </div>
          <div className="doc-actions" aria-label="확대">
            <button type="button" aria-label="축소" disabled={zoom <= MIN_ZOOM} onClick={() => setZoom(zoom - ZOOM_STEP)}>−</button>
            <input type="range" aria-label="확대 비율" min={MIN_ZOOM * 100} max={MAX_ZOOM * 100} step={ZOOM_STEP * 100} value={Math.round(zoom * 100)} onChange={(event) => setZoom(Number(event.target.value) / 100)} />
            <button type="button" aria-label="확대" disabled={zoom >= MAX_ZOOM} onClick={() => setZoom(zoom + ZOOM_STEP)}>+</button>
            <span className="muted cmp-zoom" role="status">{Math.round(zoom * 100)}%</span>
            <button type="button" disabled={zoom === MIN_ZOOM && pan.x === 0 && pan.y === 0} onClick={reset}>맞춤</button>
          </div>
        </div>

        {mode === 'side' ? (
          <div className="cmp-side" ref={stage}>
            <figure className="cmp-figure">
              <figcaption>시술 전 · {beforeItem ? photoLabel(beforeItem) : ''}</figcaption>
              <Frame zoom={zoom} pan={pan} onPan={setPan} label="시술 전 사진"><Layer source={beforeUrl} alt="시술 전 사진" zoom={zoom} pan={pan} /></Frame>
            </figure>
            <figure className="cmp-figure">
              <figcaption>시술 후 · {afterItem ? photoLabel(afterItem) : ''}</figcaption>
              <Frame zoom={zoom} pan={pan} onPan={setPan} label="시술 후 사진"><Layer source={afterUrl} alt="시술 후 사진" zoom={zoom} pan={pan} /></Frame>
            </figure>
          </div>
        ) : (
          <div className="cmp-overlay" ref={stage}>
            <Frame zoom={zoom} pan={pan} onPan={setPan} label="시술 전/후 겹쳐 보기">
              <Layer source={beforeUrl} alt="시술 전 사진" zoom={zoom} pan={pan} />
              <div className="cmp-clip" style={{ clipPath: `inset(0 0 0 ${slider}%)` }}>
                <Layer source={afterUrl} alt="시술 후 사진" zoom={zoom} pan={pan} />
              </div>
              <span className="cmp-divider" style={{ left: `${slider}%` }} aria-hidden="true" />
              <span className="cmp-tag cmp-tag--before" aria-hidden="true">시술 전</span>
              <span className="cmp-tag cmp-tag--after" aria-hidden="true">시술 후</span>
            </Frame>
            <input type="range" className="cmp-slider" aria-label="비교 위치" min={0} max={100} step={1} value={slider} onChange={(event) => setSlider(clampSlider(Number(event.target.value)))} />
          </div>
        )}

        <div className="doc-actions">
          <span className="muted">확대하면 사진을 끌어서 옮길 수 있고, 두 사진은 같은 위치로 함께 움직입니다.</span>
          <span className="doc-spacer" />
          <button type="button" onClick={onClose}>닫기</button>
        </div>
      </div>
    </Modal>
  );
}
