import { useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { Customer } from '../../api/schemas';
import { matchesCustomer, searchCustomers } from '../customers/customerSearch';

/** 선택한 고객은 검색 결과 밖이어도 유지한다. 목록 밖 고객은 기존 서버 검색으로 찾는다. */
export function AppointmentCustomerPicker({ api, organizationId, customers, value, disabled = false, onChange }: {
  api: ApiClient; organizationId: string; customers: Customer[]; value: string; disabled?: boolean;
  onChange: (id: string, customer?: Customer) => void;
}) {
  const [query, setQuery] = useState('');
  const [remote, setRemote] = useState<Customer[]>([]);
  const [selected, setSelected] = useState<Customer | undefined>(() => customers.find(row => row.id === value));
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (!query.trim() || disabled) { setRemote([]); setStatus(''); return; }
    let alive = true;
    setStatus('검색 중…');
    const timer = setTimeout(() => {
      void searchCustomers(api, organizationId, { q: query, status: 'active', sort: 'name', limit: 50 })
        .then(page => { if (alive) { if (!Array.isArray(page.items)) throw new Error('Invalid customer search'); setRemote(page.items); setStatus(page.next_cursor ? '검색 결과 50명입니다. 이름이나 연락처를 더 입력하세요.' : `${page.total}명 검색됨`); } })
        .catch(() => { if (alive) { setRemote([]); setStatus('서버 검색에 실패했습니다. 현재 불러온 고객만 표시합니다. 검색어를 바꿔 다시 시도하세요.'); } });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [api, organizationId, query, disabled]);
  const options = useMemo(() => {
    const rows = new Map(customers.filter(row => row.id === value || matchesCustomer(row, query)).map(row => [row.id, row]));
    for (const row of remote) if (row.status === 'active') rows.set(row.id, row);
    const current = customers.find(row => row.id === value) ?? selected;
    if (current && current.id === value) rows.set(current.id, current);
    return [...rows.values()];
  }, [customers, query, remote, selected, value]);
  return <div className="apt-customer-picker">
    {!disabled && <label>고객 찾기<input aria-label="예약 고객 검색" type="search" maxLength={120} placeholder="이름 또는 연락처 검색" value={query} onChange={event => { setRemote([]); setQuery(event.currentTarget.value); }} /></label>}
    <label>고객<select required disabled={disabled} value={value} onChange={event => { const row = options.find(item => item.id === event.currentTarget.value); setSelected(row); onChange(event.currentTarget.value, row); }}><option value="">선택</option>{options.map(row => <option key={row.id} value={row.id}>{row.name}{row.phone ? ` · ${row.phone}` : ''}</option>)}</select></label>
    {status && <small className="muted" role="status">{status}</small>}
  </div>;
}
