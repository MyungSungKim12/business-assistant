import { useEffect, useState } from 'react';
import { confirm, ErrorState, LoadingState, Modal, notify } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { resourceApi } from '../appointment-resources/api';

interface StaffRow { id: string; name: string; is_active: boolean }

/** 서비스를 맡을 수 있는 직원을 고른다. 아무도 고르지 않으면 모든 직원이 가능하다(예약은 지정된 직원만 받는다). */
export function ServiceStaffDialog({ api, organizationId, serviceId, serviceName, readOnly, onClose, onSaved }: {
  api: ApiClient; organizationId: string; serviceId: string; serviceName: string; readOnly: boolean; onClose: () => void; onSaved?: () => void;
}) {
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [baseline, setBaseline] = useState('[]');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true); setError('');
    try {
      const [rows, current] = await Promise.all([resourceApi.listStaff(api, organizationId), resourceApi.getServiceStaff(api, organizationId, serviceId)]);
      setStaff(rows.map((row) => ({ id: row.id, name: row.name, is_active: row.is_active })));
      const ids = [...current.staff_ids].sort();
      setSelected(ids); setBaseline(JSON.stringify(ids));
    } catch { setError('담당 가능 직원을 불러오지 못했습니다.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [api, organizationId, serviceId]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = JSON.stringify([...selected].sort()) !== baseline;
  async function close() {
    if (busy) return;
    if (dirty && !await confirm({ title: '수정 중인 담당 직원', message: '저장하지 않은 내용을 버릴까요?', confirmLabel: '버리기', tone: 'danger' })) return;
    onClose();
  }
  async function save() {
    setBusy(true); setError('');
    try {
      await resourceApi.saveServiceStaff(api, organizationId, serviceId, [...selected].sort());
      notify.success(selected.length === 0 ? '담당 직원 제한을 풀었습니다. 모든 직원이 가능합니다.' : '담당 가능 직원을 저장했습니다.');
      onSaved?.();
      onClose();
    } catch { setError('저장하지 못했습니다. 선택은 유지되며 다시 시도할 수 있습니다.'); }
    finally { setBusy(false); }
  }
  const toggle = (id: string) => setSelected((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));
  // 목록에서 사라졌거나 비활성인 직원이 지정되어 있어도 해제할 수 있게 남겨 둔다.
  const known = new Set(staff.map((row) => row.id));
  const orphans = selected.filter((id) => !known.has(id));

  return <Modal title={`담당 가능 직원 · ${serviceName}`} onClose={() => void close()}>
    <div className="catalog-form">
      <p className="muted">이 서비스를 맡을 수 있는 직원을 고르세요. <strong>아무도 고르지 않으면 모든 직원이 가능합니다.</strong> 이미 만들어진 예약에는 영향이 없습니다.</p>
      {loading ? <LoadingState /> : error && staff.length === 0 ? <ErrorState message={error} onRetry={() => void load()} /> : <>
        {staff.length === 0 && <p className="empty-state">등록된 직원이 없습니다. 직원 메뉴에서 먼저 등록하세요.</p>}
        <ul className="catalog-checklist" aria-label="담당 가능 직원">
          {staff.map((row) => <li key={row.id}><label>
            <input type="checkbox" checked={selected.includes(row.id)} disabled={readOnly || busy} onChange={() => toggle(row.id)} /> {row.name}{row.is_active ? '' : ' (비활성)'}
          </label></li>)}
          {orphans.map((id) => <li key={id}><label><input type="checkbox" checked disabled={readOnly || busy} onChange={() => toggle(id)} /> (목록에 없는 직원)</label></li>)}
        </ul>
        <p className="muted" role="status">{selected.length === 0 ? '현재: 모든 직원이 가능합니다.' : `현재: ${selected.length}명만 가능합니다.`}</p>
        {!readOnly && <div className="form-actions"><button type="button" className="primary-button" disabled={busy || loading || !dirty} onClick={() => void save()}>{busy ? '저장 중…' : '저장'}</button></div>}
      </>}
      {error && staff.length > 0 && <p role="alert" className="form-error">{error}</p>}
    </div>
  </Modal>;
}
