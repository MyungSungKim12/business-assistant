import { useState, type FormEvent } from 'react';

export function LoginView({ onLogin, error }: { onLogin: (email: string, password: string) => Promise<void>; error?: string }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); try { await onLogin(email.trim(), password); } finally { setBusy(false); } }
  return <main className="auth-layout"><section className="auth-card"><div className="brand-mark">BA</div><p className="eyebrow">BEAUTY BUSINESS OS</p><h1>Business Assistant</h1><p className="muted">매장 운영을 한곳에서 관리하세요.</p><form onSubmit={submit}><label>이메일<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></label><label>비밀번호<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button" disabled={busy}>{busy ? '로그인 중…' : '로그인'}</button></form></section></main>;
}
