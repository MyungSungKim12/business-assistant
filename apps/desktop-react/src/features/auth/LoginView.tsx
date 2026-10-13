import { useState, type FormEvent } from 'react';

interface LoginViewProps {
  onLogin: (email: string, password: string) => Promise<void>;
  /** 없으면 회원가입 전환을 보여 주지 않는다(웹 미리보기 등). */
  onSignUp?: (email: string, password: string, displayName: string) => Promise<void>;
  error?: string;
  notice?: string;
}

export function LoginView({ onLogin, onSignUp, error, notice }: LoginViewProps) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const signup = mode === 'signup';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      if (signup && onSignUp) await onSignUp(email.trim(), password, displayName.trim());
      else await onLogin(email.trim(), password);
    } finally { setBusy(false); }
  }

  return (
    <main className="auth-layout">
      <section className="auth-card">
        <div className="brand-mark">BA</div>
        <p className="eyebrow">BEAUTY BUSINESS OS</p>
        <h1>Business Assistant</h1>
        <p className="muted">매장 운영을 한곳에서 관리하세요.</p>
        <form onSubmit={submit}>
          {signup && <label>이름<input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={100} autoFocus /></label>}
          <label>이메일<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus={!signup} /></label>
          <label>비밀번호<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={signup ? 8 : undefined} autoComplete={signup ? 'new-password' : 'current-password'} /></label>
          {signup && <p className="hint">비밀번호는 8자 이상이어야 합니다.</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
          {notice && <p className="form-notice" role="status">{notice}</p>}
          <button className="primary-button" disabled={busy}>{busy ? (signup ? '가입 중…' : '로그인 중…') : signup ? '회원가입' : '로그인'}</button>
        </form>
        {onSignUp && (
          <p className="auth-switch">
            {signup ? '이미 계정이 있나요?' : '처음 사용하시나요?'}{' '}
            <button type="button" className="ba-link" onClick={() => setMode(signup ? 'login' : 'signup')}>{signup ? '로그인' : '회원가입'}</button>
          </p>
        )}
      </section>
    </main>
  );
}
