import type { ApiClient } from '../../../api/client';
import type { CustomerPhoto } from '../../../api/schemas';

/** 서명 URL을 받아 바이트를 내려받고 Blob으로 만든다. (형식 호환: 바이트를 복사해 순수 ArrayBuffer로 감싼다.) */
export async function downloadPhotoBlob(api: ApiClient, organizationId: string, customerId: string, photo: CustomerPhoto): Promise<Blob> {
  const signed = await api.createPhotoDownloadUrl(organizationId, customerId, photo.id);
  const bytes = await api.filePlatform.downloadBinary(signed.signed_url);
  const copy = Uint8Array.from(bytes);
  return new Blob([copy.buffer], { type: photo.content_type });
}

type Task = { photo: CustomerPhoto; resolve: (url: string) => void; reject: (error: unknown) => void };

/**
 * 사진 이미지를 objectURL로 바꿔 캐시한다. 동시에 내려받는 수를 제한하고(기본 4),
 * 같은 사진의 중복 요청을 하나로 합치며, dispose 때 만든 objectURL을 모두 해제한다.
 */
export class ThumbnailLoader {
  private readonly urls = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<string>>();
  private queue: Task[] = [];
  private active = 0;
  private disposed = false;

  constructor(private readonly fetchBlob: (photo: CustomerPhoto) => Promise<Blob>, private readonly concurrency = 4) {}

  peek(photoId: string): string | null {
    return this.urls.get(photoId) ?? null;
  }

  /** priority 요청(라이트박스 등)은 대기열 맨 앞으로 간다. */
  load(photo: CustomerPhoto, priority = false): Promise<string> {
    const cached = this.urls.get(photo.id);
    if (cached) return Promise.resolve(cached);
    if (this.disposed) return Promise.reject(new Error('disposed'));
    const existing = this.inflight.get(photo.id);
    if (existing) {
      if (priority) this.promote(photo.id);
      return existing;
    }
    const promise = new Promise<string>((resolve, reject) => {
      const task: Task = { photo, resolve, reject };
      if (priority) this.queue.unshift(task);
      else this.queue.push(task);
    });
    this.inflight.set(photo.id, promise);
    this.pump();
    return promise;
  }

  /** 보관 처리된 사진 등의 objectURL을 해제한다. */
  release(photoId: string): void {
    const url = this.urls.get(photoId);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(photoId);
  }

  dispose(): void {
    this.disposed = true;
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    const waiting = this.queue;
    this.queue = [];
    for (const task of waiting) {
      this.inflight.delete(task.photo.id);
      task.reject(new Error('disposed'));
    }
  }

  private promote(photoId: string): void {
    const index = this.queue.findIndex((task) => task.photo.id === photoId);
    if (index > 0) this.queue.unshift(...this.queue.splice(index, 1));
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.active += 1;
      this.fetchBlob(task.photo)
        .then((blob) => {
          if (this.disposed) throw new Error('disposed');
          const url = URL.createObjectURL(blob);
          this.urls.set(task.photo.id, url);
          task.resolve(url);
        })
        .catch((error) => task.reject(error))
        .finally(() => {
          this.active -= 1;
          this.inflight.delete(task.photo.id);
          this.pump();
        });
    }
  }
}
