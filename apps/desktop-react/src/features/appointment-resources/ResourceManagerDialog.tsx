import { useCallback, useEffect, useMemo, useState } from 'react';
import { DataGrid, ErrorState, LoadingState, Modal, Select, confirm, notify, type Column } from '@business-assistant/react-ui';
import { resourceApi, type CallApi } from './api';
import { isDefiniteRejection, useOperationTracker } from './operationIds';
import { kindLabel, type AppointmentResource, type AppointmentServiceRow, type ResourceKind, type ResourceRequirement } from './schemas';
import './appointment-resources.css';

const columns: Column<AppointmentResource>[] = [
  { key: 'kind', header: '구분', width: 70, value: (row) => kindLabel[row.kind] },
  { key: 'name', header: '이름', width: 220, value: (row) => row.name },
  { key: 'state', header: '상태', width: 90, value: (row) => (row.is_active ? '사용 중' : '사용 중지') },
];

export interface ResourceManagerDialogProps {
  api: CallApi;
  organizationId: string;
  /** 읽기 전용(member)이면 목록·기준만 볼 수 있고 추가·변경·저장 버튼이 없다. */
  readOnly?: boolean;
  onClose: () => void;
}

type Quantities = { room: number; equipment: number };
const toQuantities = (requirements: ResourceRequirement[]): Quantities => ({
  room: requirements.find((item) => item.kind === 'room')?.quantity ?? 0,
  equipment: requirements.find((item) => item.kind === 'equipment')?.quantity ?? 0,
});
const toRequirements = (quantities: Quantities): ResourceRequirement[] => [
  ...(quantities.room ? [{ kind: 'room' as const, quantity: quantities.room }] : []),
  ...(quantities.equipment ? [{ kind: 'equipment' as const, quantity: quantities.equipment }] : []),
];

