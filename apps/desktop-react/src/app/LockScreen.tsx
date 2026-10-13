import { useEffect, useRef, useState, type FormEvent } from 'react';
import { rateLimitMessage } from './useSessionFlow';
import './styles/lock.css';

interface LockScreenProps {
  /** 잠금 사용자의 이메일(고정). 비밀번호만 다시 입력한다. */
  email: string;
  /** 비밀번호를 서버에서 다시 확인한다. 실패하면 던진다. */
  verify: (email: string, password: string) => Promise<unknown>;
  onUnlock: () => void;
  onLogout: () => void;
}

/** 유휴 자동 잠금 화면. 뒤의 화면은 그대로 두고(작업 중 상태 유지) 가리기만 한다. */
export function LockScreen({ email, verify, onUnlock, onLogout }: LockScreenProps) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError('');
    try {
      await verify(email, password);
      setPassword('');
      onUnlock();
    } catch (reason) {
      setPassword('');
      const status = (reason as { status?: number } | null)?.status;
      setError(rateLimitMessage(reason) ?? (status === 0 ? '서버에 연결할 수 없습니다. 연결을 확인한 뒤 다시 시도해 주세요.' : '비밀번호를 확인해 주세요.'));
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lock-screen" role="dialog" aria-modal="true" aria-labelledby="lock-title">
      <form className="lock-screen__panel" onSubmit={(event) => void submit(event)}>
        <h2 id="lock-title">화면이 잠겼습니다</h2>
        <p className="muted">일정 시간 입력이 없어 잠겼습니다. 작업 중인 내용은 그대로 유지됩니다.</p>
        <label>이메일<input value={email} readOnly tabIndex={-1} aria-label="이메일" /></label>
        <label>비밀번호<input ref={input} type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.currentTarget.value)} /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        {confirmingLogout && <p className="form-error" role="alert">로그아웃하면 저장하지 않은 작업 내용이 사라집니다. 한 번 더 누르면 로그아웃합니다.</p>}
        <div className="lock-screen__actions">
          <button type="button" className={confirmingLogout ? 'danger-button' : undefined} onClick={() => (confirmingLogout ? onLogout() : setConfirmingLogout(true))}>{confirmingLogout ? '로그아웃 확인' : '로그아웃'}</button>
          <button type="submit" className="primary-button" disabled={busy || !password}>{busy ? '확인 중…' : '잠금 해제'}</button>
        </div>
      </form>
    </div>
  );
}
