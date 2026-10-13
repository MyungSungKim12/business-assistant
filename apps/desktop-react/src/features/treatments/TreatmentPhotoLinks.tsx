import { useEffect, useMemo, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { downloadPhotoBlob, ThumbnailLoader } from '../customers/photos/thumbnailLoader';
import type { PhotoPhase } from './api';
import { PhotoCompare } from './PhotoCompare';
import { PhotoLinkPicker } from './PhotoLinkPicker';
import { comparablePhotos, groupByPhase, photoLabel, PHASE_LABEL, PHASES, phaseOf, resolveLinks, unlinkedPhotos, type ResolvedLink } from './photoLinks';
import { useTreatmentPhotoLinks } from './useTreatmentPhotoLinks';
import { usePhotoUrl } from './usePhotoUrl';

type Props = {
  api: ApiClient;
  organizationId: string;
  customerId: string;
  treatmentId: string;
  /** 머리글에 보여 줄 시술 이름(예: "수분 관리 · 2026-09-18"). */
  treatmentLabel: string;
  readOnly: boolean;
};

type TileProps = {
  item: ResolvedLink;
  loader: ThumbnailLoader | null;
  readOnly: boolean;
  busy: boolean;
  onPhase: (item: ResolvedLink, phase: PhotoPhase) => void;
  onUnlink: (item: ResolvedLink) => void;
};

function LinkTile({ item, loader, readOnly, busy, onPhase, onUnlink }: TileProps) {
  const { url, failed } = usePhotoUrl(loader, item.photo);
  const label = photoLabel(item);
  return (
    <li className="tpl-tile">
      <div className="tpl-tile__image" title={label}>
        {url ? <img src={url} alt={label} /> : <span className="muted">{!item.photo ? '원본 없음' : failed ? '불러오기 실패' : '…'}</span>}
      </div>
      <span className="tpl-tile__name" title={label}>{label}</span>
      {!readOnly && (
        <div className="tpl-tile__actions">
          <select aria-label={`${label} 구분`} value={phaseOf(item.link)} disabled={busy} onChange={(event) => onPhase(item, event.target.value as PhotoPhase)}>
            {PHASES.map((phase) => <option key={phase} value={phase}>{PHASE_LABEL[phase]}</option>)}
          </select>
          <button type="button" aria-label={`${label} 연결 해제`} title="연결 해제" disabled={busy} onClick={() => onUnlink(item)}>×</button>
        </div>
      )}
    </li>
  );
}

/**
 * 선택한 시술에 연결된 고객 사진을 시술 전/후/기타로 보여 주고, 연결·구분 변경·해제(관리자)와 전/후 비교를 제공한다.
 * 읽기 전용(멤버)은 조회와 비교만 할 수 있다.
 */
export function TreatmentPhotoLinks({ api, organizationId, customerId, treatmentId, treatmentLabel, readOnly }: Props) {
  const state = useTreatmentPhotoLinks({ api, organizationId, customerId, treatmentId });
  const [loader, setLoader] = useState<ThumbnailLoader | null>(null);
  const [picking, setPicking] = useState(false);
  const [comparing, setComparing] = useState(false);
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    const next = new ThumbnailLoader((photo) => downloadPhotoBlob(apiRef.current, organizationId, customerId, photo));
    setLoader(next);
    return () => next.dispose();
  }, [organizationId, customerId]);

  const resolved = useMemo(() => resolveLinks(state.links, state.customerPhotos), [state.links, state.customerPhotos]);
  const groups = useMemo(() => groupByPhase(resolved), [resolved]);
  const comparable = useMemo(() => comparablePhotos(groups), [groups]);
  const candidates = useMemo(() => unlinkedPhotos(state.customerPhotos, state.links), [state.customerPhotos, state.links]);
  const canCompare = comparable.before.length > 0 && comparable.after.length > 0;

  return (
    <section className="tpl" aria-label="시술 전/후 사진">
      <header className="tpl__head">
        <h3 title={treatmentLabel}>시술 전/후 · {treatmentLabel}</h3>
        <span className="doc-spacer" />
        {!readOnly && <button type="button" disabled={state.loading || state.busy || !loader} onClick={() => setPicking(true)}>사진 연결</button>}
        <button type="button" disabled={!canCompare} title={canCompare ? undefined : '시술 전과 시술 후 사진을 각각 연결하면 비교할 수 있습니다.'} onClick={() => setComparing(true)}>전/후 비교</button>
      </header>
      {state.loadError && <p className="form-error tpl__message">{state.loadError} <button type="button" onClick={() => void state.reload()}>전/후 사진 다시 불러오기</button></p>}
      {state.notice && <p className="form-error tpl__message" role="status">{state.notice}</p>}
      <div className="tpl__body">
        {state.loading && state.links.length === 0 && <p className="muted tpl__empty">불러오는 중…</p>}
        {!state.loading && !state.loadError && state.links.length === 0 && (
          <p className="muted tpl__empty">연결된 사진이 없습니다.{readOnly ? '' : ' ‘사진 연결’로 고객 사진에서 시술 전/후를 지정하세요.'}</p>
        )}
        {PHASES.map((phase) => groups[phase].length > 0 && (
          <section key={phase} className="tpl-group" aria-label={`${PHASE_LABEL[phase]} 사진`}>
            <h4>{PHASE_LABEL[phase]} <span className="muted">{groups[phase].length}장</span></h4>
            <ul className="tpl-tiles">
              {groups[phase].map((item) => (
                <LinkTile key={item.link.id} item={item} loader={loader} readOnly={readOnly} busy={state.busy}
                  onPhase={(target, next) => void state.setPhase(target.link, next)} onUnlink={(target) => void state.unlink(target.link, photoLabel(target))} />
              ))}
            </ul>
          </section>
        ))}
      </div>
      {picking && loader && <PhotoLinkPicker photos={candidates} loader={loader} busy={state.busy} onClose={() => setPicking(false)} onLink={state.link} />}
      {comparing && loader && canCompare && <PhotoCompare before={comparable.before} after={comparable.after} loader={loader} onClose={() => setComparing(false)} />}
    </section>
  );
}
