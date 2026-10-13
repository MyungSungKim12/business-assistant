import { describe, expect, it } from 'vitest';
import { createAccessCache, parseAccessCacheTtl } from './access-cache.js';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const key = (token: string, extra: Partial<{ organizationId: string; feature: string; write: boolean }> = {}) =>
  ({ token, organizationId: ORG_A, feature: 'crm.basic', write: false, ...extra });

function setup(ttlSec = 30, maxEntries?: number) {
  let time = 1_000_000;
  const cache = createAccessCache({ ttlSec, now: () => time, maxEntries });
  return { cache, advance: (ms: number) => { time += ms; } };
}

describe('조직 권한 캐시', () => {
  it('TTL 안에서는 적중하고 지나면 만료된다', () => {
    const { cache, advance } = setup(30);
    cache.set(key('t1'), 'owner');
    advance(29_000);
    expect(cache.get(key('t1'))).toBe('owner');
    advance(1_000);
    expect(cache.get(key('t1'))).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it('사용자(토큰)·조직·기능별로 분리된다', () => {
    const { cache } = setup();
    cache.set(key('t1'), 'owner');
    expect(cache.get(key('t2'))).toBeUndefined();
    expect(cache.get(key('t1', { organizationId: ORG_B }))).toBeUndefined();
    expect(cache.get(key('t1', { feature: 'task.basic' }))).toBeUndefined();
  });

  it('쓰기 검사와 읽기 검사는 분리된다(읽기 허용이 쓰기 허용으로 번지지 않는다)', () => {
    const { cache } = setup();
    cache.set(key('t1', { write: false }), 'member');
    expect(cache.get(key('t1', { write: true }))).toBeUndefined();
    cache.set(key('t1', { write: true }), 'admin');
    expect(cache.get(key('t1', { write: true }))).toBe('admin');
    expect(cache.get(key('t1', { write: false }))).toBe('member');
  });

  it('조직 무효화는 그 조직 항목만 지운다', () => {
    const { cache } = setup();
    cache.set(key('t1'), 'owner');
    cache.set(key('t2', { organizationId: ORG_B }), 'member');
    cache.invalidateOrganization(ORG_A);
    expect(cache.get(key('t1'))).toBeUndefined();
    expect(cache.get(key('t2', { organizationId: ORG_B }))).toBe('member');
  });

  it('TTL 0 이면 저장하지 않는다', () => {
    const { cache } = setup(0);
    cache.set(key('t1'), 'owner');
    expect(cache.enabled).toBe(false);
    expect(cache.get(key('t1'))).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it('크기 상한을 넘으면 만료분을 먼저, 그다음 오래된 항목을 지운다', () => {
    const { cache, advance } = setup(30, 3);
    cache.set(key('a'), 'owner');
    advance(31_000);
    cache.set(key('b'), 'owner');
    cache.set(key('c'), 'owner');
    cache.set(key('d'), 'owner');
    expect(cache.size()).toBe(3);
    expect(cache.get(key('a'))).toBeUndefined();
    cache.set(key('e'), 'owner');
    expect(cache.size()).toBe(3);
    expect(cache.get(key('b'))).toBeUndefined();
    expect(cache.get(key('e'))).toBe('owner');
  });

  it('환경 값 파싱: 기본 30, 0 은 끔, 잘못된 값은 기본', () => {
    expect(parseAccessCacheTtl(undefined)).toBe(30);
    expect(parseAccessCacheTtl('')).toBe(30);
    expect(parseAccessCacheTtl('0')).toBe(0);
    expect(parseAccessCacheTtl('10')).toBe(10);
    expect(parseAccessCacheTtl('abc')).toBe(30);
    expect(parseAccessCacheTtl('-5')).toBe(30);
  });
});
