import { describe, expect, it } from 'vitest';
import type { CustomerPhoto } from '../../../api/schemas';
import { formatPhotoSize, groupPhotosByDate, groupTitle } from './photoGroups';

const photo = (id: string, createdAt: string): CustomerPhoto => ({ id, organization_id: 'o', customer_id: 'c', original_name: `${id}.jpg`, storage_path: 'p', content_type: 'image/jpeg', size_bytes: 1, caption: '', created_at: createdAt });

describe('groupPhotosByDate', () => {
  it('groups by KST date, newest date and newest photo first', () => {
    const groups = groupPhotosByDate([
      photo('a', '2026-10-12T20:00:00Z'), // KST 10-13 05:00
      photo('b', '2026-10-13T01:00:00Z'), // KST 10-13 10:00
      photo('c', '2026-10-01T00:00:00Z'),
      photo('d', '2026-10-12T14:59:00Z'), // KST 10-12 23:59
    ]);
    expect(groups.map((group) => group.date)).toEqual(['2026-10-13', '2026-10-12', '2026-10-01']);
    expect(groups[0].photos.map((item) => item.id)).toEqual(['b', 'a']);
    expect(groupTitle(groups[0])).toBe('2026-10-13 · 2장');
  });

  it('puts photos with an unreadable date last and returns nothing for an empty list', () => {
    expect(groupPhotosByDate([])).toEqual([]);
    const groups = groupPhotosByDate([photo('x', 'bad'), photo('y', '2026-10-01T00:00:00Z')]);
    expect(groups.map((group) => group.date)).toEqual(['2026-10-01', '']);
    expect(groupTitle(groups[1])).toBe('날짜 미상 · 1장');
  });

  it('formats sizes', () => {
    expect(formatPhotoSize(100)).toBe('1KB');
    expect(formatPhotoSize(2048)).toBe('2KB');
    expect(formatPhotoSize(3 * 1024 * 1024)).toBe('3.0MB');
  });
});
