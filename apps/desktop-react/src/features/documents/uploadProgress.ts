import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { BinarySource, Platform } from '../../platform/types';

export type UploadProgress = { sent: number; total: number };
export type UploadOptions = { onProgress?: (progress: UploadProgress) => void; signal?: AbortSignal };

/** 사용자가 취소한 업로드. 실패가 아니므로 화면은 오류가 아닌 안내로 보여 준다. */
export class UploadCancelledError extends Error {
  constructor() {
    super('업로드가 취소되었습니다.');
    this.name = 'UploadCancelledError';
  }
}

/** 실제 Tauri 창 안에서만 네이티브 명령을 부른다(테스트·브라우저 미리보기에서는 platform 폴백). */
const hasNativeBridge = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

type NativeProgress = { id: string; sent: number; total: number };

const CANCEL_RETRY_MS = 50;
const CANCEL_RETRIES = 20;

function failureOf(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(typeof error === 'string' && error ? error : '업로드에 실패했습니다.');
}

/**
 * 취소 신호를 Rust 로 전달한다. 업로드 명령이 아직 업로드 ID 를 등록하기 전이면 false 가 돌아오므로,
 * 명령이 끝날 때까지 잠깐씩 다시 보낸다.
 */
function forwardCancel(id: string, settled: () => boolean): void {
  const attempt = (remaining: number) => {
    if (settled() || remaining <= 0) return;
    void invoke<boolean>('upload_cancel', { id })
      .then((accepted) => {
        if (!accepted) setTimeout(() => attempt(remaining - 1), CANCEL_RETRY_MS);
      })
      .catch(() => undefined);
  };
  attempt(CANCEL_RETRIES);
}

/** 데스크톱: Rust 스트리밍 업로드(upload_binary)에 업로드 ID 를 붙여 진행률 이벤트를 받고 upload_cancel 로 취소한다. */
async function uploadNative(url: string, source: Extract<BinarySource, { kind: 'path' }>, options: UploadOptions): Promise<void> {
  const id = crypto.randomUUID();
  let finished = false;
  const unlisten = await listen<NativeProgress>('upload:progress', (event) => {
    if (event.payload.id === id) options.onProgress?.({ sent: event.payload.sent, total: event.payload.total });
  });
  const onAbort = () => forwardCancel(id, () => finished);
  options.signal?.addEventListener('abort', onAbort);
  try {
    if (options.signal?.aborted) throw new UploadCancelledError();
    await invoke('upload_binary', { id, url, path: source.path, contentType: source.contentType, size: source.size });
  } catch (error) {
    if (options.signal?.aborted) throw new UploadCancelledError();
    throw failureOf(error);
  } finally {
    finished = true;
    options.signal?.removeEventListener('abort', onAbort);
    unlisten();
  }
}

/** 브라우저·기존 플랫폼 경로: 진행률은 알 수 없고(전송 중 표시), 취소하면 결과를 버린다. */
async function uploadFallback(platform: Platform, url: string, source: BinarySource, options: UploadOptions): Promise<void> {
  if (options.signal?.aborted) throw new UploadCancelledError();
  options.onProgress?.({ sent: 0, total: source.size });
  const cancelled = new Promise<never>((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(new UploadCancelledError()), { once: true });
  });
  await Promise.race([platform.uploadBinary(url, source), cancelled]);
  options.onProgress?.({ sent: source.size, total: source.size });
}

/**
 * 서명 URL 로 파일을 올린다. 데스크톱의 경로 파일은 진행률·취소를 지원하는 Rust 명령을 직접 부르고(types/tauri 는 건드리지 않는다),
 * 그 밖의 환경은 기존 platform.uploadBinary 로 폴백한다.
 */
export function uploadWithProgress(platform: Platform, url: string, source: BinarySource, options: UploadOptions = {}): Promise<void> {
  if (platform.kind === 'tauri' && source.kind === 'path' && hasNativeBridge()) return uploadNative(url, source, options);
  return uploadFallback(platform, url, source, options);
}

export const percentOf = ({ sent, total }: UploadProgress): number => (total > 0 ? Math.min(100, Math.floor((sent / total) * 100)) : 0);
