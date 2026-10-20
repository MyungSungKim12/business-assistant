import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { ApiClient } from '../../api/client';
import { appointmentSchema, type Appointment, type AppointmentService, type AppointmentStaff, type Customer } from '../../api/schemas';
import { ResourcePicker, describeRequirements, isDefiniteRejection, missingRequirements, useOperationTracker } from '../appointment-resources';
import type { AppointmentResource, ResourceRequirement } from '../appointment-resources';
import { formatKstTime, kstIso, todayKstKey, toKstLocalInput } from './appointmentTime';
import { canStaffDoService, type ServiceStaffMap } from './serviceStaff';
import { AvailabilityChips } from './AvailabilityChips';
import { AppointmentCustomerPicker } from './AppointmentCustomerPicker';
import { useDraftProtection } from '../../app/DraftBoundary';
import { dateOfLocalInput, type AvailabilityQuery } from './availability';

export interface FormValues {
  customer_id: string;
  staff_id: string;
  service_id: string;
  /** datetime-local 값(KST 벽시계). */
  start_at: string;
  resource_ids: string[];
}

export const emptyFormValues: FormValues = { customer_id: '', staff_id: '', service_id: '', start_at: '', resource_ids: [] };

export interface AppointmentFormProps {
  api: ApiClient;
  organizationId: string;
  customers: Customer[];
  staff: AppointmentStaff[];
  services: AppointmentService[];
  /** 서비스별 담당 가능 직원(SVC-11). 항목이 없는 서비스는 모든 직원이 가능하다. */
  serviceStaff?: ServiceStaffMap;
  /** 있으면 수정 폼, 없으면 새 예약 폼. */
  appointment?: Appointment;
  /** 새 예약 폼의 처음 값(빈 칸을 눌러 들어온 담당자·시각 등). */
  seed?: Partial<FormValues>;
  /** 이름을 찾지 못하는 고객·담당자·서비스(비활성)를 수정 폼 선택지에 남기기 위한 이름 조회. */
  customerName: (id: string) => string;
  staffName: (id: string) => string;
  onSaved: (saved: Appointment) => void;
  /** 입력이 처음 값과 달라졌는지 알린다(화면 이동 시 확인용). */
  onDirtyChange: (dirty: boolean) => void;
  /** 수정 폼에서 변경을 그만두고 상세로 돌아간다. */
  onCancel?: () => void;
  /** 충돌(409) 뒤 서버의 최신 예약을 다시 불러오게 한다. */
  onReload?: () => void;
  onCustomerFound?: (customer: Customer) => void;
  onBusyChange?: (busy: boolean) => void;
}

const sortedIds = (ids: string[]) => [...ids].sort();
const sameValues = (a: FormValues, b: FormValues) => a.customer_id === b.customer_id && a.staff_id === b.staff_id && a.service_id === b.service_id && a.start_at === b.start_at && sortedIds(a.resource_ids).join() === sortedIds(b.resource_ids).join();

