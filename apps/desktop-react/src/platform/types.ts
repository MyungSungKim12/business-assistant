import type { HttpTransport } from '../api/transport';

export type ConnectionState = 'checking' | 'online' | 'offline';
export type BinarySource =
  | { kind: 'blob'; name: string; contentType: string; size: number; blob: Blob }
  | { kind: 'path'; name: string; contentType: string; size: number; path: string };

/** 업데이트 확인 결과. configured=false 는 서버·서명 키가 아직 설정되지 않은 정상 상태다. */
export type UpdateCheckResult =
  | { configured: false; currentVersion: string; reason?: 'endpoint' | 'pubkey' }
  | { configured: true; currentVersion: string; available: false }
  | { configured: true; currentVersion: string; available: true; version: string; notes?: string; date?: string };

export interface UpdateProgress { downloaded: number; total?: number | null }

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
  /** 설치된 앱 버전(데스크톱 전용). */
  appVersion?: () => Promise<string>;
  checkUpdate?: () => Promise<UpdateCheckResult>;
  /** 확인된 업데이트를 내려받아 설치하고 앱을 재시작한다(데스크톱 전용). 성공하면 앱이 종료되므로 돌아오지 않을 수 있다. */
  installUpdate?: () => Promise<void>;
  /** 업데이트 다운로드 진행률을 받는다. 해제 함수를 돌려준다. */
  onUpdateProgress?: (handler: (progress: UpdateProgress) => void) => Promise<() => void>;
  /** 앱이 시작 후 자동으로 확인한 새 업데이트를 받는다(데스크톱 전용). 해제 함수를 돌려준다. */
  onUpdateAvailable?: (handler: (info: { version: string }) => void) => Promise<() => void>;
  /** 다음 데스크톱 시작 시 백그라운드 업데이트 확인 여부를 읽고 저장한다. */
  getAutoUpdateCheckEnabled?: () => Promise<boolean>;
  setAutoUpdateCheckEnabled?: (enabled: boolean) => Promise<void>;
  notifyReady?: () => Promise<void>;
  exitApp?: () => Promise<void>;
  /** 트레이 메뉴의 로그아웃·종료 요청을 받는다(데스크톱 전용). 해제 함수를 돌려준다. */
  subscribeTray?: (handler: (action: 'logout' | 'exit') => void) => Promise<() => void>;
  /** 서버 연결 상태를 트레이 메뉴에 표시한다(데스크톱 전용). */
  setTrayStatus?: (state: ConnectionState) => void;
  /** OS 알림 권한을 요청한다(데스크톱 전용). */
  requestOsNotificationPermission?: () => Promise<boolean>;
  /** 개인정보를 포함하지 않는 OS 알림을 보낸다(데스크톱 전용). */
  sendOsNotification?: (title: string, body: string) => Promise<void>;
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
