import type { CustomerPhoto } from '../../api/schemas';
import type { PhotoPhase, TreatmentPhoto } from './api';

export const PHASE_LABEL: Record<PhotoPhase, string> = { before: '시술 전', after: '시술 후', other: '기타' };
export const PHASES: PhotoPhase[] = ['before', 'after', 'other'];

/** 시술 사진 연결 한 건과, 같은 저장 경로를 가진 고객 사진(없으면 null: 원본이 삭제·보관됨). */
export type ResolvedLink = { link: TreatmentPhoto; photo: CustomerPhoto | null };
/** 원본 고객 사진이 살아 있는 연결(비교·미리보기에 쓸 수 있는 것). */
export type AlivePhoto = ResolvedLink & { photo: CustomerPhoto };
export type PhaseGroups = Record<PhotoPhase, ResolvedLink[]>;

/** phase 가 없는(미분류) 연결은 '기타'로 본다. */
export const phaseOf = (link: Pick<TreatmentPhoto, 'phase'>): PhotoPhase => link.phase ?? 'other';

/**
 * 연결 정보(treatment_photos)는 고객 사진을 복사하지 않고 같은 storage_path 를 가리킨다.
 * 그래서 사진을 다시 올리지 않고도 연결할 수 있고, 미리보기는 고객 사진 다운로드 URL 을 그대로 쓴다.
 */
export function resolveLinks(links: TreatmentPhoto[], customerPhotos: CustomerPhoto[]): ResolvedLink[] {
  const byPath = new Map(customerPhotos.map((photo) => [photo.storage_path, photo]));
  return links.map((link) => ({ link, photo: byPath.get(link.storage_path) ?? null }));
}

/** 구분별로 묶는다. 같은 구분 안에서는 정렬 번호 → 촬영(등록)일 순서를 지킨다. */
export function groupByPhase(resolved: ResolvedLink[]): PhaseGroups {
  const groups: PhaseGroups = { before: [], after: [], other: [] };
  for (const item of resolved) groups[phaseOf(item.link)].push(item);
  return groups;
}

/** 이 시술에 이미 연결된 고객 사진은 다시 고르지 않도록 제외한다(중복 연결 방지). */
export function unlinkedPhotos(customerPhotos: CustomerPhoto[], links: TreatmentPhoto[]): CustomerPhoto[] {
  const linked = new Set(links.map((link) => link.storage_path));
  return customerPhotos.filter((photo) => !linked.has(photo.storage_path));
}

/** 비교는 원본이 살아 있는 시술 전·후 사진이 각각 하나 이상 있어야 한다. */
export function comparablePhotos(groups: PhaseGroups): { before: AlivePhoto[]; after: AlivePhoto[] } {
  const alive = (items: ResolvedLink[]) => items.filter((item): item is AlivePhoto => item.photo !== null);
  return { before: alive(groups.before), after: alive(groups.after) };
}

export const photoLabel = (item: ResolvedLink): string => item.link.caption || item.photo?.original_name || '원본 사진 없음';

/** 연결할 때 붙이는 정렬 번호: 같은 구분의 다음 순서. */
export const nextSortOrder = (links: TreatmentPhoto[], phase: PhotoPhase): number => links.filter((link) => phaseOf(link) === phase).reduce((max, link) => Math.max(max, link.sort_order + 1), 0);

// ---- 비교 화면의 확대·이동 계산(화면과 분리해 단위 테스트한다) ----
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
export const ZOOM_STEP = 0.25;

export const clampZoom = (zoom: number): number => (Number.isFinite(zoom) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom * 100) / 100)) : MIN_ZOOM);

export type Pan = { x: number; y: number };

/** 확대한 만큼만 이동할 수 있다. 배율 1이면 이동할 수 없다(항상 가운데). */
export function clampPan(pan: Pan, zoom: number, width: number, height: number): Pan {
  const limitX = Math.max(0, (width * (zoom - 1)) / 2);
  const limitY = Math.max(0, (height * (zoom - 1)) / 2);
  // || 0 은 -0 을 0 으로 바꾼다.
  return { x: Math.min(limitX, Math.max(-limitX, pan.x)) || 0, y: Math.min(limitY, Math.max(-limitY, pan.y)) || 0 };
}

/** 슬라이더 위치(0~100)를 정수로 맞춘다. */
export const clampSlider = (value: number): number => (Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 50);