/** 예약 공간·장비 마스터와 서비스별 필수 자원 수량을 관리하는 대화상자(옛 AppointmentResourceDialog). */
export function ResourceManagerDialog({ api, organizationId, readOnly = false, onClose }: ResourceManagerDialogProps) {
  const [resources, setResources] = useState<AppointmentResource[]>([]);
  const [services, setServices] = useState<AppointmentServiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ResourceKind>('room');
  const [serviceId, setServiceId] = useState('');
  const [setup, setSetup] = useState<{ version: number; baseline: Quantities } | null>(null);
  const [quantities, setQuantities] = useState<Quantities>({ room: 0, equipment: 0 });
  const [busy, setBusy] = useState(false);
  const createOp = useOperationTracker();
  const toggleOp = useOperationTracker();
  const requirementOp = useOperationTracker();

  const requirementDirty = setup !== null && (quantities.room !== setup.baseline.room || quantities.equipment !== setup.baseline.equipment);
  const resourceDirty = name.trim() !== '';
  const selected = resources.find((item) => item.id === selectedId) ?? null;

  const loadRequirements = useCallback(async (id: string) => {
    setSetup(null);
    if (!id) { setQuantities({ room: 0, equipment: 0 }); return; }
    try {
      const result = await resourceApi.getRequirementSetup(api, organizationId, id);
      const baseline = toQuantities(result.requirements);
      setSetup({ version: result.resource_version, baseline });
      setQuantities(baseline);
      setError('');
    } catch { setError('서비스 자원 기준을 불러오지 못했습니다.'); }
  }, [api, organizationId]);

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    setLoadError('');
    try {
      const [resourceRows, serviceRows] = await Promise.all([resourceApi.listResources(api, organizationId), resourceApi.listServices(api, organizationId)]);
      setResources(resourceRows);
      setServices(serviceRows);
      setSelectedId((current) => (resourceRows.some((item) => item.id === current) ? current : null));
      return serviceRows;
    } catch { setLoadError('공간·장비 정보를 불러오지 못했습니다.'); return null; }
    finally { setLoading(false); }
  }, [api, organizationId]);

  useEffect(() => {
    let alive = true;
    void load(true).then((serviceRows) => {
      if (!alive || !serviceRows) return;
      const first = serviceRows[0]?.id ?? '';
      setServiceId(first);
      void loadRequirements(first);
    });
    return () => { alive = false; };
  }, [load, loadRequirements]);

  const changeService = async (next: string) => {
    if (requirementDirty && !await confirm({ title: '작성 중인 자원 기준', message: '저장하지 않은 서비스 자원 기준을 버릴까요?', confirmLabel: '버리기', tone: 'danger' })) return;
    requirementOp.reset();
    setServiceId(next);
    await loadRequirements(next);
  };

  const close = async () => {
    if ((resourceDirty || requirementDirty) && !await confirm({ title: '작성 중인 공간·장비', message: '저장하지 않은 입력을 버리고 닫을까요?', confirmLabel: '버리고 닫기', tone: 'danger' })) return;
    onClose();
  };

  async function addResource() {
    const trimmed = name.trim();
    if (!trimmed) { setError('공간 또는 장비 이름을 입력하세요.'); return; }
    setBusy(true);
    try {
      await resourceApi.createResource(api, organizationId, { name: trimmed, kind, operation_id: createOp.idFor(`${kind}:${trimmed}`) });
      createOp.reset(); setName(''); setError('');
      notify.success('공간·장비를 추가했습니다.');
      await load();
    } catch (failure) {
      if (isDefiniteRejection(failure)) createOp.reset();
      setError('공간·장비 추가에 실패했습니다. 입력은 유지됩니다.');
    } finally { setBusy(false); }
  }

  async function toggleResource() {
    if (!selected) return;
    const next = !selected.is_active;
    setBusy(true);
    try {
      await resourceApi.updateResource(api, organizationId, selected.id, {
        name: selected.name, is_active: next, expected_version: selected.version, operation_id: toggleOp.idFor(`${selected.id}:${selected.version}:${next}`),
      });
      toggleOp.reset(); setError('');
      await load();
    } catch (failure) {
      if (isDefiniteRejection(failure)) toggleOp.reset();
      setError('사용 상태 변경에 실패했습니다. 예약 사용 여부를 확인하세요.');
    } finally { setBusy(false); }
  }

  async function saveRequirements() {
    if (!setup || !serviceId) return;
    const requirements = toRequirements(quantities);
    setBusy(true);
    try {
      await resourceApi.saveRequirements(api, organizationId, serviceId, {
        requirements, expected_version: setup.version, operation_id: requirementOp.idFor(`${serviceId}:${setup.version}:${JSON.stringify(requirements)}`),
      });
      requirementOp.reset(); setError('');
      notify.success('서비스 자원 기준을 저장했습니다.');
      await loadRequirements(serviceId);
    } catch (failure) {
      if (isDefiniteRejection(failure)) requirementOp.reset();
      setError('서비스 자원 기준 저장에 실패했습니다. 입력은 유지됩니다.');
    } finally { setBusy(false); }
  }

  const serviceOptions = useMemo(() => services.map((item) => ({ value: item.id, label: item.name })), [services]);
  const setQuantity = (key: keyof Quantities, value: string) => setQuantities((current) => ({ ...current, [key]: Math.max(0, Math.min(10, Number.parseInt(value, 10) || 0)) }));

  return (
    <Modal title="예약 공간·장비" size="lg" onClose={() => void close()}>
      <div className="resource-manager">
        {loadError ? <ErrorState message={loadError} onRetry={() => void load(true)} /> : loading ? <LoadingState /> : (
          <>
            <DataGrid rows={resources} columns={columns} rowKey={(row) => row.id} selectedKey={selectedId} onSelect={(row) => setSelectedId(row.id)} ariaLabel="공간·장비 목록" emptyText="등록된 공간·장비가 없습니다." />
            {!readOnly && (
              <section className="resource-form" aria-label="공간·장비 추가">
                <label>이름<input value={name} placeholder="예: 관리실 1, 레이저 1" onChange={(event) => setName(event.currentTarget.value)} /></label>
                <label>구분<Select<ResourceKind> aria-label="구분" value={kind} onChange={setKind} options={[{ value: 'room', label: '공간' }, { value: 'equipment', label: '장비' }]} /></label>
                <button type="button" className="primary-button" disabled={busy} onClick={() => void addResource()}>자원 추가</button>
                <button type="button" disabled={busy || !selected} onClick={() => void toggleResource()}>{selected && !selected.is_active ? '다시 사용' : '사용 중지'}</button>
              </section>
            )}
            <section className="resource-requirements" aria-label="서비스별 필수 자원">
              <h3>서비스별 필수 자원</h3>
              {services.length === 0 ? <p className="muted">등록된 서비스가 없습니다.</p> : (
                <>
                  <label>서비스<Select aria-label="서비스" value={serviceId} onChange={(value) => void changeService(value)} options={serviceOptions} /></label>
                  <label>필요 공간 수<input type="number" min={0} max={10} aria-label="필요 공간 수" disabled={readOnly || !setup} value={quantities.room} onChange={(event) => setQuantity('room', event.currentTarget.value)} /></label>
                  <label>필요 장비 수<input type="number" min={0} max={10} aria-label="필요 장비 수" disabled={readOnly || !setup} value={quantities.equipment} onChange={(event) => setQuantity('equipment', event.currentTarget.value)} /></label>
                  {!readOnly && <button type="button" className="primary-button" disabled={busy || !setup || !requirementDirty} onClick={() => void saveRequirements()}>서비스 자원 기준 저장</button>}
                </>
              )}
            </section>
          </>
        )}
        {error && <p role="alert" className="form-error">{error}</p>}
      </div>
    </Modal>
  );
}
