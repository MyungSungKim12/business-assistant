import { create } from 'zustand';

/** 사용자별 화면·보안 설정(localStorage). 저장소를 쓸 수 없는 환경에서는 메모리에서만 유지한다. */
export const IDLE_LOCK_CHOICES = [0, 5, 10, 30] as const;
export type IdleLockMinutes = (typeof IDLE_LOCK_CHOICES)[number];

export const FONT_SCALE_CHOICES = [1, 1.1, 1.25] as const;
export type FontScale = (typeof FONT_SCALE_CHOICES)[number];
/** 로그인 직후 처음 열 화면. 상단 주 메뉴의 항목만 고를 수 있다. */
export const START_MENU_CHOICES = ['dashboard', 'tasks', 'customers', 'appointments', 'treatments', 'sales'] as const;
export type StartMenu = (typeof START_MENU_CHOICES)[number];

export const CHART_DAYS_CHOICES = [7, 14, 30] as const;
export type ChartDays = (typeof CHART_DAYS_CHOICES)[number];

export interface Preferences {
  /** 전화번호·이메일 가려서 표시 */
  maskPhone: boolean;
  /** 입력이 없으면 잠글 때까지의 분. 0이면 끔 */
  idleLockMinutes: IdleLockMinutes;
  /** 글자 크기 배율(UX-05) */
  fontScale: FontScale;
  /** 로그인 후 시작 화면(UX-05) */
  startMenu: StartMenu;
  /** 앱 내 알림 센터 사용(UX-05) */
  notificationsEnabled: boolean;
  /** 새 버전이 확인되면 알려 준다(OPS-04). 끄면 설정의 '업데이트 확인'으로만 확인한다. */
  updateNotice: boolean;
  /** 홈 수입·지출 차트 기간(일) */
  homeChartDays: ChartDays;
}

export const DEFAULT_PREFERENCES: Preferences = { maskPhone: false, idleLockMinutes: 0, fontScale: 1, startMenu: 'dashboard', notificationsEnabled: true, updateNotice: true, homeChartDays: 14 };
const KEY_PREFIX = 'business-assistant.prefs.';

export const preferencesKey = (userId: string) => `${KEY_PREFIX}${userId}`;

export function sanitizePreferences(raw: unknown): Preferences {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const minutes = IDLE_LOCK_CHOICES.find((choice) => choice === value.idleLockMinutes);
  return {
    maskPhone: value.maskPhone === true,
    idleLockMinutes: minutes ?? DEFAULT_PREFERENCES.idleLockMinutes,
    fontScale: FONT_SCALE_CHOICES.find((choice) => choice === value.fontScale) ?? DEFAULT_PREFERENCES.fontScale,
    startMenu: START_MENU_CHOICES.find((choice) => choice === value.startMenu) ?? DEFAULT_PREFERENCES.startMenu,
    notificationsEnabled: value.notificationsEnabled !== false,
    updateNotice: value.updateNotice !== false,
    homeChartDays: CHART_DAYS_CHOICES.find((choice) => choice === value.homeChartDays) ?? DEFAULT_PREFERENCES.homeChartDays,
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
  setFontScale(value: FontScale): void;
  setStartMenu(value: StartMenu): void;
  setNotificationsEnabled(value: boolean): void;
  setUpdateNotice(value: boolean): void;
  setHomeChartDays(value: ChartDays): void;
}

export const usePreferences = create<PreferenceState>((set, get) => {
  const update = (patch: Partial<Preferences>) => {
    const { userId, maskPhone, idleLockMinutes, fontScale, startMenu, notificationsEnabled, updateNotice, homeChartDays } = get();
    const next = { maskPhone, idleLockMinutes, fontScale, startMenu, notificationsEnabled, updateNotice, homeChartDays, ...patch };
    if (userId) writePreferences(userId, next);
    set(next);
  };
  return {
    userId: null,
    ...DEFAULT_PREFERENCES,
    load: (userId) => set({ userId, ...(userId ? readPreferences(userId) : DEFAULT_PREFERENCES) }),
    setMaskPhone: (value) => update({ maskPhone: value }),
    setIdleLockMinutes: (value) => update({ idleLockMinutes: value }),
    setFontScale: (value) => update({ fontScale: value }),
    setStartMenu: (value) => update({ startMenu: value }),
    setNotificationsEnabled: (value) => update({ notificationsEnabled: value }),
    setUpdateNotice: (value) => update({ updateNotice: value }),
    setHomeChartDays: (value) => update({ homeChartDays: value }),
  };
});