/** 새 예약·예약 수정 공용 폼. 저장에 실패해도 입력은 그대로 둔다. */
export function AppointmentForm({ api, organizationId, customers, staff, services, serviceStaff = {}, appointment: latestAppointment, seed, customerName, staffName, onSaved, onDirtyChange, onCancel, onReload, onCustomerFound, onBusyChange }: AppointmentFormProps) {
  // 자동 갱신이 편집 시작 버전을 바꾸면 동시 수정 검사가 우회된다. 명시적으로 다시 열 때만 기준을 바꾼다.
  const appointment = useRef(latestAppointment).current;
  const editing = appointment !== undefined;
  const initial = useMemo<FormValues>(() => (appointment
    ? { customer_id: appointment.customer_id, staff_id: appointment.staff_id, service_id: appointment.service_id, start_at: toKstLocalInput(appointment.start_at), resource_ids: appointment.resource_ids }
    : { ...emptyFormValues, ...seed }), [appointment?.id, seed]); // eslint-disable-line react-hooks/exhaustive-deps
  const [values, setValues] = useState<FormValues>(initial);
  const [requirements, setRequirements] = useState<{ needs: ResourceRequirement[]; pool: AppointmentResource[] }>({ needs: [], pool: [] });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  // 같은 입력의 재시도는 같은 operation_id를 써서 서버가 중복 저장을 막고, 입력이 바뀌면 새로 만든다.
  const operation = useOperationTracker();

  const dirty = !sameValues(values, initial);
  useDraftProtection(dirty, saving);
  useEffect(() => { onBusyChange?.(saving); return () => onBusyChange?.(false); }, [saving, onBusyChange]);
  const dirtyReport = useRef(onDirtyChange);
  dirtyReport.current = onDirtyChange;
  useEffect(() => { dirtyReport.current(dirty); }, [dirty]);
  useEffect(() => () => dirtyReport.current(false), []);

  const missing = missingRequirements(requirements.needs, requirements.pool, values.resource_ids);
  const serviceChanged = editing && values.service_id !== appointment.service_id;

  const customerOptions = editing && !customers.some((row) => row.id === appointment.customer_id)
    ? [{ id: appointment.customer_id, name: customerName(appointment.customer_id), status: 'archived' as const, phone: null, tags: [] } as unknown as Customer, ...customers]
    : customers;
  // 서비스를 고르면 그 서비스를 맡을 수 있는 직원만 보인다. 수정 중인 예약의 기존 담당자는 서비스·담당자를 안 바꾸는 동안 그대로 둔다.
  const keepsOriginalStaff = (staffId: string) => editing && staffId === appointment.staff_id && values.service_id === appointment.service_id;
  const eligible = (staffId: string) => canStaffDoService(serviceStaff, values.service_id, staffId) || keepsOriginalStaff(staffId);
  const allStaff = editing && !staff.some((row) => row.id === appointment.staff_id) ? [{ id: appointment.staff_id, name: staffName(appointment.staff_id) }, ...staff] : staff;
  const staffOptions = allStaff.filter((row) => eligible(row.id));
  const staffNotAllowed = values.staff_id !== '' && !eligible(values.staff_id);
  const restricted = values.service_id !== '' && (serviceStaff[values.service_id]?.length ?? 0) > 0;
  const serviceOptions = editing && !services.some((row) => row.id === appointment.service_id)
    ? [{ id: appointment.service_id, name: appointment.service_name_snapshot, duration_minutes: appointment.duration_minutes }, ...services]
    : services;

  const availabilityDate = dateOfLocalInput(values.start_at) ?? todayKstKey();
  const availabilityQuery: AvailabilityQuery | null = values.service_id
    ? { serviceId: values.service_id, date: availabilityDate, staffId: values.staff_id || undefined, resourceIds: values.resource_ids, excludeAppointmentId: appointment?.id }
    : null;
  /** 칩을 누르면 그 날짜·시각을 채우고, 담당자를 아직 안 골랐다면 그 시각에 가능한 첫 담당자로 채운다. */
  function pickTime(time: string, availableStaffIds: string[]) {
    const staffId = values.staff_id || availableStaffIds.find((id) => eligible(id)) || '';
    set({ start_at: `${availabilityDate}T${time}`, staff_id: staffId });
  }

  const set = (patch: Partial<FormValues>) => { setValues((old) => ({ ...old, ...patch })); setConflict(false); };

  function changeService(serviceId: string) {
    // 원래 서비스로 되돌리면 저장돼 있던 자원 선택도 되돌린다. 다른 서비스면 선택기가 필수 기준에 맞춰 다시 고른다.
    if (editing && serviceId === appointment.service_id) set({ service_id: serviceId, resource_ids: appointment.resource_ids });
    else set({ service_id: serviceId });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (staffNotAllowed) { setError('선택한 담당자는 이 서비스를 맡을 수 없습니다. 담당자나 서비스를 바꿔 주세요.'); return; }
    if (missing.length > 0) { setError(`필수 자원이 부족합니다. 필요한 기준: ${describeRequirements(requirements.needs)}`); return; }
    const input = {
      customer_id: values.customer_id,
      staff_id: values.staff_id,
      service_id: values.service_id,
      start_at: kstIso(values.start_at),
      source: appointment?.source ?? 'manual',
      expected_version: appointment ? appointment.version : null,
      resource_ids: sortedIds(values.resource_ids),
    };
    const operationId = operation.idFor(JSON.stringify({ id: appointment?.id ?? null, ...input }));
    setSaving(true);
    try {
      const saved = appointment
        ? await api.call('PUT', `/organizations/${organizationId}/appointments/${appointment.id}`, appointmentSchema, { ...input, operation_id: operationId })
        : await api.createAppointment(organizationId, { ...input, expected_version: null, operation_id: operationId });
      operation.reset();
      setError(''); setConflict(false);
      onSaved(saved);
    } catch (reason) {
      const status = (reason as { status?: number }).status;
      // 서버가 명확히 거절했으면 새 시도로 보고 ID를 바꾼다. 결과를 알 수 없는 실패(네트워크·5xx)는 같은 ID로 재시도한다.
      if (isDefiniteRejection(reason)) operation.reset();
      if (status === 409) {
        setConflict(editing);
        setError(editing
          ? '다른 곳에서 먼저 변경되었거나, 같은 시간에 담당자·공간·장비가 이미 사용 중이거나 근무 시간이 아닙니다. 최신 상태를 불러온 뒤 시간을 확인해 다시 저장해 주세요.'
          : '같은 시간에 담당자·공간·장비가 이미 사용 중이거나 근무 시간이 아닙니다. 시간을 바꿔 다시 시도해 주세요.');
      } else if (status === 422) {
        setError('입력 내용이 올바르지 않습니다. 고객·담당자·서비스·시작 시각을 확인해 주세요. 입력 내용은 유지됩니다.');
      } else {
        setError(`예약을 저장하지 못했습니다. 입력 내용은 유지됩니다.${editing ? ' 같은 내용으로 다시 저장해도 중복되지 않습니다.' : ''}`);
      }
    } finally { setSaving(false); }
  }

  return (
    <form className="apt-form" onSubmit={submit} aria-label={editing ? '예약 수정' : '새 예약'}>
      <header className="apt-side__head"><h2>{editing ? '예약 수정' : '새 예약'}</h2></header>
      <fieldset disabled={saving} className="apt-form__fields">
      <AppointmentCustomerPicker api={api} organizationId={organizationId} customers={customerOptions} value={values.customer_id} disabled={editing} onChange={(id,customer) => { set({ customer_id:id }); if(customer) onCustomerFound?.(customer); }} />
      {editing && <p className="muted apt-form__hint">고객은 바꿀 수 없습니다. 다른 고객이면 새 예약을 만드세요.</p>}
      <label>담당자
        <select required value={values.staff_id} onChange={(e) => set({ staff_id: e.target.value })}>
          <option value="">선택</option>
          {staffOptions.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </label>
      {restricted && <p className="muted apt-form__hint" data-testid="service-staff-hint">이 서비스는 지정된 직원만 맡을 수 있어 담당자 목록이 제한됩니다.</p>}
      {staffNotAllowed && <p role="alert" className="form-error">선택한 담당자는 이 서비스를 맡을 수 없습니다. 담당자나 서비스를 바꿔 주세요.</p>}
      <label>서비스
        <select required value={values.service_id} onChange={(e) => changeService(e.target.value)}>
          <option value="">선택</option>
          {serviceOptions.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.duration_minutes}분</option>)}
        </select>
      </label>
      <label>시작 시각
        <input required type="datetime-local" value={values.start_at} onChange={(e) => set({ start_at: e.target.value })} />
      </label>
      {values.start_at && values.service_id && <p className="apt-form__schedule">예상 종료 {formatKstTime(Date.parse(kstIso(values.start_at)) + (services.find(x => x.id === values.service_id)?.duration_minutes ?? appointment?.duration_minutes ?? 0) * 60_000)} · 여유 {services.find(x => x.id === values.service_id)?.buffer_minutes ?? appointment?.buffer_minutes ?? 0}분</p>}
      {latestAppointment && latestAppointment.version !== appointment?.version && <p role="alert" className="apt-warning">다른 곳에서 예약이 변경되었습니다. 현재 입력은 유지되며, 저장 시 충돌을 확인합니다. 최신 예약을 확인한 뒤 다시 수정해 주세요.</p>}
      <AvailabilityChips api={api} organizationId={organizationId} query={availabilityQuery} startAt={values.start_at} onPick={pickTime} />
      <ResourcePicker
        api={api}
        organizationId={organizationId}
        serviceId={values.service_id || null}
        value={values.resource_ids}
        onChange={(ids) => setValues((old) => ({ ...old, resource_ids: ids }))}
        onRequirementsChange={(needs, pool) => setRequirements({ needs, pool })}
        autoSelect={!editing || serviceChanged}
      />
      {error && (
        <p role="alert" className="form-error">
          {error}
          {conflict && onReload && <> <button type="button" onClick={onReload}>최신 상태 불러오기</button></>}
        </p>
      )}
      <div className="apt-form__actions">
        {editing && onCancel && <button type="button" onClick={onCancel} disabled={saving}>수정 취소</button>}
        <button className="primary-button" disabled={saving}>{saving ? '저장 중…' : editing ? '변경 저장' : '예약 저장'}</button>
      </div>
      </fieldset>
    </form>
  );
}
