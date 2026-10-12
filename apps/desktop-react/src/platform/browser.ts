import { fetchTransport } from '../api/transport';
import type { BinarySource, Platform, RefreshTokenStore } from './types';
import { createConnectionMonitor } from './types';

const refreshKey = 'business-assistant.refresh-token';
export const browserTokenStore: RefreshTokenStore = {
  async load() { try { return sessionStorage.getItem(refreshKey); } catch { return null; } },
  async save(token) { try { sessionStorage.setItem(refreshKey, token); } catch { /* session storage may be disabled */ } },
  async clear() { try { sessionStorage.removeItem(refreshKey); } catch { /* session storage may be disabled */ } },
};

export function createBrowserPlatform(apiBase = '/api/v1'): Platform {
  const transport = fetchTransport(apiBase);
  const monitor = createConnectionMonitor();
  return {
    kind: 'browser', apiBase, tokenStore: browserTokenStore,
    async request(request) {
      monitor.publish('checking');
      try { const response = await transport(request); monitor.publish('online'); return response; }
      catch (error) { monitor.publish('offline'); throw error; }
    },
    async uploadBinary(url, source) {
      if (source.kind !== 'blob') throw new Error('브라우저 업로드에는 Blob이 필요합니다.');
      const response = await fetch(url, { method: 'PUT', headers: { 'Content-Type': source.contentType }, body: source.blob });
      if (!response.ok) throw new Error(`업로드 실패 (${response.status})`);
    },
    async downloadBinary(url) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`다운로드 실패 (${response.status})`);
      return new Uint8Array(await response.arrayBuffer());
    },
    subscribeConnection: monitor.subscribe,
  };
}
