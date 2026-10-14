import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { confirm } from '@business-assistant/react-ui';
import type { ApiClient } from '../../../api/client';
import type { CustomerPhoto } from '../../../api/schemas';
import { PhotoLightbox } from './PhotoLightbox';
import { PhotoTrashDialog } from './PhotoTrashDialog';
import { PhotoThumb } from './PhotoThumb';
import { groupPhotosByDate, groupTitle, type PhotoGroup } from './photoGroups';
import { downloadPhotoBlob, ThumbnailLoader } from './thumbnailLoader';
import { usePhotoLibrary } from './usePhotoLibrary';
import './photoGallery.css';

export type PhotoGalleryProps = {
  api: ApiClient;
  organizationId: string;
  customerId: string;
  readOnly: boolean;
  /** compact ≈ 96px(고객관리), large ≈ 200px(시술관리) */
  size: 'compact' | 'large';
  heading?: string;
  /** 지정하면 이 날짜(YYYY-MM-DD)의 사진을 맨 위에 강조해 보여 준다. */
  highlightDate?: string | null;
  highlightLabel?: string;
};

type SectionProps = {
  title: string;
  photos: CustomerPhoto[];
  collapsed: boolean;
  highlight?: boolean;
  emptyText?: string;
  loader: ThumbnailLoader;
  size: 'compact' | 'large';
  onToggle: () => void;
  onOpen: (photo: CustomerPhoto) => void;
  selectMode: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (photo: CustomerPhoto) => void;
  onDelete?: (photo: CustomerPhoto) => void;
};

function DateSection({ title, photos, collapsed, highlight, emptyText, loader, size, onToggle, onOpen, selectMode, selectedIds, onToggleSelect, onDelete }: SectionProps) {
  return (
    <section className={`pg-group${highlight ? ' pg-group--highlight' : ''}`} aria-label={title}>
      <button type="button" className="pg-group__head" aria-expanded={!collapsed} onClick={onToggle}>
        <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span> {title}
      </button>
      {!collapsed && (photos.length > 0
        ? <div className="pg-grid">{photos.map((photo) => <PhotoThumb key={photo.id} photo={photo} loader={loader} onOpen={onOpen} showName={size === 'large'} selectMode={selectMode} selected={selectedIds.has(photo.id)} onToggleSelect={onToggleSelect} onDelete={onDelete} />)}</div>
        : <p className="pg-empty-note muted">{emptyText}</p>)}
    </section>
  );
}

