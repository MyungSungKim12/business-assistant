import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Modal, confirm, notify } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import type { Appointment, AppointmentService, AppointmentStaff, Customer } from '../../api/schemas';
import { ResourceManagerDialog, ResourcePicker, missingRequirements, describeRequirements } from '../appointment-resources';
import type { AppointmentResource, ResourceRequirement } from '../appointment-resources';

const labels: Record<string, string> = { reserved: '예약', confirmed: '확정', checked_in: '방문', completed: '완료', canceled: '취소', no_show: '노쇼' };
const emptyForm = { customer_id: '', staff_id: '', service_id: '', start_at: '' };
const todayKey = () => new Date().toLocaleDateString('sv-SE');

interface AppointmentPageProps {
  api: ApiClient;
  organizationId: string;
  /** 예약 등록·변경이 불가능한 화면(보기 전용)이면 true. 구성원(member)도 예약은 다룰 수 있다. */
  readOnly: boolean;
  /** 공간·장비 자원 관리 권한(소유자·관리자). */
  canManageResources?: boolean;
}

export function AppointmentPage({ api, organizationId, readOnly, canManageResources = false }: AppointmentPageProps) {
  const [items, setItems] = useState<Appointment[]>([]);
  const [staff, setStaff] = useState<AppointmentStaff[]>([]);
  const [services, setServices] = useState<AppointmentService[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [error, setError] = useState('');
  const [day, setDay] = useState(todayKey);
  const [form, setForm] = useState(emptyForm);
  const [resourceIds, setResourceIds] = useState<string[]>([]);
  const [requirements, setRequirements] = useState<{ needs: ResourceRequirement[]; pool: AppointmentResource[] }>({ needs: [], pool: [] });
  const [saving, setSaving] = useState(false);
  const [resourceDialog, setResourceDialog] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<Appointment | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  // 같은 입력의 재시도는 같은 operation_id를 써서 중복 예약을 막고, 입력이 바뀌면 새로 만든다.
  const [operation, setOperation] = useState({ id: crypto.randomUUID(), fingerprint: '' });

  const load = () => Promise.all([api.listAppointments(organizationId), api.listAppointmentStaff(organizationId), api.listAppointmentServices(organizationId), api.listCustomers(organizationId)])
    .then(([appointments, staffRows, serviceRows, customerRows]) => {
      setItems(appointments);
      setStaff(staffRows.filter((row) => row.is_active));
      setServices(serviceRows.filter((row) => row.is_active));
      setCustomers(customerRows.filter((row) => row.status === 'active'));
      setError('');
    })
    .catch(() => setError('예약 정보를 불러오지 못했습니다.'));
  useEffect(() => { void load(); }, [api, organizationId]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => items.filter((item) => new Date(item.start_at).toLocaleDateString('sv-SE') === day).sort((a, b) => a.start_at.localeCompare(b.start_at)), [items, day]);
  const missing = missingRequirements(requirements.needs, requirements.pool, resourceIds);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (missing.length > 0) { setError(`필수 자원이 부족합니다. 필요한 기준: ${describeRequirements(requirements.needs)}`); return; }
    const input = { ...form, start_at: new Date(form.start_at).toISOString(), source: 'manual', expected_version: null, resource_ids: resourceIds };
    const fingerprint = JSON.stringify(input);
    const operationId = operation.fingerprint === fingerprint ? operation.id : crypto.randomUUID();
    setOperation({ id: operationId, fingerprint });
    setSaving(true);
    try {
      const saved = await api.createAppointment(organizationId, { ...input, operation_id: operationId });
      setItems((old) => [...old.filter((item) => item.id !== saved.id), saved]);
      setForm(emptyForm); setResourceIds([]); setError('');
      setOperation({ id: crypto.randomUUID(), fingerprint: '' });
      notify.success('예약을 저장했습니다.');
    } catch (reason) {
      const status = (reason as { status?: number }).status;
      setError(status === 409 ? '같은 시간에 담당자·공간·장비가 이미 사용 중이거나 근무 시간이 아닙니다. 시간을 바꿔 다시 시도해 주세요.' : '예약을 저장하지 못했습니다. 입력 내용은 유지됩니다.');
    } finally { setSaving(false); }
  }

  async function move(item: Appointment, targetStatus: string, reason: string | null = null) {
    try {
      const saved = await api.transitionAppointment(organizationId, item.id, { target_status: targetStatus, reason, expected_version: item.version, operation_id: crypto.randomUUID() });
      setItems((old) => old.map((row) => (row.id === saved.id ? saved : row)));
    } catch (failure) {
      setError((failure as { status?: number }).status === 409 ? '다른 곳에서 먼저 변경되었습니다. 목록을 새로 불러옵니다.' : '예약 상태를 변경하지 못했습니다.');
      void load();
    }
  }

  async function advance(item: Appointment, targetStatus: string) {
    if (targetStatus === 'canceled') { setCancelReason(''); setCancelTarget(item); return; }
    if (targetStatus === 'completed' && !(await confirm({ title: '방문 완료', message: '이 예약을 완료 처리할까요?', confirmLabel: '완료' }))) return;
    await move(item, targetStatus);
  }

  return (
    <section className="appointment-page">
      <div className="page-toolbar">
        <div><h1>예약</h1><p className="muted">고객·담당자·서비스 일정을 관리합니다.</p></div>
        <div className="row-actions">
          {canManageResources && <button type="button" onClick={() => setResourceDialog(true)}>공간·장비 관리</button>}
          <input type="date" aria-label="예약 날짜" value={day} onChange={(event) => setDay(event.target.value)} />
        </div>
      </div>
      {error && <p role="alert" className="form-error">{error} <button type="button" onClick={() => void load()}>다시 불러오기</button></p>}
      <div className="appointment-layout">
        <section className="calendar-panel">
          <ol className="appointment-list">
            {rows.map((item) => (
              <li key={item.id}>
                <time>{new Date(item.start_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</time>
                <div><strong>{item.service_name_snapshot}</strong><span>{customers.find((c) => c.id === item.customer_id)?.name ?? ''} · {staff.find((s) => s.id === item.staff_id)?.name ?? '담당자'}</span></div>
                <em>{labels[item.status] ?? item.status}</em>
                {!readOnly && item.status !== 'completed' && item.status !== 'canceled' && item.status !== 'no_show' && (
                  <div className="row-actions">
                    {item.status === 'reserved' && <button onClick={() => void advance(item, 'confirmed')}>확정</button>}
                    {item.status === 'confirmed' && <button onClick={() => void advance(item, 'checked_in')}>방문</button>}
                    {item.status === 'checked_in' && <button onClick={() => void advance(item, 'completed')}>완료</button>}
                    <button onClick={() => void advance(item, 'canceled')}>취소</button>
                  </div>
                )}
              </li>
            ))}
          </ol>
          {!rows.length && <p className="muted empty-state">이 날짜에 예약이 없습니다.</p>}
        </section>
        {!readOnly && (
          <form className="appointment-form" onSubmit={submit}>
            <h2>새 예약</h2>
            <label>고객<select required value={form.customer_id} onChange={(e) => setForm({ ...form, customer_id: e.target.value })}><option value="">선택</option>{customers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
            <label>담당자<select required value={form.staff_id} onChange={(e) => setForm({ ...form, staff_id: e.target.value })}><option value="">선택</option>{staff.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
            <label>서비스<select required value={form.service_id} onChange={(e) => setForm({ ...form, service_id: e.target.value })}><option value="">선택</option>{services.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.duration_minutes}분</option>)}</select></label>
            <label>시작 시각<input required type="datetime-local" value={form.start_at} onChange={(e) => setForm({ ...form, start_at: e.target.value })} /></label>
            <ResourcePicker
              api={api}
              organizationId={organizationId}
              serviceId={form.service_id || null}
              value={resourceIds}
              onChange={setResourceIds}
              onRequirementsChange={(needs, pool) => setRequirements({ needs, pool })}
            />
            <button className="primary-button" disabled={saving}>{saving ? '저장 중…' : '예약 저장'}</button>
          </form>
        )}
      </div>
      {resourceDialog && <ResourceManagerDialog api={api} organizationId={organizationId} readOnly={!canManageResources} onClose={() => { setResourceDialog(false); void load(); }} />}
      {cancelTarget && (
        <Modal title="예약 취소" size="sm" onClose={() => setCancelTarget(null)}>
          <label>취소 사유 (필수)<textarea value={cancelReason} maxLength={1000} onChange={(e) => setCancelReason(e.target.value)} /></label>
          <div className="ba-actions">
            <button type="button" onClick={() => setCancelTarget(null)}>닫기</button>
            <button type="button" className="ba-danger" disabled={!cancelReason.trim()} onClick={() => { const target = cancelTarget; setCancelTarget(null); void move(target, 'canceled', cancelReason.trim()); }}>예약 취소</button>
          </div>
        </Modal>
      )}
    </section>
  );
}
