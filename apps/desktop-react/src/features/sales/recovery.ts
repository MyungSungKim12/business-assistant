import { useCallback, useMemo, useRef, useState } from 'react';
import { isDefinitive } from './format';

/**
 * 수납·환불·반품은 같은 operation_id로 다시 확인할 수 있어야 하므로 전송 직전에 요청 본문을 브라우저 저장소에 남긴다.
 * (옛 Qt 화면의 QSettings 복구 정보와 같은 역할)
 */
export type RecoveryKind = 'payment' | 'refund' | 'return';
export type Loaded<T> = { status: 'none' } | { status: 'pending'; payload: T } | { status: 'invalid' };

export const recoveryKey = (kind: RecoveryKind, organizationId: string, visitId: string) => `ba.sales.recovery.${kind}.${organizationId}.${visitId}`;

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
  validate: (value: unknown) => P | null;
  execute: (payload: P) => Promise<R>;
  onSuccess: (result: R) => void;
  rejected: string;
  unconfirmed: string;
}

/** 저장 → 전송 → (확정 거절이면 정리 / 결과 불명이면 같은 요청으로 재확인) 흐름. */
export function useRecoverableOperation<P, R>(options: RecoverableOptions<P, R>) {
  const initial = useMemo(() => loadRecovery(options.key, options.validate), [options.key]);
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
        setMessage(latest.current.rejected);
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