/** 고객 사진을 등록일(KST) 별로 묶어 썸네일 격자로 보여 주고, 크게 보기·등록·삭제(한 장 또는 여러 장 선택)를 제공한다. */
export function PhotoGallery({ api, organizationId, customerId, readOnly, size, heading = '사진', highlightDate = null, highlightLabel = '시술일 사진' }: PhotoGalleryProps) {
  const library = usePhotoLibrary(api, organizationId, customerId);
  const [loader, setLoader] = useState<ThumbnailLoader | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [lightboxError, setLightboxError] = useState('');
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [trashOpen, setTrashOpen] = useState(false);
  const apiRef = useRef(api);
  apiRef.current = api;
  const confirming = useRef(false);

  useEffect(() => {
    const next = new ThumbnailLoader((photo) => downloadPhotoBlob(apiRef.current, organizationId, customerId, photo));
    setLoader(next);
    setCollapsed(new Set());
    setOpenId(null);
    setSelectMode(false);
    setSelectedIds(new Set());
    setTrashOpen(false);
    return () => next.dispose();
  }, [organizationId, customerId]);

  const { sections, ordered } = useMemo(() => {
    const groups = groupPhotosByDate(library.items);
    const highlighted: PhotoGroup | null = highlightDate ? { date: highlightDate, photos: groups.find((group) => group.date === highlightDate)?.photos ?? [] } : null;
    const rest = highlightDate ? groups.filter((group) => group.date !== highlightDate) : groups;
    return { sections: { highlighted, rest }, ordered: [...(highlighted?.photos ?? []), ...rest.flatMap((group) => group.photos)] };
  }, [library.items, highlightDate]);

  const toggle = useCallback((key: string) => setCollapsed((old) => {
    const next = new Set(old);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  }), []);
  const open = useCallback((photo: CustomerPhoto) => { setLightboxError(''); setOpenId(photo.id); }, []);
  const closeLightbox = useCallback(() => { if (!confirming.current) setOpenId(null); }, []);
  const moveLightbox = useCallback((index: number) => {
    if (confirming.current) return;
    const target = ordered[index];
    if (target) setOpenId(target.id);
  }, [ordered]);

  const toggleSelect = useCallback((photo: CustomerPhoto) => setSelectedIds((old) => {
    const next = new Set(old);
    if (next.has(photo.id)) next.delete(photo.id); else next.add(photo.id);
    return next;
  }), []);
  const endSelect = () => { setSelectMode(false); setSelectedIds(new Set()); };

  /** 선택한 사진을 한 번 확인한 뒤 모두 삭제한다. 일부 실패하면 실패한 사진만 선택된 채로 남긴다. */
  async function deleteSelected() {
    if (confirming.current) return;
    const targets = library.items.filter((photo) => selectedIds.has(photo.id));
    if (targets.length === 0) return;
    confirming.current = true;
    let accepted = false;
    try {
      accepted = await confirm({ title: '사진 삭제', message: `선택한 사진 ${targets.length}장을 삭제하시겠습니까? 목록에서 사라집니다.`, confirmLabel: '삭제', tone: 'danger' });
    } finally {
      confirming.current = false;
    }
    if (!accepted) return;
    const { done, failed } = await library.archiveMany(targets);
    done.forEach((photo) => loader?.release(photo.id));
    if (failed.length === 0) endSelect(); else setSelectedIds(new Set(failed.map((photo) => photo.id)));
  }

  async function archive(photo: CustomerPhoto) {
    if (confirming.current) return;
    confirming.current = true;
    let accepted = false;
    try {
      accepted = await confirm({ title: '사진 삭제', message: `${photo.original_name} 사진을 삭제하시겠습니까? 목록에서 사라집니다.`, confirmLabel: '삭제', tone: 'danger' });
    } finally {
      confirming.current = false;
    }
    if (!accepted) return;
    const index = ordered.findIndex((item) => item.id === photo.id);
    if (!await library.archive(photo)) { setLightboxError('사진 삭제에 실패했습니다. 다시 시도해 주세요.'); return; }
    loader?.release(photo.id);
    setLightboxError('');
    const neighbor = ordered[index + 1] ?? ordered[index - 1];
    setOpenId((current) => (current === photo.id ? neighbor?.id ?? null : current));
  }

  const openIndex = openId ? ordered.findIndex((photo) => photo.id === openId) : -1;
  const pinned = sections.highlighted;
  const empty = !library.loading && !library.loadError && library.items.length === 0;

  return (
    <div className="pg-root" data-size={size}>
      <div className="pg-toolbar">
        {heading && <h3>{heading}</h3>}
        <span className="muted" aria-live="polite">{library.loading ? '불러오는 중…' : `${library.items.length}장`}</span>
        <span className="pg-toolbar__spacer" />
        {library.uploading && <span className="muted" role="status">업로드 중…</span>}
        {!readOnly && selectMode && (
          <>
            <span className="muted" role="status">{selectedIds.size}장 선택</span>
            <button type="button" onClick={() => setSelectedIds(new Set(library.items.map((photo) => photo.id)))}>전체 선택</button>
            <button type="button" className="ba-danger" disabled={selectedIds.size === 0} onClick={() => void deleteSelected()}>선택 삭제</button>
            <button type="button" onClick={endSelect}>선택 취소</button>
          </>
        )}
        {!readOnly && !selectMode && library.items.length > 0 && <button type="button" onClick={() => setSelectMode(true)}>선택</button>}
        {!readOnly && !selectMode && <button type="button" onClick={() => setTrashOpen(true)}>휴지통</button>}
        {!readOnly && !selectMode && <button type="button" disabled={library.uploading} onClick={() => void library.upload()}>사진 추가</button>}
      </div>
      {library.loadError && <p className="form-error pg-message" role="alert">{library.loadError} <button type="button" aria-label="사진 목록 다시 시도" onClick={() => void library.reload()}>다시 시도</button></p>}
      {library.notice && <p className="form-error pg-message" role="alert">{library.notice}</p>}
      <div className="pg-body">
        {loader && pinned && (
          <DateSection title={`${highlightLabel} · ${groupTitle(pinned)}`} photos={pinned.photos} collapsed={collapsed.has('pinned')} highlight loader={loader} size={size}
            emptyText={`${pinned.date}에 등록된 사진이 없습니다.`} onToggle={() => toggle('pinned')} onOpen={open}
            selectMode={selectMode} selectedIds={selectedIds} onToggleSelect={toggleSelect} onDelete={readOnly ? undefined : (photo) => void archive(photo)} />
        )}
        {loader && sections.rest.map((group) => (
          <DateSection key={group.date || 'unknown'} title={groupTitle(group)} photos={group.photos} collapsed={collapsed.has(group.date)} loader={loader} size={size}
            onToggle={() => toggle(group.date)} onOpen={open}
            selectMode={selectMode} selectedIds={selectedIds} onToggleSelect={toggleSelect} onDelete={readOnly ? undefined : (photo) => void archive(photo)} />
        ))}
        {empty && <p className="pg-empty muted">등록된 사진이 없습니다.{readOnly ? '' : ' 오른쪽 위 ‘사진 추가’로 등록하세요.'}</p>}
        {library.loading && library.items.length === 0 && <p className="pg-empty muted">사진을 불러오는 중…</p>}
      </div>
      {trashOpen && <PhotoTrashDialog api={api} organizationId={organizationId} customerId={customerId} onRestored={() => void library.reload()} onClose={() => setTrashOpen(false)} />}
      {loader && openIndex >= 0 && (
        <PhotoLightbox photos={ordered} index={openIndex} loader={loader} readOnly={readOnly} error={lightboxError}
          onIndexChange={moveLightbox} onClose={closeLightbox} onArchive={(photo) => void archive(photo)} />
      )}
    </div>
  );
}
