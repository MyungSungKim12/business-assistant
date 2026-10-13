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
  /** 사진이 아닌 일반 파일 자료를 고른다(파일 자료 화면). */
  pickFiles?: () => Promise<BinarySource[]>;
  autostart?: { isEnabled(): Promise<boolean>; setEnabled(enabled: boolean): Promise<void> };
  checkUpdate?: () => Promise<{ version: string; notes?: string } | null>;
  notifyReady?: () => Promise<void>;
  exitApp?: () => Promise<void>;
  /** 트레이 메뉴의 로그아웃·종료 요청을 받는다(데스크톱 전용). 해제 함수를 돌려준다. */
  subscribeTray?: (handler: (action: 'logout' | 'exit') => void) => Promise<() => void>;
  /** 서버 연결 상태를 트레이 메뉴에 표시한다(데스크톱 전용). */
  setTrayStatus?: (state: ConnectionState) => void;
  log?: (level: 'INFO' | 'WARN' | 'ERROR', message: string) => void;
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
