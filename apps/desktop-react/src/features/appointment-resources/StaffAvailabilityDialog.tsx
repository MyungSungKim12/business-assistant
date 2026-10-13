import { useCallback, useEffect, useState } from 'react';
import { DataGrid, ErrorState, LoadingState, Modal, confirm, notify, type Column } from '@business-assistant/react-ui';
import { resourceApi, type CallApi } from './api';
import { isDefiniteRejection, useOperationTracker } from './operationIds';
import type { TimeOff } from './schemas';
import './appointment-resources.css';

const DAYS: [number, string][] = [[1, '월'], [2, '화'], [3, '수'], [4, '목'], [5, '금'], [6, '토'], [7, '일']];
type Day = { enabled: boolean; start: string; end: string };
const defaultDays = (): Record<number, Day> => Object.fromEntries(DAYS.map(([weekday]) => [weekday, { enabled: false, start: '09:00', end: '18:00' }]));

/** 한국 시간(+09:00) 오프셋을 붙인 ISO 문자열. datetime-local 값("2026-10-08T15:00")을 KST로 해석한다. */
export function kstIso(local: string): string {
  return `${local.length === 16 ? `${local}:00` : local}+09:00`;
}
const formatInstant = (iso: string) => new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

export interface StaffAvailabilityDialogProps {
  api: CallApi;
  organizationId: string;
  staff: { id: string; name: string };
  /** 읽기 전용이면 근무시간·휴무를 볼 수만 있다. */
  readOnly?: boolean;
  onClose: () => void;
}

