import { useCallback, useMemo, useRef, useState } from 'react';
import { useSessionStore } from '../../store/session';
import { isDefinitive, monthClosedMessage } from './format';

/**
 * 수납·환불·반품은 같은 operation_id로 다시 확인할 수 있어야 하므로 전송 직전에 요청 본문을 브라우저 저장소에 남긴다.
 * (옛 Qt 화면의 QSettings 복구 정보와 같은 역할)
 */
export type RecoveryKind = 'payment' | 'refund' | 'return';
export type Loaded<T> = { status: 'none' } | { status: 'pending'; payload: T } | { status: 'invalid' };

/** 사용자 ID가 없으면(세션 정보를 읽을 수 없으면) 예전 형식의 키를 쓴다. */
export const recoveryKey = (kind: RecoveryKind, organizationId: string, visitId: string, userId?: string | null) =>
  userId ? `ba.sales.recovery.${kind}.${userId}.${organizationId}.${visitId}` : `ba.sales.recovery.${kind}.${organizationId}.${visitId}`;

/**
 * 로그인한 사용자별 복구 키. 같은 PC에서 계정을 바꿔도 다른 사람이 보낸 미확인 요청이 보이지 않는다.
 * legacyKey는 사용자 구분이 없던 예전 키로, 업그레이드 직전에 남은 미확인 요청을 한 번 이어받는 데만 쓴다.
 */
export function useRecoveryKey(kind: RecoveryKind, organizationId: string, visitId: string): { key: string; legacyKey: string } {
  const userId = useSessionStore((state) => state.user?.user_id ?? null);
  return useMemo(() => ({ key: recoveryKey(kind, organizationId, visitId, userId), legacyKey: recoveryKey(kind, organizationId, visitId) }), [kind, organizationId, visitId, userId]);
}

/** 사용자 키가 비어 있고 예전 키에 요청이 남아 있으면 사용자 키로 옮긴다. 옮겼으면 true. */
export function adoptLegacyRecovery(key: string, legacyKey: string): boolean {
  if (key === legacyKey) return false;
  try {
    if (window.localStorage.getItem(key) !== null) return false;
    const raw = window.localStorage.getItem(legacyKey);
    if (raw === null) return false;
    window.localStorage.setItem(key, raw);
    window.localStorage.removeItem(legacyKey);
    return window.localStorage.getItem(key) === raw;
  } catch { return false; }
}

export function loadRecovery<T>(key: string, validate: (value: unknown) => T | null): Loaded<T> {
  let raw: string | null = null;
  try { raw = window.localStorage.getItem(key); } catch { return { status: 'none' }; }
  if (!raw) return { status: 'none' };
  try {
    const payload = validate(JSON.parse(raw));
    return payload ? { status: 'pending', payload } : { status: 'invalid' };
  } catch { return { status: 'invalid' }; }
}
export function saveRecovery(key: string, payload: unknown): boolean {
  try { window.localStorage.setItem(key, JSON.stringify(payload)); return window.localStorage.getItem(key) !== null; } catch { return false; }
}
export function clearRecovery(key: string): boolean {
  try { window.localStorage.removeItem(key); return window.localStorage.getItem(key) === null; } catch { return false; }
}

export interface RecoverableOptions<P, R> {
  key: string;
  /** 사용자 구분이 없던 예전 키(있으면 처음 한 번 이어받는다) */
  legacyKey?: string;
  validate: (value: unknown) => P | null;
  execute: (payload: P) => Promise<R>;
  onSuccess: (result: R) => void;
  rejected: string;
  unconfirmed: string;
}

/** 저장 → 전송 → (확정 거절이면 정리 / 결과 불명이면 같은 요청으로 재확인) 흐름. */
export function useRecoverableOperation<P, R>(options: RecoverableOptions<P, R>) {
  const initial = useMemo(() => {
    if (options.legacyKey) adoptLegacyRecovery(options.key, options.legacyKey);
    return loadRecovery(options.key, options.validate);
  }, [options.key]);
  const [pending, setPending] = useState<P | null>(initial.status === 'pending' ? initial.payload : null);
  const [invalid] = useState(initial.status === 'invalid');
  const uncertain = useRef(initial.status === 'pending');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const latest = useRef(options);
  latest.current = options;

  const run = useCallback(async (payload: P) => {
    setBusy(true);
    setMessage('');
    try {
      const result = await latest.current.execute(payload);
      if (clearRecovery(latest.current.key)) { uncertain.current = false; setPending(null); }
      else { uncertain.current = true; setMessage('저장은 완료됐지만 복구 정보를 지우지 못했습니다. 같은 요청으로 다시 확인해 주세요.'); }
      latest.current.onSuccess(result);
    } catch (error) {
      if (isDefinitive(error) && !uncertain.current) {
        clearRecovery(latest.current.key);
        setPending(null);
        setMessage(monthClosedMessage(error) ?? latest.current.rejected);
      } else {
        uncertain.current = true;
        setMessage(latest.current.unconfirmed);
      }
    } finally { setBusy(false); }
  }, []);

  const submit = useCallback(async (payload: P): Promise<boolean> => {
    if (!saveRecovery(latest.current.key, payload)) { setMessage('복구 정보를 보관하지 못해 요청을 시작하지 않았습니다.'); return false; }
    uncertain.current = false;
    setPending(payload);
    await run(payload);
    return true;
  }, [run]);

  const retry = useCallback(() => { if (pending) void run(pending); }, [pending, run]);
  return { pending, invalid, busy, message, setMessage, submit, retry };
}
