import { useEffect, useState } from 'react';
import { ErrorState, LoadingState, Modal, notify } from '@business-assistant/react-ui';
import { resourceApi, type CallApi } from './api';
import { useOperationTracker } from './operationIds';
import type { AppointmentResource, AppointmentStaffRow } from './schemas';

type Branch = { id: string; name: string; code: string; timezone_name: string; is_primary: boolean; is_active: boolean; version: number; organization_id: string };
export function BranchManagerDialog({ api, organizationId, onClose }: { api: CallApi; organizationId: string; onClose: () => void }) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [staff, setStaff] = useState<AppointmentStaffRow[]>([]);
  const [resources, setResources] = useState<AppointmentResource[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [error,setError]=useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const createOperation = useOperationTracker();
  const resourceOperations = useOperationTracker();
  const load = async () => {
    setLoading(true); setFailed(false);
    setError('');
    try {
      const [branchRows, staffRows, resourceRows] = await Promise.all([resourceApi.listBranches(api, organizationId), resourceApi.listStaff(api, organizationId), resourceApi.listResources(api, organizationId)]);
      setBranches(branchRows); setStaff(staffRows); setResources(resourceRows);
    } catch { setFailed(true); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [api, organizationId]);
  async function addBranch() {
    const branchCode = code.trim().toUpperCase(), branchName = name.trim();
    if (!/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(branchCode) || !branchName) return;
    setBusy(true);
    try {
      const created = await resourceApi.createBranch(api, organizationId, { code: branchCode, name: branchName, timezone_name: 'Asia/Seoul', operation_id: createOperation.idFor(`${branchCode}:${branchName}`) });
      createOperation.reset(); setBranches(rows => [...rows, created]); setCode(''); setName(''); notify.success('지점을 추가했습니다.');
    } catch { setError('지점을 추가하지 못했습니다. 코드가 이미 있는지 확인한 뒤 다시 시도해 주세요.'); }
    finally { setBusy(false); }
  }
  async function moveStaff(row: AppointmentStaffRow, branchId: string) {
    if (!row.profile_version || row.branch_id === branchId) return;
    setBusy(true);
    try { const saved = await resourceApi.assignStaffBranch(api, organizationId, row.id, { branch_id: branchId, expected_version: row.profile_version }); setStaff(rows => rows.map(item => item.id === saved.id ? saved : item)); notify.success('담당자 지점을 변경했습니다.'); }
    catch { notify.error('담당자 지점을 변경하지 못했습니다. 예정된 예약이 있으면 먼저 재배정해 주세요.'); }
    finally { setBusy(false); }
  }
  async function moveResource(row: AppointmentResource, branchId: string) {
    if (row.branch_id === branchId) return;
    setBusy(true);
    try {
      const operation = resourceOperations.idFor(`${row.id}:${row.version}:${branchId}`);
      const saved = await resourceApi.assignResourceBranch(api, organizationId, row.id, { branch_id: branchId, expected_version: row.version, operation_id: operation });
      resourceOperations.reset(); setResources(rows => rows.map(item => item.id === saved.id ? saved : item)); notify.success('공간·장비 지점을 변경했습니다.');
    } catch { notify.error('공간·장비 지점을 변경하지 못했습니다. 예정된 예약이 있으면 먼저 재배정해 주세요.'); }
    finally { setBusy(false); }
  }
  const options = branches.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>);
  return <Modal title="지점 관리" size="lg" onClose={onClose}>
    {loading ? <LoadingState /> : failed && branches.length === 0 ? <ErrorState message="지점 정보를 불러오지 못했습니다." onRetry={() => void load()} /> : <div className="branch-manager">
      <form className="resource-form" onSubmit={event => { event.preventDefault(); void addBranch(); }}>
        <label>지점 코드<input aria-label="지점 코드" value={code} placeholder="예: BR-02" maxLength={20} onChange={event => setCode(event.currentTarget.value.toUpperCase())} /></label>
        <label>지점명<input aria-label="지점명" value={name} placeholder="예: 강남점" maxLength={100} onChange={event => setName(event.currentTarget.value)} /></label>
        <button className="primary-button" type="submit" disabled={busy || !code.trim() || !name.trim()}>지점 추가</button>
      </form>
      <h3>담당자 지점</h3>
      <div className="branch-manager-list">{staff.filter(row => row.is_active).map(row => <label key={row.id}>{row.name}<select aria-label={`${row.name} 지점`} disabled={busy || !row.profile_version} value={row.branch_id ?? branches.find(item => item.is_primary)?.id ?? ''} onChange={event => void moveStaff(row, event.currentTarget.value)}>{options}</select></label>)}</div>
      <h3>공간·장비 지점</h3>
      <div className="branch-manager-list">{resources.filter(row => row.is_active).map(row => <label key={row.id}>{row.name}<select aria-label={`${row.name} 지점`} disabled={busy} value={row.branch_id ?? branches.find(item => item.is_primary)?.id ?? ''} onChange={event => void moveResource(row, event.currentTarget.value)}>{options}</select></label>)}</div>
      {error&&<p role="alert" className="form-error">{error}</p>}
      {branches.length === 0 && <p role="alert">활성 지점이 없습니다.</p>}
    </div>}
  </Modal>;
}
