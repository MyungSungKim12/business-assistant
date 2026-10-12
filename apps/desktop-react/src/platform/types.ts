import type { HttpTransport } from '../api/transport';

export type ConnectionState = 'checking' | 'online' | 'offline';
export type BinarySource =
  | { kind: 'blob'; name: string; contentType: string; size: number; blob: Blob }
  | { kind: 'path'; name: string; contentType: string; size: number; path: string };

export interface RefreshTokenStore {
  load(): Promise<string | null>;
  save(refreshToken: string): Promise<void>;
  clear(): Promise<void>;
}

export interface Platform {
  readonly kind: 'browser' | 'tauri';
  readonly apiBase: string;
  readonly tokenStore: RefreshTokenStore;
  readonly request: HttpTransport;
  uploadBinary(url: string, source: BinarySource): Promise<void>;
  downloadBinary(url: string): Promise<Uint8Array>;
  subscribeConnection(listener: (state: ConnectionState) => void): () => void;
  pickImages?: () => Promise<BinarySource[]>;
  autostart?: { isEnabled(): Promise<boolean>; setEnabled(enabled: boolean): Promise<void> };
  checkUpdate?: () => Promise<{ version: string; notes?: string } | null>;
}

export function createConnectionMonitor(initial: ConnectionState = 'checking') {
  let current = initial;
  const listeners = new Set<(state: ConnectionState) => void>();
  return {
    publish(state: ConnectionState) { current = state; listeners.forEach((listener) => listener(state)); },
    subscribe(listener: (state: ConnectionState) => void) {
      listeners.add(listener); listener(current);
      return () => { listeners.delete(listener); };
    },
  };
}
