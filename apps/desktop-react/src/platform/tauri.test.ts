import { describe, expect, it, vi } from 'vitest';
import { createTauriPlatform, type TauriInvoke } from './tauri';

const notifications = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-notification', () => notifications);

function invokeStub(handler?: TauriInvoke): TauriInvoke {
  return handler ?? vi.fn(async (command: string) => {
    if (command === 'get_config') return { apiBase: 'http://127.0.0.1:8000/api/v1', storageHost: 'demo.supabase.co' };
    return null;
  });
}

describe('createTauriPlatform', () => {
  it('Native 시간 초과를 결과 미확인 상태의 재시도 가능 오류로 전달한다',async()=>{
    const invoke=vi.fn(async(command:string)=>{if(command==='get_config')return {apiBase:'http://127.0.0.1:8000/api/v1',storageHost:''};throw {code:'NATIVE_TIMEOUT',message:'서버 응답 시간이 초과되었습니다.',retryable:true};});
    const platform=await createTauriPlatform(invoke);
    await expect(platform.request({method:'POST',path:'/payments',headers:{},body:'{"operation_id":"same"}'})).rejects.toMatchObject({status:0,code:'NATIVE_TIMEOUT',retryable:true,message:'서버 응답 시간이 초과되었습니다.'});
    expect(invoke.mock.calls.filter(([command])=>command==='http_request')).toHaveLength(1);
  });
  it('routes HTTP and token operations through native commands', async () => {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'get_config') return { apiBase: 'http://127.0.0.1:8000/api/v1', storageHost: 'demo.supabase.co' };
      if (command === 'http_request') return { status: 200, body: '{}', headers: { 'x-request-id': 'r1' } };
      if (command === 'token_load') return 'refresh';
      return null;
    });
    const platform = await createTauriPlatform(invoke);
    expect(platform.apiBase).toBe('http://127.0.0.1:8000/api/v1');
    await expect(platform.request({ method: 'GET', path: '/customers', headers: {} })).resolves.toMatchObject({ status: 200 });
    await platform.tokenStore.save('secret');
    await expect(platform.tokenStore.load()).resolves.toBe('refresh');
    await platform.tokenStore.clear();
    expect(invoke).toHaveBeenCalledWith('http_request', { request: { method: 'GET', path: '/customers', headers: {} } });
    expect(invoke).toHaveBeenCalledWith('token_save', { refreshToken: 'secret' });
    expect(invoke).toHaveBeenCalledWith('token_clear');
  });

  it('uses native file commands and treats cancelled selection as empty', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'get_config') return { apiBase: 'http://127.0.0.1:8000/api/v1', storageHost: 'demo.supabase.co' };
      if (command === 'download_binary') return [1, 2, 255];
      if (command === 'pick_images') return null;
      if (command === 'autostart_is_enabled') return true;
      return null;
    });
    const platform = await createTauriPlatform(invoke);
    await platform.uploadBinary('https://demo.supabase.co/object/sign/a', { kind: 'path', name: 'a.jpg', contentType: 'image/jpeg', size: 12, path: 'C:/a.jpg' });
    await expect(platform.downloadBinary('https://demo.supabase.co/object/sign/a')).resolves.toEqual(new Uint8Array([1, 2, 255]));
    await expect(platform.pickImages?.()).resolves.toEqual([]);
    await expect(platform.autostart?.isEnabled()).resolves.toBe(true);
    await platform.autostart?.setEnabled(false);
    expect(invoke).toHaveBeenCalledWith('upload_binary', expect.objectContaining({ url: expect.any(String), path: 'C:/a.jpg' }));
    expect(invoke).toHaveBeenCalledWith('autostart_set', { enabled: false });
  });

  it('rejects blobs and maps native failures to a retryable API error', async () => {
    const invoke = invokeStub(async (command: string) => {
      if (command === 'get_config') return { apiBase: 'https://api.example.com/api/v1', storageHost: 'storage.example.com' };
      throw new Error('network down');
    });
    const platform = await createTauriPlatform(invoke);
    const states: string[] = [];
    const unsubscribe = platform.subscribeConnection((state) => states.push(state));
    await expect(platform.request({ method: 'GET', path: '/customers', headers: {} })).rejects.toMatchObject({ status: 0, code: 'NATIVE_TRANSPORT', retryable: true });
    await expect(platform.uploadBinary('https://storage.example.com/a', { kind: 'blob', name: 'a.jpg', contentType: 'image/jpeg', size: 1, blob: new Blob() })).rejects.toThrow('경로');
    expect(states).toEqual(['checking', 'checking', 'offline']);
    unsubscribe();
  });

  it('routes update commands to the native updater', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'get_config') return { apiBase: 'http://127.0.0.1:8000/api/v1', storageHost: '' };
      if (command === 'update_check') return { configured: false, currentVersion: '0.1.0', reason: 'endpoint' };
      if (command === 'plugin:app|version') return '0.1.0';
      return null;
    });
    const platform = await createTauriPlatform(invoke);
    await expect(platform.checkUpdate!()).resolves.toMatchObject({ configured: false, currentVersion: '0.1.0' });
    await expect(platform.appVersion!()).resolves.toBe('0.1.0');
    await platform.installUpdate!();
    expect(invoke).toHaveBeenCalledWith('update_install');
  });

  it('reads and saves the native automatic update check preference', async () => {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'get_config') return { apiBase: 'http://127.0.0.1:8000/api/v1', storageHost: '' };
      if (command === 'update_autocheck_get') return false;
      if (command === 'update_autocheck_set') return undefined;
      return args?.enabled ?? null;
    });
    const platform = await createTauriPlatform(invoke);

    await expect(platform.getAutoUpdateCheckEnabled?.()).resolves.toBe(false);
    await expect(platform.setAutoUpdateCheckEnabled?.(true)).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith('update_autocheck_set', { enabled: true });
  });

  it('requests OS permission and sends a native toast only after it is granted', async () => {
    notifications.isPermissionGranted.mockResolvedValue(false);
    notifications.requestPermission.mockResolvedValue('granted');
    notifications.sendNotification.mockResolvedValue(undefined);
    const platform = await createTauriPlatform(invokeStub());

    await expect(platform.requestOsNotificationPermission?.()).resolves.toBe(true);
    await platform.sendOsNotification?.('예약 임박', '앱에서 확인하세요.');

    expect(notifications.requestPermission).toHaveBeenCalledOnce();
    expect(notifications.sendNotification).toHaveBeenCalledWith({ title: '예약 임박', body: '앱에서 확인하세요.' });
  });
});
