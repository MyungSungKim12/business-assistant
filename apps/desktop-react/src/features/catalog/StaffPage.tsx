import { useCallback, useEffect, useState } from 'react';
import { DataGrid, ErrorState, LoadingState, notify, type Column } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { StaffAvailabilityDialog } from '../appointment-resources/StaffAvailabilityDialog';
import { resourceApi } from '../appointment-resources/api';
import type { AppointmentStaffRow } from '../appointment-resources/schemas';
import './catalog.css';
import { StaffProfileDialog } from './StaffProfileDialog';
import { useDraftProtection } from '../../app/DraftBoundary';

const columns: Column<AppointmentStaffRow>[] = [
  { key: 'name', header: '직원', width: 220, value: (row) => row.name },
  { key: 'active', header: '예약 담당', width: 80, value: (row) => (row.is_active ? '사용' : '중지') },
];

export interface StaffPageProps { api: ApiClient; organizationId: string; readOnly: boolean }

/** 직원(예약 담당자) 목록, 추가, 주간 근무시간·휴무 관리. 추가·변경은 관리자만. 수당·성과 배분은 아직 없다. */
export function StaffPage({ api, organizationId, readOnly }: StaffPageProps) {
  const [rows, setRows] = useState<AppointmentStaffRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<AppointmentStaffRow | null>(null);
  const [editing,setEditing]=useState<AppointmentStaffRow|null>(null);
  useDraftProtection(Boolean(name.trim()),busy);

  const load = useCallback(async () => {
    setLoading(true); setLoadError('');
    try { setRows(await resourceApi.listStaff(api, organizationId)); }
    catch { setLoadError('직원 목록을 불러오지 못했습니다.'); }
    finally { setLoading(false); }
  }, [api, organizationId]);
  useEffect(() => { void load(); }, [load]);

  async function add() {
    if(busy||readOnly)return;
    const trimmed = name.trim();
    if (!trimmed) { setError('직원 이름을 입력하세요.'); return; }
    setBusy(true);
    try {
      const created = await resourceApi.createStaff(api, organizationId, { name: trimmed });
      setRows((current) => [...current, created]); setName(''); setError(''); setSelectedId(created.id);
      notify.success('직원을 추가했습니다.');
    } catch { setError('직원 추가에 실패했습니다. 입력은 유지됩니다.'); }
    finally { setBusy(false); }
  }

  const selected = rows.find((row) => row.id === selectedId) ?? null;
  return (
    <section className="catalog-page staff-page">
      <div className="page-toolbar">
        <div><h1>직원관리</h1><p className="muted">예약 담당자와 근무 일정을 관리합니다.</p></div>
        <button type="button" disabled={!selected} onClick={() => selected && setOpen(selected)}>근무시간·휴무</button>
        {!readOnly&&<button type="button" disabled={!selected||busy} onClick={()=>selected&&setEditing(selected)}>직원 정보 수정</button>}
      </div>
      {loadError ? <ErrorState message={loadError} onRetry={() => void load()} /> : loading ? <LoadingState /> : (
        <DataGrid rows={rows} columns={columns} rowKey={(row) => row.id} selectedKey={selectedId} onSelect={(row) => setSelectedId(row.id)} onActivate={setOpen} ariaLabel="직원 목록" storageKey="staff-grid" emptyText="등록된 직원이 없습니다." />
      )}
      {!readOnly && (
        <div className="inline-form" aria-label="직원 추가">
          <label>새 직원 이름<input value={name} onChange={(event) => setName(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') void add(); }} /></label>
          <button type="button" className="primary-button" disabled={busy} onClick={() => void add()}>직원 추가</button>
        </div>
      )}
      {error && <p role="alert" className="form-error">{error}</p>}
      {open && <StaffAvailabilityDialog api={api} organizationId={organizationId} staff={open} readOnly={readOnly} onClose={() => setOpen(null)} />}
      {editing&&<StaffProfileDialog key={editing.id} api={api} organizationId={organizationId} staff={editing} onSaved={saved=>{setRows(old=>old.map(row=>row.id===saved.id?saved:row));setEditing(null);void load();}} onClose={()=>{setEditing(null);void load();}}/>}
    </section>
  );
}
