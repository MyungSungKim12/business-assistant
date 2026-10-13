import { describe, expect, it, vi } from 'vitest';
import { createTtlCache } from './ttlCache';

describe('createTtlCache', () => {
  it('수명 안에서는 다시 불러오지 않고 지나면 다시 불러온다', async () => {
    let time = 0;
    const cache = createTtlCache(() => time);
    const loader = vi.fn().mockResolvedValue([1]);
    await cache.get('k', loader, 1000);
    time = 999;
    await cache.get('k', loader, 1000);
    expect(loader).toHaveBeenCalledTimes(1);
    time = 1500;
    await cache.get('k', loader, 1000);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('동시 요청은 한 번만 불러온다', async () => {
    const cache = createTtlCache();
    const loader = vi.fn().mockResolvedValue('v');
    const [a, b] = await Promise.all([cache.get('k', loader, 1000), cache.get('k', loader, 1000)]);
    expect([a, b]).toEqual(['v', 'v']);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('실패는 저장하지 않아 바로 다시 시도할 수 있다', async () => {
    const cache = createTtlCache();
    const loader = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue('ok');
    await expect(cache.get('k', loader, 1000)).rejects.toThrow('x');
    await expect(cache.get('k', loader, 1000)).resolves.toBe('ok');
  });

  it('loader 가 동기적으로 던져도 거부로 다룬다', async () => {
    const cache = createTtlCache();
    await expect(cache.get('k', () => { throw new Error('sync'); }, 1000)).rejects.toThrow('sync');
    expect(cache.size()).toBe(0);
  });

  it('접두사로 지운다', async () => {
    const cache = createTtlCache();
    await cache.get('org1:a', async () => 1, 1000);
    await cache.get('org2:a', async () => 1, 1000);
    cache.clear('org1:');
    expect(cache.size()).toBe(1);
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});
