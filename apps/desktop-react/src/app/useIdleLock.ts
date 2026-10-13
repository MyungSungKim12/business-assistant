import { useCallback, useEffect, useRef, useState } from 'react';

/** 마지막 입력 이후 경과를 확인하는 간격. 숨김 창에서 타이머가 느려져도 시각 비교로 판단하므로 늦어도 잠긴다. */
export const IDLE_CHECK_MS = 5_000;
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'mousedown', 'keydown', 'wheel', 'touchstart'] as const;

export interface IdleLock {
  locked: boolean;
  /** 비밀번호 확인 등으로 해제한 뒤 호출한다. 타이머도 새로 시작한다. */
  unlock(): void;
  /** 지금 바로 잠근다. */
  lock(): void;
}

/**
 * SEC-08 유휴 자동 잠금. minutes 가 0 이거나 enabled 가 false 이면 동작하지 않는다.
 * 마우스·키 입력으로 마지막 활동 시각을 갱신하고, 주기적으로 그리고 창이 다시 보일 때(visibilitychange·focus) 경과 시간을 확인한다.
 * 잠긴 동안의 입력은 시각을 갱신하지 않는다(잠금은 비밀번호로만 풀린다). 화면 상태는 이 훅이 건드리지 않는다.
 */
export function useIdleLock(minutes: number, enabled: boolean, now: () => number = Date.now): IdleLock {
  const [locked, setLocked] = useState(false);
  const lastActivity = useRef(now());
  const lockedRef = useRef(false);
  const active = enabled && minutes > 0;

  const setLockState = useCallback((value: boolean) => {
    lockedRef.current = value;
    setLocked(value);
  }, []);

  useEffect(() => {
    if (!active) { setLockState(false); return undefined; }
    lastActivity.current = now();
    const limit = minutes * 60_000;
    const touch = () => { if (!lockedRef.current) lastActivity.current = now(); };
    const check = () => { if (!lockedRef.current && now() - lastActivity.current >= limit) setLockState(true); };
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, touch, { passive: true });
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(check, IDLE_CHECK_MS);
    return () => {
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, touch);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, [active, minutes, now, setLockState]);

  const unlock = useCallback(() => { lastActivity.current = now(); setLockState(false); }, [now, setLockState]);
  const lock = useCallback(() => { if (active) setLockState(true); }, [active, setLockState]);
  return { locked: active && locked, unlock, lock };
}
