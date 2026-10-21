import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { confirm, notify } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { appointmentsSchema, type Appointment, type AppointmentBranch, type AppointmentService, type AppointmentStaff, type Customer } from '../../api/schemas';
import { BranchManagerDialog, ResourceManagerDialog, resourceApi } from '../appointment-resources';
import type { AppointmentResource } from '../appointment-resources';
import { AppointmentDetail } from './AppointmentDetail';
import { AppointmentStatusHistory } from './AppointmentStatusHistory';
import { AppointmentForm, type FormValues } from './AppointmentForm';
import { AppointmentList } from './AppointmentList';
import { AppointmentToolbar, type ViewMode } from './AppointmentToolbar';
import { WaitlistDialog } from './WaitlistDialog';
import { AppointmentSeriesDialog } from './AppointmentSeriesDialog';
import { DayGrid } from './DayGrid';
import { ReasonModal, type ReasonKind } from './ReasonModal';
import { WeekGrid } from './WeekGrid';
import { buildServiceStaffMap, canStaffDoService, type ServiceStaffMap } from './serviceStaff';
import { canEditAppointment, mergeAppointments, nameLookup, needsReason, statusLabels, type TargetStatus } from './appointmentRules';
import { useDraftProtection } from '../../app/DraftBoundary';
import { addDays, formatKstTime, kstDateKey, kstIso, localInputAt, todayKstKey, toKstLocalInput, weekStartOf } from './appointmentTime';
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
  onOpenCustomer?: (row: Appointment) => Promise<boolean>;
  onOpenTreatment?: (row: Appointment) => Promise<boolean>;
  onOpenCheckout?: (row: Appointment) => Promise<boolean>;
}

