import { create } from 'zustand';

/** 사용자별 화면·보안 설정(localStorage). 저장소를 쓸 수 없는 환경에서는 메모리에서만 유지한다. */
export const IDLE_LOCK_CHOICES = [0, 5, 10, 30] as const;
export type IdleLockMinutes = (typeof IDLE_LOCK_CHOICES)[number];

export interface Preferences {
  /** 전화번호·이메일 가려서 표시 */
  maskPhone: boolean;
  /** 입력이 없으면 잠글 때까지의 분. 0이면 끔 */
  idleLockMinutes: IdleLockMinutes;
}

export const DEFAULT_PREFERENCES: Preferences = { maskPhone: false, idleLockMinutes: 0 };
const KEY_PREFIX = 'business-assistant.prefs.';

export const preferencesKey = (userId: string) => `${KEY_PREFIX}${userId}`;

export function sanitizePreferences(raw: unknown): Preferences {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const minutes = IDLE_LOCK_CHOICES.find((choice) => choice === value.idleLockMinutes);
  return {
    maskPhone: value.maskPhone === true,
    idleLockMinutes: minutes ?? DEFAULT_PREFERENCES.idleLockMinutes,
  };
}

export function readPreferences(userId: string): Preferences {
  try {
    const text = localStorage.getItem(preferencesKey(userId));
    return text ? sanitizePreferences(JSON.parse(text)) : DEFAULT_PREFERENCES;
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function writePreferences(userId: string, preferences: Preferences): void {
  try { localStorage.setItem(preferencesKey(userId), JSON.stringify(preferences)); } catch { /* 저장소를 쓸 수 없으면 이번 실행에서만 유지 */ }
}

interface PreferenceState extends Preferences {
  userId: string | null;
  /** 로그인한 사용자의 저장된 설정을 불러온다. null이면 기본값으로 되돌린다. */
  load(userId: string | null): void;
  setMaskPhone(value: boolean): void;
  setIdleLockMinutes(value: IdleLockMinutes): void;
}

export const usePreferences = create<PreferenceState>((set, get) => {
  const update = (patch: Partial<Preferences>) => {
    const { userId, maskPhone, idleLockMinutes } = get();
    const next = { maskPhone, idleLockMinutes, ...patch };
    if (userId) writePreferences(userId, next);
    set(next);
  };
  return {
    userId: null,
    ...DEFAULT_PREFERENCES,
    load: (userId) => set({ userId, ...(userId ? readPreferences(userId) : DEFAULT_PREFERENCES) }),
    setMaskPhone: (value) => update({ maskPhone: value }),
    setIdleLockMinutes: (value) => update({ idleLockMinutes: value }),
  };
});
