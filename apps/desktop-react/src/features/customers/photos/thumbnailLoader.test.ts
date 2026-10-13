import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomerPhoto } from '../../../api/schemas';
import { ThumbnailLoader } from './thumbnailLoader';

const photo = (id: string): CustomerPhoto => ({ id, organization_id: 'o', customer_id: 'c', original_name: `${id}.jpg`, storage_path: 'p', content_type: 'image/jpeg', size_bytes: 1, caption: '', created_at: '2026-10-13T00:00:00Z' });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferredFetch() {
  const pending = new Map<string, { resolve: () => void; reject: () => void }>();
  const started: string[] = [];
  const fetchBlob = vi.fn((item: CustomerPhoto) => new Promise<Blob>((resolve, reject) => {
    started.push(item.id);
    pending.set(item.id, { resolve: () => resolve(new Blob(['x'])), reject: () => reject(new Error('fail')) });
  }));
  return { fetchBlob, pending, started };
}

describe('ThumbnailLoader', () => {
  let counter = 0;
  beforeEach(() => {
    counter = 0;
    URL.createObjectURL = vi.fn(() => `blob:${++counter}`);
    URL.revokeObjectURL = vi.fn();
  });

  it('limits concurrent downloads to 4 and starts the next as one finishes', async () => {
    const { fetchBlob, pending, started } = deferredFetch();
    const loader = new ThumbnailLoader(fetchBlob, 4);
    const results = ['1', '2', '3', '4', '5', '6'].map((id) => loader.load(photo(id)));
    await flush();
    expect(started).toEqual(['1', '2', '3', '4']);
    pending.get('1')!.resolve();
    await flush();
    expect(started).toEqual(['1', '2', '3', '4', '5']);
    await expect(results[0]).resolves.toBe('blob:1');
  });

  it('merges duplicate requests and serves cached urls without downloading again', async () => {
    const { fetchBlob, pending } = deferredFetch();
    const loader = new ThumbnailLoader(fetchBlob);
    const first = loader.load(photo('1'));
    const second = loader.load(photo('1'));
    await flush();
    pending.get('1')!.resolve();
    expect(await first).toBe(await second);
    expect(await loader.load(photo('1'))).toBe('blob:1');
    expect(fetchBlob).toHaveBeenCalledTimes(1);
    expect(loader.peek('1')).toBe('blob:1');
  });

  it('does not cache a failure, so a retry downloads again', async () => {
    const { fetchBlob, pending } = deferredFetch();
    const loader = new ThumbnailLoader(fetchBlob);
    const failed = loader.load(photo('1'));
    await flush();
    pending.get('1')!.reject();
    await expect(failed).rejects.toThrow('fail');
    const retry = loader.load(photo('1'));
    await flush();
    pending.get('1')!.resolve();
    await expect(retry).resolves.toBe('blob:1');
    expect(fetchBlob).toHaveBeenCalledTimes(2);
  });

  it('revokes every object url on dispose and release, and rejects work after dispose', async () => {
    const { fetchBlob, pending } = deferredFetch();
    const loader = new ThumbnailLoader(fetchBlob);
    const one = loader.load(photo('1'));
    const two = loader.load(photo('2'));
    await flush();
    pending.get('1')!.resolve();
    pending.get('2')!.resolve();
    await Promise.all([one, two]);
    loader.release('1');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1');
    loader.dispose();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:2');
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    await expect(loader.load(photo('3'))).rejects.toThrow('disposed');
  });

  it('puts priority requests ahead of the queue', async () => {
    const { fetchBlob, pending, started } = deferredFetch();
    const loader = new ThumbnailLoader(fetchBlob, 1);
    void loader.load(photo('1'));
    void loader.load(photo('2'));
    void loader.load(photo('3'), true);
    await flush();
    pending.get('1')!.resolve();
    await flush();
    expect(started).toEqual(['1', '3']);
  });
});
