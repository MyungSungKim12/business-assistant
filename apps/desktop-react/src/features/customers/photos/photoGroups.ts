import type { CustomerPhoto } from '../../../api/schemas';
import { kstDate } from '../kst';

export type PhotoGroup = { date: string; photos: CustomerPhoto[] };

const newestFirst = (a: CustomerPhoto, b: CustomerPhoto) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id.localeCompare(b.id));

/** 등록일(KST) 별로 묶는다. 날짜는 최신순, 같은 날 안에서도 최신순. 날짜를 알 수 없는 사진은 맨 뒤 '날짜 미상'. */
export function groupPhotosByDate(photos: CustomerPhoto[]): PhotoGroup[] {
  const groups = new Map<string, CustomerPhoto[]>();
  for (const photo of photos) {
    const date = kstDate(photo.created_at);
    groups.set(date, [...(groups.get(date) ?? []), photo]);
  }
  return [...groups.entries()]
    .map(([date, rows]) => ({ date, photos: [...rows].sort(newestFirst) }))
    .sort((a, b) => (a.date === '' ? 1 : b.date === '' ? -1 : a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

export const groupTitle = (group: PhotoGroup): string => `${group.date || '날짜 미상'} · ${group.photos.length}장`;

export function formatPhotoSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}
