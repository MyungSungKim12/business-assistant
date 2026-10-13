import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BinarySource, Platform } from '../../platform/types';
import { percentOf, UploadCancelledError, uploadWithProgress } from './uploadProgress';

const invoke = vi.fn();
const listeners: Array<(event: { payload: unknown }) => void> = [];
const unlisten = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.push(handler);
    return unlisten;
  }),
}));

const pathSource: BinarySource = { kind: 'path', name: '큰파일.pdf', contentType: 'application/pdf', size: 1000, path: 'C:/큰파일.pdf' };
const blobSource: BinarySource = { kind: 'blob', name: 'a.pdf', contentType: 'application/pdf', size: 10, blob: new Blob(['x']) };
const platform = (kind: 'tauri' | 'browser', uploadBinary = vi.fn(async () => undefined)) => ({ kind, uploadBinary }) as unknown as Platform & { uploadBinary: ReturnType<typeof vi.fn> };
const emit = (payload: unknown) => listeners.forEach((handler) => handler({ payload }));

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  invoke.mockReset();
  unlisten.mockReset();
  listeners.length = 0;
  vi.useRealTimers();
});

describe('데스크톱 네이티브 업로드', () => {
  it('업로드 ID 를 붙여 upload_binary 를 부르고 자기 ID 의 진행률만 전달한다', async () => {
    let id = '';
    invoke.mockImplementation(async (_command: string, args: { id: string }) => {
      id = args.id;
      emit({ id: 'other', sent: 1, total: 2 });
      emit({ id, sent: 250, total: 1000 });
      emit({ id, sent: 1000, total: 1000 });
    });
    const progress = vi.fn();
    await uploadWithProgress(platform('tauri'), 'https://s.supabase.co/u', pathSource, { onProgress: progress });
    expect(invoke).toHaveBeenCalledWith('upload_binary', { id, url: 'https://s.supabase.co/u', path: 'C:/큰파일.pdf', contentType: 'application/pdf', size: 1000 });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(progress.mock.calls).toEqual([[{ sent: 250, total: 1000 }], [{ sent: 1000, total: 1000 }]]);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('취소하면 upload_cancel 을 보내고 Rust 가 취소 오류를 돌려주면 UploadCancelledError', async () => {
    const controller = new AbortController();
    let rejectUpload: (reason: string) => void = () => undefined;
    invoke.mockImplementation((command: string) => {
      if (command === 'upload_cancel') {
        rejectUpload('업로드가 취소되었습니다.');
        return Promise.resolve(true);
      }
      return new Promise((_resolve, reject) => { rejectUpload = reject; });
    });
    const pending = uploadWithProgress(platform('tauri'), 'https://s.supabase.co/u', pathSource, { signal: controller.signal });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('upload_binary', expect.anything()));
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(UploadCancelledError);
    const cancelCall = invoke.mock.calls.find(([command]) => command === 'upload_cancel');
    expect(cancelCall?.[1]).toEqual({ id: (invoke.mock.calls[0][1] as { id: string }).id });
    expect(unlisten).toHaveBeenCalled();
  });

  it('업로드 ID 가 아직 등록되기 전이라 취소가 거절되면 다시 보낸다', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let cancelAttempts = 0;
    let rejectUpload: (reason: string) => void = () => undefined;
    invoke.mockImplementation((command: string) => {
      if (command === 'upload_cancel') {
        cancelAttempts += 1;
        if (cancelAttempts < 3) return Promise.resolve(false);
        rejectUpload('업로드가 취소되었습니다.');
        return Promise.resolve(true);
      }
      return new Promise((_resolve, reject) => { rejectUpload = reject; });
    });
    const pending = uploadWithProgress(platform('tauri'), 'https://s.supabase.co/u', pathSource, { signal: controller.signal });
    const settled = expect(pending).rejects.toBeInstanceOf(UploadCancelledError);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(500);
    await settled;
    expect(cancelAttempts).toBe(3);
  });

  it('문자열 오류는 Error 로 감싸 메시지를 보존한다(취소가 아니면 UploadCancelledError 가 아니다)', async () => {
    invoke.mockRejectedValue('업로드에 실패했습니다. (403 Forbidden)');
    const failure = await uploadWithProgress(platform('tauri'), 'https://s.supabase.co/u', pathSource, {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(UploadCancelledError);
    expect((failure as Error).message).toBe('업로드에 실패했습니다. (403 Forbidden)');
    expect(unlisten).toHaveBeenCalled();
  });

  it('이미 취소된 신호면 전송하지 않는다', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(uploadWithProgress(platform('tauri'), 'https://s.supabase.co/u', pathSource, { signal: controller.signal })).rejects.toBeInstanceOf(UploadCancelledError);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('브라우저·기존 경로 폴백', () => {
  it('platform.uploadBinary 를 (url, source) 두 인자로 부르고 시작·완료 진행률을 알린다', async () => {
    const browser = platform('browser');
    const progress = vi.fn();
    await uploadWithProgress(browser, 'https://s.supabase.co/u', blobSource, { onProgress: progress });
    expect(browser.uploadBinary).toHaveBeenCalledWith('https://s.supabase.co/u', blobSource);
    expect(browser.uploadBinary.mock.calls[0]).toHaveLength(2);
    expect(progress.mock.calls).toEqual([[{ sent: 0, total: 10 }], [{ sent: 10, total: 10 }]]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('Tauri 창이 아니면(브릿지 없음) 경로 파일도 platform 으로 폴백한다', async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const desktop = platform('tauri');
    await uploadWithProgress(desktop, 'https://s.supabase.co/u', pathSource, {});
    expect(desktop.uploadBinary).toHaveBeenCalledWith('https://s.supabase.co/u', pathSource);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('전송 중 취소하면 결과를 기다리지 않고 UploadCancelledError', async () => {
    const controller = new AbortController();
    const hanging = platform('browser', vi.fn(() => new Promise<undefined>(() => undefined)));
    const pending = uploadWithProgress(hanging, 'https://s.supabase.co/u', blobSource, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(UploadCancelledError);
  });

  it('전송 실패는 그대로 올린다', async () => {
    const failing = platform('browser', vi.fn(async () => { throw new Error('업로드 실패 (500)'); }));
    await expect(uploadWithProgress(failing, 'https://s.supabase.co/u', blobSource, {})).rejects.toThrow('업로드 실패 (500)');
  });
});

describe('percentOf', () => {
  it('0~100 정수로 올림 없이 계산하고 전체 크기가 0이면 0', () => {
    expect(percentOf({ sent: 1, total: 3 })).toBe(33);
    expect(percentOf({ sent: 5, total: 3 })).toBe(100);
    expect(percentOf({ sent: 0, total: 0 })).toBe(0);
  });
});
