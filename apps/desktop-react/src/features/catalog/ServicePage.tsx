import { useCallback, useEffect, useMemo, useState } from 'react';
import { DataGrid, ErrorState, LoadingState, Select, confirm, notify, type Column } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { ResourceManagerDialog } from '../appointment-resources/ResourceManagerDialog';
import { ServiceConsumablesDialog } from './ServiceConsumablesDialog';
import { resourceApi } from '../appointment-resources/api';
import { isDefiniteRejection, useOperationTracker } from '../appointment-resources/operationIds';
import type { AppointmentServiceRow } from '../appointment-resources/schemas';
import { emptyServiceForm, filterServices, parseServiceForm, serviceCategories, serviceToForm, type ServiceForm, type ServiceStatusFilter } from './serviceForm';
import { won } from './schemas';
import './catalog.css';

const columns: Column<AppointmentServiceRow>[] = [
  { key: 'name', header: '서비스', width: 180, value: (row) => row.name },
  { key: 'category', header: '카테고리', width: 110, value: (row) => row.category, render: (row) => row.category || '-' },
  { key: 'price', header: '가격', width: 100, value: (row) => row.price_krw, render: (row) => won(row.price_krw) },
  { key: 'duration', header: '소요(분)', width: 80, value: (row) => row.duration_minutes },
  { key: 'buffer', header: '여유(분)', width: 80, value: (row) => row.buffer_minutes },
  { key: 'active', header: '상태', width: 70, value: (row) => (row.is_active ? '사용' : '중지') },
];

export interface ServicePageProps { api: ApiClient; organizationId: string; readOnly: boolean }