export function AppointmentPage({ api, organizationId, readOnly, canManageResources = false, onOpenCustomer, onOpenTreatment, onOpenCheckout }: AppointmentPageProps) {
  const [items, setItems] = useState<Appointment[]>([]);
  const [selectedSnapshot, setSelectedSnapshot] = useState<Appointment | null>(null);
  const [staff, setStaff] = useState<AppointmentStaff[]>([]);
  const [branches, setBranches] = useState<AppointmentBranch[]>([]);
  const [branchId, setBranchId] = useState('');
  const [staffDirectory,setStaffDirectory]=useState<AppointmentStaff[]>([]);
  const [staffFilter, setStaffFilter] = useState('');
  const [serviceStaff, setServiceStaff] = useState<ServiceStaffMap>({});
  const [services, setServices] = useState<AppointmentService[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [resources, setResources] = useState<AppointmentResource[]>([]);
  const [error, setError] = useState('');
  const [view, setView] = useState<ViewMode>('day');
  const [day, setDay] = useState(() => todayKstKey());
  const [panel, setPanel] = useState<Panel>(() => (readOnly ? { kind: 'none' } : { kind: 'create', key: 0 }));
  const [resourceDialog, setResourceDialog] = useState(false);
  const [branchDialog, setBranchDialog] = useState(false);
  const [waitlistDialog,setWaitlistDialog]=useState(false);
  const [seriesDialog,setSeriesDialog]=useState(false);
  const [reasonTarget, setReasonTarget] = useState<{ appointment: Appointment; kind: ReasonKind } | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [lastSynced, setLastSynced] = useState<number | null>(null);
  const [syncError, setSyncError] = useState('');
  const [resourceWarning, setResourceWarning] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const dirtyRef = useRef(false);
  const editorBusy = useRef(false);
  const reportBusy = useCallback((saving: boolean) => { editorBusy.current = saving; }, []);
  const createKey = useRef(1);
  const mutationRevision = useRef(0);
  const syncRequest = useRef(0);
  useDraftProtection(false, busy);
  const reportDirty = useCallback((dirty: boolean) => { dirtyRef.current = dirty; }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // 지금 보는 기간이 서버 기본 범위 밖이면 그 기간만 따로 읽는다.
  const visible = useMemo(() => (view === 'week' ? { from: weekStartOf(day), to: addDays(weekStartOf(day), 6) } : { from: day, to: day }), [view, day]);
  const scope = `${organizationId}:${visible.from}:${visible.to}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const refreshVisible = useCallback(async () => {
    const request = ++syncRequest.current, revision = mutationRevision.current;
    setRefreshing(true);
    try {
      const rows = await api.call('GET', `/organizations/${organizationId}/appointments?from_date=${visible.from}&to_date=${visible.to}`, appointmentsSchema);
      if (request !== syncRequest.current || scopeRef.current !== scope || revision !== mutationRevision.current) return;
      setItems(old => mergeAppointments(old.filter(item => kstDateKey(item.start_at) < visible.from || kstDateKey(item.start_at) > visible.to), rows));
      setLastSynced(Date.now()); setSyncError('');
    } catch {
      if (request === syncRequest.current && scopeRef.current === scope) setSyncError('최근 예약을 확인하지 못했습니다. 화면은 마지막으로 받은 일정입니다. 새로고침해 주세요.');
    } finally { if (request === syncRequest.current) setRefreshing(false); }
  }, [api, organizationId, visible, scope]);
  useEffect(() => {
    setRefreshing(false);
    let pending = false;
    const sync = async () => { if (document.visibilityState === 'hidden' || pending) return; pending = true; try { await refreshVisible(); } finally { pending = false; } };
    const timer = setInterval(() => void sync(), 60_000);
    const focus = () => void sync();
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { clearInterval(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); syncRequest.current++; };
  }, [refreshVisible]);
  const fetchVisible = useCallback(async (): Promise<Appointment[]> => {
    const today = todayKstKey();
    if (visible.from >= addDays(today, -DEFAULT_PAST_DAYS) && visible.to <= addDays(today, DEFAULT_FUTURE_DAYS)) return [];
    return api.call('GET', `/organizations/${organizationId}/appointments?from_date=${visible.from}&to_date=${visible.to}`, appointmentsSchema);
  }, [api, organizationId, visible]);

  const load = useCallback(() => Promise.all([
    api.listAppointmentBranches(organizationId).catch(() => [] as AppointmentBranch[]),
    api.listAppointments(organizationId),
    api.listAppointmentStaff(organizationId),
    api.listAppointmentServices(organizationId),
    api.listCustomers(organizationId),
    fetchVisible(),
    resourceApi.listResources(api, organizationId).catch(() => { setResourceWarning('공간·장비 정보를 확인하지 못했습니다. 저장 시 서버가 최종 검사합니다.'); return [] as AppointmentResource[]; }),
    resourceApi.listServiceStaff(api, organizationId).catch(() => { setResourceWarning('담당 가능 직원 규칙을 확인하지 못했습니다. 저장 시 서버가 최종 검사합니다.'); return []; }),
  ])
    .then(([branchRows, appointments, staffRows, serviceRows, customerRows, rangeRows, resourceRows, serviceStaffRows]) => {
      setBranches(branchRows);
      setBranchId(current => branchRows.some(row => row.id === current) ? current : branchRows.find(row => row.is_primary)?.id ?? branchRows[0]?.id ?? '');
      setServiceStaff(buildServiceStaffMap(serviceStaffRows));
      setItems((old) => mergeAppointments(old, [...appointments, ...rangeRows]));
      setStaff(staffRows.filter((row) => row.is_active));
      setStaffDirectory(staffRows);
      setServices(serviceRows.filter((row) => row.is_active));
      setCustomers(customerRows);
      setResources(resourceRows);
      setLastSynced(Date.now());
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
  const staffName = useMemo(() => nameLookup(staffDirectory, '담당자'), [staffDirectory]);
  const resourceName = useCallback((id: string) => resources.find((row) => row.id === id)?.name, [resources]);
  // 담당자 필터는 주·목록 보기에만 적용한다. 선택한 담당자가 사라졌으면(비활성 등) 전체로 본다.
  const activeStaffFilter = staff.some((row) => row.id === staffFilter) ? staffFilter : '';
  const activeBranchId = branches.some(row => row.id === branchId) ? branchId : branches.find(row => row.is_primary)?.id ?? branches[0]?.id ?? '';
  const branchStaff = useMemo(() => staff.filter(row => !row.branch_id || row.branch_id === activeBranchId), [staff, activeBranchId]);
  const filteredItems = useMemo(() => items.filter(item => (!activeBranchId || !item.branch_id || item.branch_id === activeBranchId) && (!activeStaffFilter || item.staff_id === activeStaffFilter) && (!statusFilter || item.status === statusFilter)), [items, activeBranchId, activeStaffFilter, statusFilter]);
  const summaryRows = items.filter(item => (!activeBranchId || !item.branch_id || item.branch_id === activeBranchId) && kstDateKey(item.start_at) >= visible.from && kstDateKey(item.start_at) <= visible.to && (!activeStaffFilter || item.staff_id === activeStaffFilter));
  const listRows = useMemo(() => filteredItems.filter((item) => kstDateKey(item.start_at) === day).sort((a, b) => a.start_at.localeCompare(b.start_at)), [filteredItems, day]);

  const selected = panel.kind === 'detail' || panel.kind === 'edit'
    ? items.find((item) => item.id === panel.id) ?? (selectedSnapshot?.id === panel.id ? selectedSnapshot : null)
    : null;
  const selectedId = selected?.id ?? null;
  useEffect(() => {
    if (panel.kind !== 'detail' && panel.kind !== 'edit') return;
    const current = items.find(item => item.id === panel.id);
    if (current) setSelectedSnapshot(current);
  }, [items, panel]);

  /** 작성 중인 입력이 사라질 이동이면 먼저 확인한다. 이동해도 되면 true. */
  async function canLeaveForm(): Promise<boolean> {
    if (busy || editorBusy.current) { notify.info('저장 중입니다. 결과를 확인한 뒤 이동해 주세요.'); return false; }
    if (!dirtyRef.current) return true;
    return confirm({ title: '작성 중인 내용', message: '저장하지 않은 입력이 있습니다. 버리고 이동할까요?', confirmLabel: '버리고 이동', cancelLabel: '계속 작성' });
  }

  async function selectBranch(nextId: string) {
    if (nextId === activeBranchId || !(await canLeaveForm())) return;
    setBranchId(nextId); setStaffFilter(''); setPanel({ kind: 'none' });
  }

  async function selectAppointment(appointment: Appointment) {
    if (panel.kind !== 'create' && selectedId === appointment.id) return;
    if (!(await canLeaveForm())) return;
    setSelectedSnapshot(appointment);
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

  async function startEdit() {
    if (!selected) return;
    if (!(await canLeaveForm())) return;
    setPanel({ kind: 'edit', id: selected.id });
  }

  async function cancelEdit() {
    if (!(await canLeaveForm())) return;
    if (selected) setPanel({ kind: 'detail', id: selected.id });
  }

  /**
   * 끌어서 옮기기(APT-14): 확인을 받은 뒤 예약 수정과 같은 PUT으로 시간·담당자만 바꾼다.
   * 충돌·근무 시간·자원 검사는 서버가 하며, 거절되면 화면은 그대로 두고 안내한다.
   */
  async function moveAppointment(item: Appointment, target: { date: string; minutes: number; staffId?: string }) {
    if (readOnly || busy || !canEditAppointment(item.status)) return;
    const startLocal = localInputAt(target.date, target.minutes);
    const staffId = target.staffId ?? item.staff_id;
    if (startLocal === toKstLocalInput(item.start_at) && staffId === item.staff_id) return;
    if (!canStaffDoService(serviceStaff, item.service_id, staffId)) {
      setError(`${staffName(staffId)} 직원은 '${item.service_name_snapshot}' 서비스를 맡을 수 없어 옮길 수 없습니다.`);
      return;
    }
    if (!(await canLeaveForm())) return;
    const label = `${kstDateKey(kstIso(startLocal))} ${formatKstTime(kstIso(startLocal))}${staffId !== item.staff_id ? ` · ${staffName(staffId)}` : ''}`;
    const ok = await confirm({ title: '예약 이동', message: `${customerName(item.customer_id)}님 예약을 ${label}(으)로 옮길까요?`, confirmLabel: '이동' });
    if (!ok) return;
    mutationRevision.current++;
    setBusy(true);
    try {
      const saved = await api.call('PUT', `/organizations/${organizationId}/appointments/${item.id}`, appointmentsSchema.element, {
        customer_id: item.customer_id, staff_id: staffId, service_id: item.service_id, start_at: kstIso(startLocal), source: item.source,
        expected_version: item.version, resource_ids: [...item.resource_ids].sort(), operation_id: crypto.randomUUID(),
      });
      setItems((old) => mergeAppointments(old, [{ ...saved, memo: saved.memo ?? item.memo }]));
      setError('');
      notify.success('예약을 옮겼습니다.');
    } catch (failure) {
      const status = (failure as { status?: number }).status;
      setError(status === 409
        ? '옮기지 못했습니다. 다른 곳에서 먼저 변경되었거나, 그 시간에 담당자·공간·장비가 사용 중이거나 근무 시간이 아닙니다. 최신 상태를 불러옵니다.'
        : status === 422 ? '옮기지 못했습니다. 시간 또는 담당자가 올바르지 않습니다.' : '예약을 옮기지 못했습니다. 잠시 후 다시 시도해 주세요.');
      void load();
    } finally { mutationRevision.current++; setBusy(false); }
  }

  /** 메모만 저장한다. 응답에는 자원 선택이 없으므로 화면 목록에는 메모만 반영해 기존 값(버전·자원)을 지키지 않게 되는 일을 막는다. */
  async function saveMemo(item: Appointment, memo: string) {
    mutationRevision.current++;
    const saved = await api.setAppointmentMemo(organizationId, item.id, memo);
    mutationRevision.current++;
    setItems((old) => old.map((row) => (row.id === item.id ? { ...row, memo: saved.memo } : row)));
  }

  async function transition(item: Appointment, target: TargetStatus, reason: string | null = null) {
    mutationRevision.current++;
    setBusy(true);
    try {
      const saved = await api.transitionAppointment(organizationId, item.id, { target_status: target, reason, expected_version: item.version, operation_id: crypto.randomUUID() });
      setItems((old) => mergeAppointments(old, [saved]));
      setError('');
    } catch (failure) {
      const status = (failure as { status?: number }).status;
      setError(status === 409 ? '다른 곳에서 먼저 변경되었거나 지금 상태에서는 할 수 없는 처리입니다. 목록을 새로 불러옵니다.' : '예약 상태를 변경하지 못했습니다.');
      void load();
    } finally { mutationRevision.current++; setBusy(false); }
  }

  async function advance(item: Appointment, target: TargetStatus) {
    if (needsReason(target)) { setReasonTarget({ appointment: item, kind: target === 'no_show' ? 'no_show' : 'canceled' }); return; }
    if (target === 'completed' && !(await confirm({ title: '방문 완료', message: '이 예약을 완료 처리할까요?', confirmLabel: '완료' }))) return;
    await transition(item, target);
  }

  function created(saved: Appointment) {
    mutationRevision.current++;
    setItems((old) => mergeAppointments(old, [saved]));
    setPanel({ kind: 'create', key: createKey.current++ });
    notify.success('예약을 저장했습니다.');
  }

  function edited(saved: Appointment) {
    mutationRevision.current++;
    setSelectedSnapshot(saved);
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
          branchId={activeBranchId}
          customers={customers.filter(row => row.status === 'active')}
          onCustomerFound={customer => setCustomers(old => [...old.filter(row => row.id !== customer.id), customer])}
          staff={branchStaff}
          services={services}
          serviceStaff={serviceStaff}
          seed={panel.seed}
          customerName={customerName}
          staffName={staffName}
          onSaved={created}
          onDirtyChange={reportDirty}
          onBusyChange={reportBusy}
        />
      );
    }
    if (panel.kind === 'edit' && selected && !readOnly) {
      return (
        <AppointmentForm
          key={`edit-${selected.id}`}
          api={api}
          organizationId={organizationId}
          branchId={activeBranchId}
          customers={customers.filter(row => row.status === 'active')}
          staff={branchStaff}
          services={services}
          serviceStaff={serviceStaff}
          appointment={selected}
          customerName={customerName}
          staffName={staffName}
          onSaved={edited}
          onDirtyChange={reportDirty}
          onBusyChange={reportBusy}
          onCancel={() => void cancelEdit()}
          onReload={() => void (async () => { if (await canLeaveForm()) { await load(); setPanel({ kind: 'detail', id: selected.id }); } })()}
        />
      );
    }
    if (selected) {
      return (
        <AppointmentDetail
          history={<AppointmentStatusHistory api={api} organizationId={organizationId} appointmentId={selected.id} version={selected.version} />}
          appointment={selected}
          customerName={customerName}
          staffName={staffName}
          resourceName={resourceName}
          readOnly={readOnly}
          busy={busy}
          onTransition={(target) => void advance(selected, target)}
          onSaveMemo={(memo) => saveMemo(selected, memo)}
          onEdit={startEdit}
          onClose={() => void closePanel()}
          onDirtyChange={reportDirty}
          onBusyChange={reportBusy}
          onOpenCustomer={onOpenCustomer ? () => void onOpenCustomer(selected) : undefined}
          onOpenTreatment={onOpenTreatment ? () => void onOpenTreatment(selected) : undefined}
          onOpenCheckout={onOpenCheckout ? () => void onOpenCheckout(selected) : undefined}
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
        staffFilter={{ options: branchStaff.map((row) => ({ id: row.id, name: row.name })), value: activeStaffFilter, onChange: setStaffFilter }}
        branchFilter={{ options: branches.map((row) => ({ id: row.id, name: row.name })), value: activeBranchId, onChange: value => void selectBranch(value) }}
        extra={<><button type="button" aria-label="예약 새로고침" disabled={refreshing} onClick={() => void refreshVisible()}>{refreshing ? '갱신 중…' : '새로고침'}</button><button type="button" onClick={()=>setSeriesDialog(true)}>반복 예약</button>{!readOnly&&<><button type="button" className="primary-button" onClick={() => void startCreate()}>새 예약</button><button type="button" onClick={()=>setWaitlistDialog(true)}>대기 목록</button></>}{canManageResources&&<><button type="button" onClick={() => setResourceDialog(true)}>공간·장비 관리</button><button type="button" onClick={() => setBranchDialog(true)}>지점 관리</button></>}</>}
      />
      <div className="apt-overview" aria-label="예약 현황">
        <div className="apt-overview__counts"><strong>{view === 'week' ? '이번 주' : '선택일'} {summaryRows.length}건</strong>{Object.entries(statusLabels).map(([status,label]) => <span key={status} className="apt-status" data-status={status}>{label} {summaryRows.filter(item => item.status === status).length}</span>)}</div>
        <label>상태 <select aria-label="예약 상태 필터" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="">전체 상태</option>{Object.entries(statusLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <small className="muted" aria-label="예약 동기화 상태" aria-live="polite">{lastSynced ? `최근 갱신 ${formatKstTime(lastSynced)} · 1분마다 확인` : '일정을 불러오는 중…'}</small>
      </div>
      {(syncError || resourceWarning) && <p role="alert" className="apt-warning">{syncError || resourceWarning}</p>}
      {selected && !items.some(item => item.id === selected.id) && <p role="status" className="apt-warning">선택한 예약이 현재 조회 기간에서 사라졌습니다. 다른 날짜로 이동했거나 조회 대상이 달라졌을 수 있습니다. 마지막으로 확인한 예약과 작성 중 입력을 유지합니다. 저장 전 최신 일정을 확인하세요.</p>}
      {error && <p role="alert" className="form-error apt-error">{error} <button type="button" onClick={() => { setError(''); void load(); }}>다시 불러오기</button></p>}
      <div className="apt-body">
        <section className="apt-main" aria-label="예약 달력">
          {view === 'day' && (
            <DayGrid
              day={day}
              items={filteredItems}
              staff={activeStaffFilter ? branchStaff.filter(row => row.id === activeStaffFilter) : branchStaff}
              customerName={customerName}
              selectedId={selectedId}
              now={now}
              canCreate={!readOnly}
              onSelect={(appointment) => void selectAppointment(appointment)}
              onEmptyClick={(staffId, minutes) => void startCreate({ staff_id: staffId, start_at: localInputAt(day, minutes) })}
              canMove={(appointment) => !readOnly && !busy && canEditAppointment(appointment.status)}
              onMove={(appointment, staffId, minutes) => void moveAppointment(appointment, { date: day, minutes, staffId })}
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
              canMove={(appointment) => !readOnly && !busy && canEditAppointment(appointment.status)}
              onMove={(appointment, date, minutes) => void moveAppointment(appointment, { date, minutes })}
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
      {branchDialog && <BranchManagerDialog api={api} organizationId={organizationId} onClose={() => { setBranchDialog(false); void load(); }} />}
      {waitlistDialog&&<WaitlistDialog api={api} organizationId={organizationId} customers={customers} staff={branchStaff} services={services} resources={resources.filter(row=>!row.branch_id||row.branch_id===activeBranchId)} serviceStaff={serviceStaff} readOnly={readOnly} onBooked={appointment=>{mutationRevision.current++;setItems(old=>mergeAppointments(old,[appointment]));setDay(kstDateKey(appointment.start_at));setWaitlistDialog(false)}} onClose={()=>setWaitlistDialog(false)}/>}
      {seriesDialog&&<AppointmentSeriesDialog api={api} organizationId={organizationId} customers={customers} staff={staffDirectory} services={services} resources={resources.filter(row=>!row.branch_id||row.branch_id===activeBranchId)} canManage={canManageResources} onClose={()=>setSeriesDialog(false)}/>}
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
