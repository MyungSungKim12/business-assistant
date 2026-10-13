import { useState, type FormEvent } from 'react';

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 매장 이름에서 영문 소문자·숫자·하이픈 코드 후보를 만든다. 한글만 있으면 빈 값을 돌려준다. */
export function suggestSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

interface Props {
  /** 만들기에 성공하면 true. 실패하면 false를 돌려주고 입력은 그대로 둔다. */
  onCreate: (name: string, slug: string) => Promise<boolean>;
}

export function OrganizationCreateForm({ onCreate }: Props) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const code = slug.trim().toLowerCase();
    if (!name.trim() || !SLUG_PATTERN.test(code)) { setProblem('매장 이름과, 영문 소문자·숫자·하이픈 형식의 매장 코드를 입력하세요.'); return; }
    setProblem(''); setBusy(true);
    try { await onCreate(name.trim(), code); } finally { setBusy(false); }
  }

  return (
    <form className="organization-create" onSubmit={submit}>
      <h2>새 매장 만들기</h2>
      <label>매장 이름<input value={name} maxLength={200} onChange={(e) => { setName(e.target.value); if (!slugTouched) setSlug(suggestSlug(e.target.value)); }} required /></label>
      <label>매장 코드<input value={slug} maxLength={100} placeholder="예: beige-salon" onChange={(e) => { setSlugTouched(true); setSlug(e.target.value); }} required /></label>
      <p className="hint">매장 코드는 영문 소문자·숫자·하이픈만 쓸 수 있습니다.</p>
      {problem && <p className="form-error" role="alert">{problem}</p>}
      <button className="primary-button" disabled={busy}>{busy ? '만드는 중…' : '매장 만들기'}</button>
    </form>
  );
}