/** 담당자 주간 근무시간과 휴무 관리(옛 StaffAvailabilityDialog). 시간은 모두 한국 시간이다. */
export function StaffAvailabilityDialog({ api, organizationId, staff, readOnly = false, onClose }: StaffAvailabilityDialogProps) {
  const [days, setDays] = useState<Record<number, Day>>(defaultDays);
  const [version, setVersion] = useState(1);
  const [timeOff, setTimeOff] = useState<TimeOff[]>([]);
  const [selectedLeave, setSelectedLeave] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [leave, setLeave] = useState({ start: '', end: '', reason: '' });
  const [hoursDirty, setHoursDirty] = useState(false);
  const hoursOp = useOperationTracker();
  const leaveOp = useOperationTracker();
  const cancelOp = useOperationTracker();

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const result = await resourceApi.getAvailability(api, organizationId, staff.id);
      const next = defaultDays();
      for (const hour of result.hours) {
        if (hour.weekday in next) next[hour.weekday] = { enabled: true, start: hour.start_time.slice(0, 5), end: hour.end_time.slice(0, 5) };
      }
      setDays(next); setVersion(result.schedule_version); setTimeOff(result.time_off); setHoursDirty(false);
      setSelectedLeave((current) => (result.time_off.some((item) => item.id === current) ? current : null));
    } catch { setLoadError('근무시간을 불러오지 못했습니다.'); }
    finally { setLoading(false); }
  }, [api, organizationId, staff.id]);
  useEffect(() => { void load(); }, [load]);

  const update = (weekday: number, patch: Partial<Day>) => { setDays((current) => ({ ...current, [weekday]: { ...current[weekday], ...patch } })); setHoursDirty(true); };
  const close = async () => {
    if ((hoursDirty || leave.reason.trim()) && !await confirm({ title: '저장하지 않은 변경', message: '저장하지 않은 입력을 버리고 닫을까요?', confirmLabel: '버리고 닫기', tone: 'danger' })) return;
    onClose();
  };

  async function saveHours() {
    const hours: { weekday: number; start: string; end: string }[] = [];
    for (const [weekday, label] of DAYS) {
      const day = days[weekday];
      if (!day.enabled) continue;
      if (!day.start || !day.end || day.end <= day.start) { setError(`${label}요일 종료 시간은 시작 시간보다 늦어야 합니다.`); return; }
      hours.push({ weekday, start: day.start, end: day.end });
    }
    setBusy(true);
    try {
      const saved = await resourceApi.saveWorkingHours(api, organizationId, staff.id, {
        timezone_name: 'Asia/Seoul', hours, expected_version: version, operation_id: hoursOp.idFor(`${version}:${JSON.stringify(hours)}`),
      });
      hoursOp.reset(); setVersion(saved.schedule_version); setHoursDirty(false); setError('');
      notify.success('근무시간을 저장했습니다.');
    } catch (failure) {
      if (isDefiniteRejection(failure)) hoursOp.reset();
      setError('근무시간 저장에 실패했습니다. 기존 예약과 충돌하거나 다른 사용자가 변경했을 수 있습니다.');
    } finally { setBusy(false); }
  }

  async function addLeave() {
    const reason = leave.reason.trim();
    if (!leave.start || !leave.end || leave.end <= leave.start) { setError('휴무 종료는 시작보다 늦어야 합니다.'); return; }
    if (!reason) { setError('휴무 사유를 입력하세요.'); return; }
    const input = { start_at: kstIso(leave.start), end_at: kstIso(leave.end), reason };
    setBusy(true);
    try {
      await resourceApi.createTimeOff(api, organizationId, staff.id, { ...input, operation_id: leaveOp.idFor(JSON.stringify(input)) });
      leaveOp.reset(); setLeave((current) => ({ ...current, reason: '' })); setError('');
      notify.success('휴무를 등록했습니다.');
      await load();
    } catch (failure) {
      if (isDefiniteRejection(failure)) leaveOp.reset();
      setError('휴무 등록에 실패했습니다. 기존 예약과 겹치는지 확인하세요.');
    } finally { setBusy(false); }
  }

  async function cancelLeave() {
    const item = timeOff.find((entry) => entry.id === selectedLeave);
    if (!item) { setError('취소할 휴무를 선택하세요.'); return; }
    setBusy(true);
    try {
      await resourceApi.cancelTimeOff(api, organizationId, staff.id, item.id, { expected_version: item.version, operation_id: cancelOp.idFor(`${item.id}:${item.version}`) });
      cancelOp.reset(); setError('');
      await load();
    } catch (failure) {
      if (isDefiniteRejection(failure)) cancelOp.reset();
      setError('휴무 취소에 실패했습니다. 최신 상태를 다시 확인하세요.');
    } finally { setBusy(false); }
  }

  const columns: Column<TimeOff>[] = [
    { key: 'period', header: '기간', width: 260, value: (row) => row.start_at, render: (row) => `${formatInstant(row.start_at)} ~ ${formatInstant(row.end_at)}` },
    { key: 'reason', header: '사유', width: 180, value: (row) => row.reason },
    { key: 'status', header: '상태', width: 70, value: (row) => (row.status === 'active' ? '사용 중' : '취소') },
  ];

  return (
    <Modal title={`${staff.name} · 근무시간과 휴무`} size="lg" onClose={() => void close()}>
      <div className="staff-availability">
        {loading ? <LoadingState /> : loadError ? <ErrorState message={loadError} onRetry={() => { setLoading(true); void load(); }} /> : (
          <>
            <section aria-label="주간 근무시간">
              <h3>주간 근무시간 · 한국 시간</h3>
              <div className="hours-grid">
                {DAYS.map(([weekday, label]) => (
                  <div key={weekday} className="hours-row">
                    <label className="check"><input type="checkbox" checked={days[weekday].enabled} disabled={readOnly} onChange={(event) => update(weekday, { enabled: event.currentTarget.checked })} />{label}</label>
                    <input type="time" aria-label={`${label}요일 시작`} value={days[weekday].start} disabled={readOnly || !days[weekday].enabled} onChange={(event) => update(weekday, { start: event.currentTarget.value })} />
                    <input type="time" aria-label={`${label}요일 종료`} value={days[weekday].end} disabled={readOnly || !days[weekday].enabled} onChange={(event) => update(weekday, { end: event.currentTarget.value })} />
                  </div>
                ))}
              </div>
              {!readOnly && <button type="button" className="primary-button" disabled={busy} onClick={() => void saveHours()}>근무시간 저장</button>}
            </section>
            <section aria-label="휴무">
              <h3>휴무</h3>
              {!readOnly && (
                <div className="leave-form">
                  <label>시작<input type="datetime-local" value={leave.start} onChange={(event) => setLeave({ ...leave, start: event.currentTarget.value })} /></label>
                  <label>종료<input type="datetime-local" value={leave.end} onChange={(event) => setLeave({ ...leave, end: event.currentTarget.value })} /></label>
                  <label>사유<input value={leave.reason} placeholder="예: 교육, 연차, 개인 일정" onChange={(event) => setLeave({ ...leave, reason: event.currentTarget.value })} /></label>
                  <button type="button" disabled={busy} onClick={() => void addLeave()}>휴무 등록</button>
                </div>
              )}
              <DataGrid rows={timeOff} columns={columns} rowKey={(row) => row.id} selectedKey={selectedLeave} onSelect={(row) => setSelectedLeave(row.id)} ariaLabel="휴무 목록" emptyText="등록된 휴무가 없습니다." />
              {!readOnly && <button type="button" disabled={busy || !selectedLeave} onClick={() => void cancelLeave()}>선택 휴무 취소</button>}
            </section>
          </>
        )}
        {error && <p role="alert" className="form-error">{error}</p>}
      </div>
    </Modal>
  );
}