/** 예약 서비스(가격·카테고리·소요·여유 시간) 목록과 추가·수정·비활성, 공간·장비 및 서비스별 필수 자원 기준 관리. 쓰기는 관리자만. */
export function ServicePage({ api, organizationId, readOnly }: ServicePageProps) {
  const [rows, setRows] = useState<AppointmentServiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<ServiceStatusFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<ServiceForm>(emptyServiceForm);
  const [baseline, setBaseline] = useState(() => JSON.stringify(emptyServiceForm()));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [consumablesOpen, setConsumablesOpen] = useState(false);
  const detailOp = useOperationTracker();
  const updateOp = useOperationTracker();

  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const dirty = JSON.stringify(form) !== baseline;
  const editable = !readOnly && !busy;
  const visible = useMemo(() => filterServices(rows, { query, status }), [rows, query, status]);
  const categories = useMemo(() => serviceCategories(rows), [rows]);

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    setLoadError('');
    try { setRows(await resourceApi.listServiceDetails(api, organizationId)); }
    catch { setLoadError('서비스 목록을 불러오지 못했습니다.'); }
    finally { setLoading(false); }
  }, [api, organizationId]);
  useEffect(() => { void load(true); }, [load]);

  const fill = (next: ServiceForm) => { setForm(next); setBaseline(JSON.stringify(next)); setError(''); };
  /** 변경이 없으면 바로, 있으면 확인을 거친 뒤 실행한다. */
  const guarded = (action: () => void) => {
    if (!dirty) { action(); return; }
    void confirm({ title: '작성 중인 서비스 변경', message: '저장하지 않은 내용을 버릴까요?', confirmLabel: '버리기', tone: 'danger' }).then((ok) => { if (ok) action(); });
  };
  const select = (row: AppointmentServiceRow) => { if (row.id !== selectedId) guarded(() => { setSelectedId(row.id); fill(serviceToForm(row)); }); };
  const startNew = () => guarded(() => { setSelectedId(null); fill(emptyServiceForm()); });
  const upsert = (saved: AppointmentServiceRow) => setRows((current) => (current.some((row) => row.id === saved.id) ? current.map((row) => (row.id === saved.id ? saved : row)) : [...current, saved]));
  const set = <K extends keyof ServiceForm>(key: K, value: ServiceForm[K]) => setForm((current) => ({ ...current, [key]: value }));

  function rejected(fallback: string, caught: unknown, tracker: { reset(): void }) {
    const code = (caught as { status?: number }).status;
    if (isDefiniteRejection(caught)) tracker.reset();
    setError(code === 409 ? '다른 변경과 충돌했습니다. 목록을 새로고침한 뒤 다시 확인하세요.'
      : isDefiniteRejection(caught) ? fallback : '결과를 확인하지 못했습니다. 같은 내용으로 다시 시도하면 중복 없이 처리됩니다.');
  }

  /** 새 서비스: 생성 RPC에는 가격·카테고리가 없어 생성 직후 수정 요청으로 이어서 저장한다. */
  async function add(values: Exclude<ReturnType<typeof parseServiceForm>, string>) {
    setBusy(true);
    let created: AppointmentServiceRow;
    try {
      created = await resourceApi.createService(api, organizationId, { name: values.name, duration_minutes: values.duration_minutes, buffer_minutes: values.buffer_minutes });
    } catch { setError('서비스 추가에 실패했습니다. 입력은 유지됩니다.'); setBusy(false); return; }
    upsert(created);
    try {
      let saved = created;
      if (values.price_krw > 0 || values.category !== '') {
        saved = await resourceApi.updateService(api, organizationId, created.id, { ...values, expected_version: created.service_version, operation_id: detailOp.idFor(JSON.stringify([created.id, values])) });
        detailOp.reset();
      }
      upsert(saved); setSelectedId(saved.id); fill(serviceToForm(saved)); notify.success('서비스를 추가했습니다.');
    } catch (caught) {
      setSelectedId(created.id); fill(serviceToForm(created));
      rejected('서비스는 추가했지만 가격·카테고리를 저장하지 못했습니다. 목록에서 선택해 다시 저장하세요.', caught, detailOp);
    } finally { setBusy(false); }
  }

  async function update(target: AppointmentServiceRow, values: Exclude<ReturnType<typeof parseServiceForm>, string>) {
    if (target.is_active && !values.is_active) {
      const ok = await confirm({ title: '서비스 비활성화', message: `'${target.name}' 서비스를 중지합니다. 새 예약에서는 선택할 수 없고, 이미 잡힌 예약은 그대로 유지됩니다.`, confirmLabel: '중지', tone: 'danger' });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const saved = await resourceApi.updateService(api, organizationId, target.id, { ...values, expected_version: target.service_version, operation_id: updateOp.idFor(JSON.stringify([target.id, target.service_version, values])) });
      updateOp.reset(); upsert(saved); fill(serviceToForm(saved)); notify.success('서비스를 저장했습니다.');
    } catch (caught) { rejected('서비스를 저장하지 못했습니다. 입력 내용은 유지됩니다.', caught, updateOp); }
    finally { setBusy(false); }
  }

  async function save() {
    const values = parseServiceForm(form);
    if (typeof values === 'string') { setError(values); return; }
    setError('');
    if (selected) await update(selected, values);
    else await add(values);
  }

  return (
    <section className="catalog-page service-page">
      <div className="page-toolbar">
        <div><h1>예약 서비스</h1><p className="muted">서비스별 가격·카테고리와 소요 시간, 필수 공간·장비를 관리합니다.</p></div>
        <div className="catalog-toolbar-actions">
          {!readOnly && <button type="button" className="primary-button" disabled={busy} onClick={startNew}>새 서비스</button>}
          <button type="button" onClick={() => setResourcesOpen(true)}>공간·장비 관리</button>
        </div>
      </div>
      {loadError ? <ErrorState message={loadError} onRetry={() => void load(true)} /> : loading ? <LoadingState /> : (
        <div className="catalog-layout">
          <section className="catalog-list">
            <div className="list-controls">
              <input aria-label="서비스 검색" placeholder="서비스, 카테고리 검색" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
              <Select<ServiceStatusFilter> aria-label="서비스 상태 필터" value={status} onChange={setStatus} options={[{ value: 'all', label: '전체' }, { value: 'active', label: '사용' }, { value: 'inactive', label: '중지' }]} />
            </div>
            <DataGrid rows={visible} columns={columns} rowKey={(row) => row.id} selectedKey={selectedId} onSelect={select} ariaLabel="서비스 목록" storageKey="service-grid" emptyText="등록된 서비스가 없습니다." />
          </section>
          <aside className="catalog-detail editor-panel">
            <h2>{selected ? '서비스 수정' : '서비스 추가'}</h2>
            <div className="catalog-form" aria-label={selected ? '서비스 수정' : '서비스 추가'}>
              <label className="full">서비스명<input value={form.name} disabled={!editable} onChange={(event) => set('name', event.currentTarget.value)} /></label>
              <label>카테고리<input list="service-categories" value={form.category} disabled={!editable} onChange={(event) => set('category', event.currentTarget.value)} /></label>
              <label>가격(원)<input inputMode="numeric" value={form.price} disabled={!editable} onChange={(event) => set('price', event.currentTarget.value)} /></label>
              <label>소요 시간(분)<input type="number" min={5} max={480} step={5} value={form.duration} disabled={!editable} onChange={(event) => set('duration', event.currentTarget.value)} /></label>
              <label>여유 시간(분)<input type="number" min={0} max={120} step={5} value={form.buffer} disabled={!editable} onChange={(event) => set('buffer', event.currentTarget.value)} /></label>
              {selected && <label className="check full"><input type="checkbox" checked={form.is_active} disabled={!editable} onChange={(event) => set('is_active', event.currentTarget.checked)} />예약에 사용 (끄면 새 예약에서 선택할 수 없음)</label>}
              <datalist id="service-categories">{categories.map((category) => <option key={category} value={category} />)}</datalist>
              <div className="form-actions">
                {!readOnly && <button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>{selected ? '변경 저장' : '서비스 추가'}</button>}
                {selected && <><button type="button" disabled={busy} onClick={() => setResourcesOpen(true)}>필수 자원 기준</button><button type="button" disabled={busy} onClick={() => setConsumablesOpen(true)}>시술 소모품 기준</button></>}
              </div>
            </div>
            {error && <p role="alert" className="form-error">{error}</p>}
          </aside>
        </div>
      )}
      {resourcesOpen && <ResourceManagerDialog api={api} organizationId={organizationId} readOnly={readOnly} onClose={() => { setResourcesOpen(false); void load(); }} />}
      {consumablesOpen && selected && <ServiceConsumablesDialog api={api} organizationId={organizationId} serviceId={selected.id} readOnly={readOnly} onClose={() => setConsumablesOpen(false)} />}
    </section>
  );
}
