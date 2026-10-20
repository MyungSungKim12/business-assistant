import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { ApiError } from '../api/errors';
import type { HttpRequest, HttpResponse } from '../api/transport';
import type { BinarySource, Platform, UpdateCheckResult, UpdateProgress } from './types';
import { createConnectionMonitor } from './types';

export type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

interface NativeConfig { apiBase: string; storageHost: string }

function nativeError(error: unknown): ApiError {
  if(error && typeof error==='object' && 'code' in error && 'message' in error && 'retryable' in error
    && ['NATIVE_TIMEOUT','NATIVE_TRANSPORT','NATIVE_CONFIG'].includes(String(error.code))
    && typeof error.message==='string' && typeof error.retryable==='boolean'){
    return new ApiError(0,String(error.code),error.message,error.retryable);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ApiError(0, 'NATIVE_TRANSPORT', message || '운영체제 통신에 실패했습니다.', true);
}

export async function createTauriPlatform(invoke: TauriInvoke = tauriInvoke as TauriInvoke): Promise<Platform> {
  const call = <T>(command: string, args?: Record<string, unknown>) => (args === undefined ? invoke(command) : invoke(command, args)) as Promise<T>;
  const config = await call<NativeConfig>('get_config');
  const monitor = createConnectionMonitor();
  return {
    kind: 'tauri',
    apiBase: config.apiBase,
    tokenStore: {
      load: () => call<string | null>('token_load'),
      save: (refreshToken) => call<void>('token_save', { refreshToken }),
      clear: () => call<void>('token_clear'),
    },
    async request(request: HttpRequest): Promise<HttpResponse> {
      monitor.publish('checking');
      try {
        const response = await call<HttpResponse>('http_request', { request });
        monitor.publish('online');
        return response;
      } catch (error) {
        monitor.publish('offline');
        throw nativeError(error);
      }
    },
    async uploadBinary(url: string, source: BinarySource) {
      if (source.kind !== 'path') throw new Error('데스크톱 업로드에는 운영체제 파일 경로가 필요합니다.');
      try {
        await call<void>('upload_binary', { url, path: source.path, contentType: source.contentType, size: source.size });
      } catch (error) { throw nativeError(error); }
    },
    async downloadBinary(url: string) {
      try { return new Uint8Array(await call<number[]>('download_binary', { url })); }
      catch (error) { throw nativeError(error); }
    },
    subscribeConnection: monitor.subscribe,
    notifyReady: () => call<void>('show_main'),
    exitApp: () => call<void>('app_exit'),
    async subscribeTray(handler) {
      const offLogout = await listen('tray:logout', () => handler('logout'));
      const offExit = await listen('tray:exit', () => handler('exit'));
      return () => { offLogout(); offExit(); };
    },
    setTrayStatus: (state) => { void call<void>('tray_set_status', { state }).catch(() => undefined); },
    async requestOsNotificationPermission() {
      if (await isPermissionGranted()) return true;
      return (await requestPermission()) === 'granted';
    },
    async sendOsNotification(title, body) { sendNotification({ title, body }); },
    log: (level, message) => { void call<void>('log_write', { level, message }).catch(() => undefined); },
    async pickImages() {
      const selected = await call<Array<{ name: string; contentType: string; size: number; path: string }> | null>('pick_images');
      return (selected ?? []).map((file) => ({ kind: 'path' as const, ...file }));
    },
    async pickFiles() {
      const selected = await call<Array<{ name: string; contentType: string; size: number; path: string }> | null>('pick_files');
      return (selected ?? []).map((file) => ({ kind: 'path' as const, ...file }));
    },
    appVersion: async () => String((await call<string | null>('plugin:app|version')) ?? ''),
    checkUpdate: () => call<UpdateCheckResult>('update_check').catch((error) => { throw nativeError(error); }),
    installUpdate: () => call<void>('update_install').catch((error) => { throw nativeError(error); }),
    async onUpdateProgress(handler) {
      return listen<UpdateProgress>('update:progress', (event) => handler(event.payload));
    },
    async onUpdateAvailable(handler) {
      return listen<{ version?: string }>('update:available', (event) => handler({ version: String(event.payload?.version ?? '') }));
    },
    getAutoUpdateCheckEnabled: () => call<boolean>('update_autocheck_get'),
    setAutoUpdateCheckEnabled: (enabled) => call<void>('update_autocheck_set', { enabled }),
    autostart: {
      isEnabled: () => call<boolean>('autostart_is_enabled'),
      setEnabled: (enabled) => call<void>('autostart_set', { enabled }),
    },
  };
}
