import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import { Select, confirm, notify } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import './admin.css';

const STATUSES = [
  { value: 'trialing', label: '체험 중(trialing)' }, { value: 'active', label: '이용 중(active)' }, { value: 'past_due', label: '연체(past_due)' },
  { value: 'canceled', label: '해지(canceled)' }, { value: 'expired', label: '만료(expired)' },
] as const;
type Status = (typeof STATUSES)[number]['value'];
const savedSchema = z.object({ plan_code: z.string(), status: z.string(), starts_at: z.string(), ends_at: z.string().nullable() });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** datetime-local 값(사용자 컴퓨터의 시간대)을 오프셋이 있는 ISO 문자열로 바꾼다. 서버는 오프셋 없는 시각을 거부한다. */
export function toOffsetIso(local: string): string | null {
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export interface AdminSubscriptionPageProps {
  api: ApiClient;
  /** 현재 선택한 조직. 대상 조직 ID 입력란의 기본값으로 쓴다. */
  organizationId: string;
  /** 플랫폼 관리자 기능은 조직 역할과 무관하므로 쓰지 않는다(서버가 플랫폼 관리자 목록으로 판정). */
  readOnly?: boolean;
}

/** 플랫폼 관리자 전용 구독 교체. 일반 사용자가 열면 서버가 403으로 거부한다. */
export function AdminSubscriptionPage({ api, organizationId }: AdminSubscriptionPageProps) {
  const [target, setTarget] = useState(organizationId);
  const [plan, setPlan] = useState('BASIC');
  const [status, setStatus] = useState<Status>('active');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setDone('');
    const org = target.trim(), planCode = plan.trim().toUpperCase();
    const starts = startsAt ? toOffsetIso(startsAt) : null, ends = endsAt ? toOffsetIso(endsAt) : null;
    if (!UUID.test(org)) { setError('대상 조직 ID(UUID)를 확인하세요.'); return; }
    if (!planCode) { setError('플랜 코드를 입력하세요.'); return; }
    if (!starts) { setError('시작 시각을 입력하세요.'); return; }
    if (endsAt && !ends) { setError('종료 시각 형식을 확인하세요.'); return; }
    if (ends && Date.parse(ends) <= Date.parse(starts)) { setError('종료 시각은 시작 시각보다 뒤여야 합니다.'); return; }
    const ok = await confirm({ title: '구독 교체', message: `조직 ${org}의 구독을 ${planCode} / ${status}(으)로 교체합니다. 계속할까요?`, confirmLabel: '교체', tone: 'danger' });
    if (!ok) return;
    setBusy(true); setError('');
    try {
      const saved = await api.call('POST', `/admin/organizations/${org}/subscription`, savedSchema, { plan_code: planCode, status, starts_at: starts, ends_at: ends });
      setDone(`구독을 저장했습니다. 플랜 ${saved.plan_code} · 상태 ${saved.status}`);
      notify.success('구독을 저장했습니다.');
    } catch (failure) {
      const code = (failure as { status?: number }).status;
      setError(code === 403 ? '플랫폼 관리자만 사용할 수 있습니다.'
        : code === 404 ? '조직을 찾을 수 없습니다.'
          : code === 422 ? '입력값을 확인하세요. 플랜 코드, 상태, 시작·종료 시각이 올바르지 않습니다.'
            : code === 401 ? '로그인이 필요합니다.'
              : '구독을 저장하지 못했습니다. 서버의 관리자 설정(서비스 키)을 확인하고 다시 시도하세요.');
    } finally { setBusy(false); }
  }

  return (
    <section className="admin-page">
      <div className="page-toolbar"><div><h1>관리자 구독</h1><p className="muted">플랫폼 관리자 전용입니다. 조직의 현재 구독을 새 값으로 교체합니다.</p></div></div>
      <form className="admin-form editor-panel" onSubmit={(event) => void submit(event)}>
        <label className="full">대상 조직 ID<input value={target} onChange={(event) => setTarget(event.currentTarget.value)} /></label>
        <label>플랜 코드<input value={plan} onChange={(event) => setPlan(event.currentTarget.value)} /></label>
        <label>상태<Select<Status> aria-label="상태" value={status} onChange={setStatus} options={STATUSES.map((item) => ({ ...item }))} /></label>
        <label>시작 시각<input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.currentTarget.value)} /></label>
        <label>종료 시각(선택)<input type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.currentTarget.value)} /></label>
        <div className="form-actions"><button type="submit" className="primary-button" disabled={busy}>구독 저장</button></div>
      </form>
      {error && <p role="alert" className="form-error">{error}</p>}
      {done && <p aria-live="polite" className="admin-done">{done}</p>}
    </section>
  );
}
