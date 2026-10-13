import { describe, expect, it } from 'vitest';
import type { CustomerPhoto } from '../../api/schemas';
import type { TreatmentPhoto } from './api';
import { clampPan, clampSlider, clampZoom, comparablePhotos, groupByPhase, nextSortOrder, phaseOf, photoLabel, resolveLinks, unlinkedPhotos } from './photoLinks';

const org = '22222222-2222-4222-8222-222222222222';
const cust = '11111111-1111-4111-8111-111111111111';
const treatment = '44444444-4444-4444-8444-444444444444';
const photo = (n: number, extra: Partial<CustomerPhoto> = {}): CustomerPhoto => ({
  id: `a000000${n}-0000-4000-8000-000000000000`, organization_id: org, customer_id: cust, original_name: `사진${n}.jpg`, storage_path: `${org}/photo-${n}.jpg`,
  content_type: 'image/jpeg', size_bytes: 100, caption: '', created_at: '2026-09-18T01:00:00Z', ...extra,
});
const link = (n: number, extra: Partial<TreatmentPhoto> = {}): TreatmentPhoto => ({
  id: `b000000${n}-0000-4000-8000-000000000000`, organization_id: org, customer_id: cust, treatment_id: treatment, storage_path: `${org}/photo-${n}.jpg`, thumbnail_path: null,
  content_type: 'image/jpeg', caption: '', sort_order: 0, taken_at: null, phase: null, ...extra,
});

describe('연결 해석·구분', () => {
  it('저장 경로가 같은 고객 사진과 짝지고, 없으면 원본 없음(null)', () => {
    const resolved = resolveLinks([link(1), link(9)], [photo(1), photo(2)]);
    expect(resolved[0].photo?.id).toBe(photo(1).id);
    expect(resolved[1].photo).toBeNull();
  });

  it('phase 가 없으면 기타로 보고 구분별로 묶는다', () => {
    expect(phaseOf(link(1))).toBe('other');
    const groups = groupByPhase(resolveLinks([link(1, { phase: 'before' }), link(2, { phase: 'after' }), link(3), link(4, { phase: 'before' })], [photo(1), photo(2), photo(3), photo(4)]));
    expect(groups.before.map((item) => item.link.id)).toEqual([link(1).id, link(4).id]);
    expect(groups.after).toHaveLength(1);
    expect(groups.other).toHaveLength(1);
  });

  it('이미 연결한 사진은 후보에서 빠진다(중복 연결 방지)', () => {
    expect(unlinkedPhotos([photo(1), photo(2), photo(3)], [link(2, { phase: 'before' })]).map((item) => item.id)).toEqual([photo(1).id, photo(3).id]);
  });

  it('비교는 원본이 있는 전·후 사진만 대상으로 한다', () => {
    const groups = groupByPhase(resolveLinks([link(1, { phase: 'before' }), link(2, { phase: 'after' }), link(9, { phase: 'after' })], [photo(1), photo(2)]));
    const { before, after } = comparablePhotos(groups);
    expect(before).toHaveLength(1);
    expect(after.map((item) => item.photo.id)).toEqual([photo(2).id]);
  });

  it('표시 이름은 연결 설명 → 원본 파일명 → 원본 없음 순서다', () => {
    expect(photoLabel({ link: link(1, { caption: '정면' }), photo: photo(1) })).toBe('정면');
    expect(photoLabel({ link: link(1), photo: photo(1) })).toBe('사진1.jpg');
    expect(photoLabel({ link: link(1), photo: null })).toBe('원본 사진 없음');
  });

  it('정렬 번호는 같은 구분의 다음 값이다', () => {
    const links = [link(1, { phase: 'before', sort_order: 0 }), link(2, { phase: 'before', sort_order: 3 }), link(3, { phase: 'after', sort_order: 1 })];
    expect(nextSortOrder(links, 'before')).toBe(4);
    expect(nextSortOrder(links, 'after')).toBe(2);
    expect(nextSortOrder(links, 'other')).toBe(0);
  });
});

describe('확대·이동 계산', () => {
  it('배율은 1~4 안으로 맞추고 숫자가 아니면 1', () => {
    expect(clampZoom(0.2)).toBe(1);
    expect(clampZoom(9)).toBe(4);
    expect(clampZoom(2.499)).toBe(2.5);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it('이동은 확대한 만큼만 가능하다(배율 1이면 이동 없음)', () => {
    expect(clampPan({ x: 50, y: -50 }, 1, 400, 300)).toEqual({ x: 0, y: 0 });
    expect(clampPan({ x: 500, y: -500 }, 2, 400, 300)).toEqual({ x: 200, y: -150 });
    expect(clampPan({ x: 10, y: 10 }, 3, 400, 300)).toEqual({ x: 10, y: 10 });
    expect(clampPan({ x: 99, y: 99 }, 3, 0, 0)).toEqual({ x: 0, y: 0 });
  });

  it('슬라이더는 0~100 정수', () => {
    expect(clampSlider(-5)).toBe(0);
    expect(clampSlider(120)).toBe(100);
    expect(clampSlider(33.6)).toBe(34);
    expect(clampSlider(Number.NaN)).toBe(50);
  });
});
