import { useCallback, useEffect, useState } from 'react';
import { DataGrid, ErrorState, LoadingState, notify, type Column } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { ResourceManagerDialog } from '../appointment-resources/ResourceManagerDialog';
import { resourceApi } from '../appointment-resources/api';
import type { AppointmentServiceRow } from '../appointment-resources/schemas';
import './catalog.css';

const columns: Column<AppointmentServiceRow>[] = [
  { key: 'name', header: '서비스', width: 200, value: (row) => row.name },
  { key: 'duration', header: '소요(분)', width: 80, value: (row) => row.duration_minutes },
  { key: 'buffer', header: '여유(분)', width: 80, value: (row) => row.buffer_minutes },
  { key: 'active', header: '상태', width: 80, value: (row) => (row.is_active ? '사용' : '중지') },
];

export interface ServicePageProps { api: ApiClient; organizationId: string; readOnly: boolean }

/** 예약 서비스(소요·여유 시간) 목록과 추가, 공간·장비 및 서비스별 필수 자원 기준 관리. 추가·변경은 관리자만. */
export function ServicePage({ api, organizationId, readOnly }: ServicePageProps) {
  const [rows, setRows] = useState<AppointmentServiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState({ name: '', duration: '60', buffer: '10' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [resourcesOpen, setResourcesOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setLoadError('');
    try { setRows(await resourceApi.listServices(api, organizationId)); }
    catch { setLoadError('서비스 목록을 불러오지 못했습니다.'); }
    finally { setLoading(false); }
  }, [api, organizationId]);
  useEffect(() => { void load(); }, [load]);

  async function add() {
    const name = form.name.trim(), duration = Number(form.duration), buffer = Number(form.buffer);
    if (!name) { setError('서비스명을 입력하세요.'); return; }
    if (!Number.isInteger(duration) || duration < 5 || duration > 480) { setError('소요 시간은 5~480분이어야 합니다.'); return; }
    if (!Number.isInteger(buffer) || buffer < 0 || buffer > 120) { setError('여유 시간은 0~120분이어야 합니다.'); return; }
    setBusy(true);
    try {
      const created = await resourceApi.createService(api, organizationId, { name, duration_minutes: duration, buffer_minutes: buffer });
      setRows((current) => [...current, created]); setForm({ ...form, name: '' }); setError('');
      notify.success('서비스를 추가했습니다.');
    } catch { setError('서비스 추가에 실패했습니다. 입력은 유지됩니다.'); }
    finally { setBusy(false); }
  }

  return (
    <section className="catalog-page service-page">
      <div className="page-toolbar">
        <div><h1>예약 서비스</h1><p className="muted">서비스별 소요 시간과 필수 공간·장비를 관리합니다.</p></div>
        <button type="button" onClick={() => setResourcesOpen(true)}>공간·장비 관리</button>
      </div>
      {loadError ? <ErrorState message={loadError} onRetry={() => void load()} /> : loading ? <LoadingState /> : (
        <DataGrid rows={rows} columns={columns} rowKey={(row) => row.id} ariaLabel="서비스 목록" storageKey="service-grid" emptyText="등록된 서비스가 없습니다." />
      )}
      {!readOnly && (
        <div className="inline-form" aria-label="서비스 추가">
          <label>서비스명<input value={form.name} onChange={(event) => setForm({ ...form, name: event.currentTarget.value })} /></label>
          <label>소요 시간(분)<input type="number" min={5} max={480} step={5} value={form.duration} onChange={(event) => setForm({ ...form, duration: event.currentTarget.value })} /></label>
          <label>여유 시간(분)<input type="number" min={0} max={120} step={5} value={form.buffer} onChange={(event) => setForm({ ...form, buffer: event.currentTarget.value })} /></label>
          <button type="button" className="primary-button" disabled={busy} onClick={() => void add()}>서비스 추가</button>
        </div>
      )}
      {error && <p role="alert" className="form-error">{error}</p>}
      {resourcesOpen && <ResourceManagerDialog api={api} organizationId={organizationId} readOnly={readOnly} onClose={() => { setResourcesOpen(false); void load(); }} />}
    </section>
  );
}
