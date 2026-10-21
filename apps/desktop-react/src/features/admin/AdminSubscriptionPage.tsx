import { useEffect, useState, type FormEvent } from 'react';
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
const planQuotaSchema = z.object({ plan_code: z.string(), plan_name: z.string(), quota_bytes: z.number().int().min(0).max(1024 * 1024 ** 3).nullable() });
const planQuotasSchema = z.array(planQuotaSchema);
type PlanQuota = z.infer<typeof planQuotaSchema>;
const GIB = 1024 ** 3;

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
  const [planQuotas, setPlanQuotas] = useState<PlanQuota[]>([]);
  const [quotaDrafts, setQuotaDrafts] = useState<Record<string, string>>({});
  const [quotaLoading, setQuotaLoading] = useState(true);
  const [quotaBusyCode, setQuotaBusyCode] = useState('');
  const [quotaError, setQuotaError] = useState('');
  const [quotaDone, setQuotaDone] = useState('');

  useEffect(() => {
    let current = true;
    void api.call('GET', '/admin/plans/storage-quotas', planQuotasSchema).then(rows => {
      if (!current) return;
      setPlanQuotas(rows);
      setQuotaDrafts(Object.fromEntries(rows.map(row => [row.plan_code, row.quota_bytes === null ? '' : String(row.quota_bytes / GIB)])));
    }).catch(() => {
      if (current) setQuotaError('요금제 저장 한도를 불러오지 못했습니다. 관리자 서버와 SQL 096 적용 여부를 확인하세요.');
    }).finally(() => { if (current) setQuotaLoading(false); });
    return () => { current = false; };
  }, [api]);

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

  async function savePlanQuota(planRow: PlanQuota) {
    const raw = quotaDrafts[planRow.plan_code]?.trim() ?? '';
    const value = raw === '' ? null : Number(raw);
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1024)) {
      setQuotaError('저장 한도는 비워 두거나 0~1,024 GiB 사이로 입력하세요.');
      return;
    }
    const quotaBytes = value === null ? null : Math.round(value * GIB);
    const ok = await confirm({ title: '요금제 저장 한도 변경', message: `${planRow.plan_code} 요금제의 조직당 최대 저장 공간을 ${quotaBytes === null ? '미설정(조직별 한도 적용)' : `${value} GiB`}으로 변경합니다. 이미 저장된 파일은 보존되며 한도를 넘은 조직의 새 업로드가 차단됩니다.`, confirmLabel: '저장', tone: 'danger' });
    if (!ok) return;
    setQuotaBusyCode(planRow.plan_code); setQuotaError(''); setQuotaDone('');
    try {
      const saved = await api.call('PATCH', `/admin/plans/${encodeURIComponent(planRow.plan_code)}/storage-quota`, planQuotaSchema, { quota_bytes: quotaBytes });
      setPlanQuotas(rows => rows.map(row => row.plan_code === saved.plan_code ? saved : row));
      setQuotaDrafts(rows => ({ ...rows, [saved.plan_code]: saved.quota_bytes === null ? '' : String(saved.quota_bytes / GIB) }));
      setQuotaDone(`${saved.plan_code} 요금제 용량을 저장했습니다.`);
      notify.success('요금제 저장 한도를 저장했습니다.');
    } catch (failure) {
      const code = (failure as { status?: number }).status;
      setQuotaError(code === 403 ? '플랫폼 관리자만 사용할 수 있습니다.' : code === 422 ? '저장 한도는 비워 두거나 0~1,024 GiB 사이의 값이어야 합니다.' : '요금제 저장 한도를 저장하지 못했습니다. 관리자 서버와 SQL 096 적용 여부를 확인하세요.');
    } finally { setQuotaBusyCode(''); }
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
      <section className="admin-plan-quotas" aria-label="요금제별 저장 한도">
        <div><h2>요금제별 파일 저장 한도</h2><p className="muted">플랫폼 관리자 전용입니다. 비워 둔 요금제는 조직별 한도를 사용합니다. 변경 뒤 한도를 초과한 조직은 기존 파일을 유지하고 새 업로드가 차단됩니다.</p></div>
        {quotaLoading ? <p role="status">요금제 한도를 불러오는 중…</p> : planQuotas.length === 0 && !quotaError ? <p className="muted">설정할 요금제가 없습니다.</p> : planQuotas.map(row => <div className="admin-plan-quota-row" key={row.plan_code}>
          <div><strong>{row.plan_name}</strong><small>{row.plan_code} · {row.quota_bytes === null ? '미설정' : `현재 ${row.quota_bytes / GIB} GiB`}</small></div>
          <label>{row.plan_code} 저장 한도 GiB<input aria-label={`${row.plan_code} 저장 한도 GiB`} type="number" min="0" max="1024" step="0.1" value={quotaDrafts[row.plan_code] ?? ''} onChange={event => { const value = event.currentTarget.value; setQuotaDrafts(values => ({ ...values, [row.plan_code]: value })); }} placeholder="미설정" /></label>
          <button type="button" disabled={quotaBusyCode !== ''} onClick={() => void savePlanQuota(row)}>{quotaBusyCode === row.plan_code ? '저장 중…' : `${row.plan_code} 한도 저장`}</button>
        </div>)}
        {quotaError && <p role="alert" className="form-error">{quotaError}</p>}
        {quotaDone && <p role="status" className="admin-done">{quotaDone}</p>}
      </section>
    </section>
  );
}
