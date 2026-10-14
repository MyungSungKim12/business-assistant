import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { confirm, notify } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { appointmentsSchema, type Appointment, type AppointmentService, type AppointmentStaff, type Customer } from '../../api/schemas';
import { ResourceManagerDialog, resourceApi } from '../appointment-resources';
import type { AppointmentResource } from '../appointment-resources';
import { AppointmentDetail } from './AppointmentDetail';
import { AppointmentForm, type FormValues } from './AppointmentForm';
import { AppointmentList } from './AppointmentList';
import { AppointmentToolbar, type ViewMode } from './AppointmentToolbar';
import { DayGrid } from './DayGrid';
import { ReasonModal, type ReasonKind } from './ReasonModal';
import { WeekGrid } from './WeekGrid';
import { mergeAppointments, nameLookup, needsReason, type TargetStatus } from './appointmentRules';
import { addDays, kstDateKey, localInputAt, todayKstKey, weekStartOf } from './appointmentTime';
import './appointments.css';

/** 서버가 기본으로 돌려주는 범위(오늘 -7일 ~ +60일, KST). 그 밖의 날짜는 기간을 지정해 따로 불러온다. */
const DEFAULT_PAST_DAYS = 7;
const DEFAULT_FUTURE_DAYS = 60;

type Panel =
  | { kind: 'none' }
  | { kind: 'create'; key: number; seed?: Partial<FormValues> }
  | { kind: 'detail'; id: string }
  | { kind: 'edit'; id: string };

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
  const [staffFilter, setStaffFilter] = useState('');
  const [services, setServices] = useState<AppointmentService[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [resources, setResources] = useState<AppointmentResource[]>([]);
  const [error, setError] = useState('');
  const [view, setView] = useState<ViewMode>('day');
  const [day, setDay] = useState(() => todayKstKey());
  const [panel, setPanel] = useState<Panel>(() => (readOnly ? { kind: 'none' } : { kind: 'create', key: 0 }));
  const [resourceDialog, setResourceDialog] = useState(false);
  const [reasonTarget, setReasonTarget] = useState<{ appointment: Appointment; kind: ReasonKind } | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const dirtyRef = useRef(false);
  const createKey = useRef(1);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // 지금 보는 기간이 서버 기본 범위 밖이면 그 기간만 따로 읽는다.
  const visible = useMemo(() => (view === 'week' ? { from: weekStartOf(day), to: addDays(weekStartOf(day), 6) } : { from: day, to: day }), [view, day]);
  const fetchVisible = useCallback(async (): Promise<Appointment[]> => {
    const today = todayKstKey();
    if (visible.from >= addDays(today, -DEFAULT_PAST_DAYS) && visible.to <= addDays(today, DEFAULT_FUTURE_DAYS)) return [];
    return api.call('GET', `/organizations/${organizationId}/appointments?from_date=${visible.from}&to_date=${visible.to}`, appointmentsSchema);
  }, [api, organizationId, visible]);

  const load = useCallback(() => Promise.all([
    api.listAppointments(organizationId),
    api.listAppointmentStaff(organizationId),
    api.listAppointmentServices(organizationId),
    api.listCustomers(organizationId),
    fetchVisible(),
    resourceApi.listResources(api, organizationId).catch((): AppointmentResource[] => []),
  ])
    .then(([appointments, staffRows, serviceRows, customerRows, rangeRows, resourceRows]) => {
      setItems((old) => mergeAppointments(old, [...appointments, ...rangeRows]));
      setStaff(staffRows.filter((row) => row.is_active));
      setServices(serviceRows.filter((row) => row.is_active));
      setCustomers(customerRows.filter((row) => row.status === 'active'));
      setResources(resourceRows);
    })
    .catch(() => setError('예약 정보를 불러오지 못했습니다.')), [api, organizationId, fetchVisible]);

  useEffect(() => { void load(); }, [api, organizationId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 보기·날짜를 옮기면 새로 보이는 기간이 기본 범위 밖일 때만 추가로 읽는다.
  const firstRange = useRef(true);
  useEffect(() => {
    if (firstRange.current) { firstRange.current = false; return; }
    let alive = true;
    fetchVisible()
      .then((rows) => { if (alive && rows.length > 0) setItems((old) => mergeAppointments(old, rows)); })
      .catch(() => { if (alive) setError('선택한 기간의 예약을 불러오지 못했습니다.'); });
    return () => { alive = false; };
  }, [fetchVisible]);

  const customerName = useMemo(() => nameLookup(customers, '고객'), [customers]);
  const staffName = useMemo(() => nameLookup(staff, '담당자'), [staff]);
  const resourceName = useCallback((id: string) => resources.find((row) => row.id === id)?.name, [resources]);
  // 담당자 필터는 주·목록 보기에만 적용한다. 선택한 담당자가 사라졌으면(비활성 등) 전체로 본다.
  const activeStaffFilter = staff.some((row) => row.id === staffFilter) ? staffFilter : '';
  const filteredItems = useMemo(() => (activeStaffFilter ? items.filter((item) => item.staff_id === activeStaffFilter) : items), [items, activeStaffFilter]);
  const listRows = useMemo(() => filteredItems.filter((item) => kstDateKey(item.start_at) === day).sort((a, b) => a.start_at.localeCompare(b.start_at)), [filteredItems, day]);

  const selected = panel.kind === 'detail' || panel.kind === 'edit' ? items.find((item) => item.id === panel.id) ?? null : null;
  const selectedId = selected?.id ?? null;

  /** 작성 중인 입력이 사라질 이동이면 먼저 확인한다. 이동해도 되면 true. */
  async function canLeaveForm(): Promise<boolean> {
    if (!dirtyRef.current) return true;
    return confirm({ title: '작성 중인 내용', message: '저장하지 않은 입력이 있습니다. 버리고 이동할까요?', confirmLabel: '버리고 이동', cancelLabel: '계속 작성' });
  }

  async function selectAppointment(appointment: Appointment) {
    if (panel.kind !== 'create' && selectedId === appointment.id) return;
    if (!(await canLeaveForm())) return;
    setPanel({ kind: 'detail', id: appointment.id });
  }

  async function startCreate(seed?: Partial<FormValues>) {
    if (readOnly) return;
    if (!(await canLeaveForm())) return;
    setPanel({ kind: 'create', key: createKey.current++, seed });
  }

  async function closePanel() {
    if (!(await canLeaveForm())) return;
    setPanel(readOnly ? { kind: 'none' } : { kind: 'create', key: createKey.current++ });
  }

  function startEdit() {
    if (!selected) return;
    setPanel({ kind: 'edit', id: selected.id });
  }

  async function cancelEdit() {
    if (!(await canLeaveForm())) return;
    if (selected) setPanel({ kind: 'detail', id: selected.id });
  }

  async function transition(item: Appointment, target: TargetStatus, reason: string | null = null) {
    setBusy(true);
    try {
      const saved = await api.transitionAppointment(organizationId, item.id, { target_status: target, reason, expected_version: item.version, operation_id: crypto.randomUUID() });
      setItems((old) => mergeAppointments(old, [saved]));
      setError('');
    } catch (failure) {
      const status = (failure as { status?: number }).status;
      setError(status === 409 ? '다른 곳에서 먼저 변경되었거나 지금 상태에서는 할 수 없는 처리입니다. 목록을 새로 불러옵니다.' : '예약 상태를 변경하지 못했습니다.');
      void load();
    } finally { setBusy(false); }
  }

  async function advance(item: Appointment, target: TargetStatus) {
    if (needsReason(target)) { setReasonTarget({ appointment: item, kind: target === 'no_show' ? 'no_show' : 'canceled' }); return; }
    if (target === 'completed' && !(await confirm({ title: '방문 완료', message: '이 예약을 완료 처리할까요?', confirmLabel: '완료' }))) return;
    await transition(item, target);
  }

  function created(saved: Appointment) {
    setItems((old) => mergeAppointments(old, [saved]));
    setPanel({ kind: 'create', key: createKey.current++ });
    notify.success('예약을 저장했습니다.');
  }

  function edited(saved: Appointment) {
    setItems((old) => mergeAppointments(old, [saved]));
    setPanel({ kind: 'detail', id: saved.id });
    notify.success('예약을 수정했습니다.');
  }

  function shiftDay(direction: 1 | -1) {
    setDay((old) => addDays(old, direction * (view === 'week' ? 7 : 1)));
  }

  function renderSide() {
    if (panel.kind === 'create' && !readOnly) {
      return (
        <AppointmentForm
          key={`create-${panel.key}`}
          api={api}
          organizationId={organizationId}
          customers={customers}
          staff={staff}
          services={services}
          seed={panel.seed}
          customerName={customerName}
          staffName={staffName}
          onSaved={created}
          onDirtyChange={(dirty) => { dirtyRef.current = dirty; }}
        />
      );
    }
    if (panel.kind === 'edit' && selected && !readOnly) {
      return (
        <AppointmentForm
          key={`edit-${selected.id}`}
          api={api}
          organizationId={organizationId}
          customers={customers}
          staff={staff}
          services={services}
          appointment={selected}
          customerName={customerName}
          staffName={staffName}
          onSaved={edited}
          onDirtyChange={(dirty) => { dirtyRef.current = dirty; }}
          onCancel={() => void cancelEdit()}
          onReload={() => void load()}
        />
      );
    }
    if (selected) {
      return (
        <AppointmentDetail
          appointment={selected}
          customerName={customerName}
          staffName={staffName}
          resourceName={resourceName}
          readOnly={readOnly}
          busy={busy}
          onTransition={(target) => void advance(selected, target)}
          onEdit={startEdit}
          onClose={() => void closePanel()}
        />
      );
    }
    return (
      <section className="apt-detail apt-detail--empty" aria-label="예약 안내">
        <p className="muted">{readOnly ? '예약을 선택하면 상세 내용이 여기에 보입니다.' : '예약을 선택하거나 달력의 빈 시간을 눌러 새 예약을 만드세요.'}</p>
      </section>
    );
  }

  return (
    <section className="appointment-page apt-page">
      <AppointmentToolbar
        view={view}
        day={day}
        onViewChange={setView}
        onDayChange={setDay}
        onPrev={() => shiftDay(-1)}
        onNext={() => shiftDay(1)}
        onToday={() => setDay(todayKstKey())}
        staffFilter={{ options: staff.map((row) => ({ id: row.id, name: row.name })), value: activeStaffFilter, onChange: setStaffFilter }}
        extra={canManageResources ? <button type="button" onClick={() => setResourceDialog(true)}>공간·장비 관리</button> : undefined}
      />
      {error && <p role="alert" className="form-error apt-error">{error} <button type="button" onClick={() => { setError(''); void load(); }}>다시 불러오기</button></p>}
      <div className="apt-body">
        <section className="apt-main" aria-label="예약 달력">
          {view === 'day' && (
            <DayGrid
              day={day}
              items={items}
              staff={staff}
              customerName={customerName}
              selectedId={selectedId}
              now={now}
              canCreate={!readOnly}
              onSelect={(appointment) => void selectAppointment(appointment)}
              onEmptyClick={(staffId, minutes) => void startCreate({ staff_id: staffId, start_at: localInputAt(day, minutes) })}
            />
          )}
          {view === 'week' && (
            <WeekGrid
              day={day}
              items={filteredItems}
              customerName={customerName}
              staffName={staffName}
              selectedId={selectedId}
              now={now}
              canCreate={!readOnly}
              onSelect={(appointment) => void selectAppointment(appointment)}
              onEmptyClick={(date, minutes) => void startCreate({ start_at: localInputAt(date, minutes) })}
            />
          )}
          {view === 'list' && (
            <AppointmentList
              rows={listRows}
              customerName={customerName}
              staffName={staffName}
              selectedId={selectedId}
              readOnly={readOnly}
              onSelect={(appointment) => void selectAppointment(appointment)}
              onTransition={(appointment, target) => void advance(appointment, target)}
            />
          )}
        </section>
        <aside className="apt-side">{renderSide()}</aside>
      </div>
      {resourceDialog && <ResourceManagerDialog api={api} organizationId={organizationId} readOnly={!canManageResources} onClose={() => { setResourceDialog(false); void load(); }} />}
      {reasonTarget && (
        <ReasonModal
          kind={reasonTarget.kind}
          summary={`${customerName(reasonTarget.appointment.customer_id)} · ${reasonTarget.appointment.service_name_snapshot}`}
          onClose={() => setReasonTarget(null)}
          onSubmit={(reason) => { const target = reasonTarget; setReasonTarget(null); void transition(target.appointment, target.kind, reason); }}
        />
      )}
    </section>
  );
}
