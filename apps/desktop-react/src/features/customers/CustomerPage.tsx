import { useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { emptyCustomer, type Customer } from './types';
import { CustomerGrid } from './CustomerGrid';
import { CustomerForm } from './CustomerForm';
import { InsightsPanel } from './InsightsPanel';
import { ActivityPanel } from './activities/ActivityPanel';
import { PhotoPanel } from './photos/PhotoPanel';
import { confirmDiscard } from './changeGuard';
import './customers.css';

type Props = { api: ApiClient; organizationId: string; readOnly: boolean };

function loadErrorText(error: unknown): string {
  const status = (error as ApiError).status;
  if (status === 403) return '고객관리 권한이 없습니다.';
  if (status === 404) return '고객 정보를 찾을 수 없습니다.';
  return '고객 목록을 불러오지 못했습니다.';
}

const matches = (customer: Customer, query: string) => `${customer.name} ${customer.phone ?? ''} ${customer.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase());

/**
 * 고객관리: 위쪽은 목록(왼쪽, 크기 고정)과 선택 고객 상세(오른쪽),
 * 아래쪽은 업무 인사이트(왼쪽)와 선택 고객의 사진 갤러리(오른쪽).
 */
export function CustomerPage({ api, organizationId, readOnly }: Props) {
  const [rows, setRows] = useState<Customer[]>([]);
  const [selected, setSelected] = useState<Customer | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('active');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api.listCustomers(organizationId);
      setRows(result);
      setSelected((current) => result.find((row) => row.id === current?.id) ?? null);
    } catch (e) {
      setError(loadErrorText(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, [organizationId]);

  const filtered = useMemo(
    () => rows.filter((customer) => (status === 'all' || customer.status === status) && matches(customer, query)),
    [rows, query, status],
  );
  const input = selected ? { ...selected } : emptyCustomer();

  const changeCustomer = async (next: Customer | null) => {
    if (!await confirmDiscard(dirty)) return;
    setSelected(next);
    setDirty(false);
  };
  /** 인사이트에서 고르면 목록에서도 보이도록 상태 필터를 넓힌다. */
  const pickFromInsight = async (customer: Customer) => {
    if (status !== 'all' && customer.status !== status) setStatus('all');
    await changeCustomer(customer);
  };

  async function save(value: ReturnType<typeof emptyCustomer>) {
    try {
      const saved = selected ? await api.updateCustomer(organizationId, selected.id, value) : await api.createCustomer(organizationId, value);
      setRows((old) => (old.some((row) => row.id === saved.id) ? old.map((row) => (row.id === saved.id ? saved : row)) : [saved, ...old]));
      setSelected(saved);
    } catch {
      setError('저장하지 못했습니다. 작성 내용은 유지됩니다.');
    }
  }

  async function archive() {
    if (!selected) return;
    try {
      const archived = await api.archiveCustomer(organizationId, selected.id);
      setRows((old) => old.map((row) => (row.id === archived.id ? archived : row)));
      setSelected(archived);
    } catch {
      setError('고객 보관에 실패했습니다. 다시 시도해 주세요.');
    }
  }

  return (
    <section className="cx-page">
      <div className="page-toolbar">
        <div><h1>고객관리</h1><p className="muted">고객 프로필과 상담 정보를 관리합니다.</p></div>
        {!readOnly && <button className="primary-button" onClick={() => void changeCustomer(null)}>새 고객</button>}
      </div>
      <div className="cx-board">
        <section className="cx-panel cx-list" aria-label="고객 목록 영역">
          <div className="cx-controls">
            <input aria-label="고객 검색" placeholder="이름, 연락처, 태그 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
            <select aria-label="상태 필터" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="active">활성 고객</option>
              <option value="archived">보관 고객</option>
              <option value="all">전체</option>
            </select>
            <span className="muted cx-count">{loading ? '' : `${filtered.length}명`}</span>
          </div>
          {error && <div role="alert" className="form-error cx-error">{error} <button onClick={() => void load()}>다시 시도</button></div>}
          <div className="cx-grid-slot">
            <CustomerGrid customers={filtered} selectedId={selected?.id} loading={loading} onSelect={changeCustomer} />
          </div>
        </section>

        <aside className="cx-panel cx-detail" aria-label="고객 상세">
          <h2>{selected ? selected.name : '새 고객 등록'}</h2>
          <div className="cx-detail__scroll">
            <CustomerForm value={input} readOnly={readOnly} onDirtyChange={setDirty} onSave={save} onArchive={selected && !readOnly ? archive : undefined} />
            {selected
              ? <ActivityPanel api={api} organizationId={organizationId} customerId={selected.id} readOnly={readOnly} />
              : <p className="muted cx-hint">고객을 저장하면 활동 타임라인과 사진을 기록할 수 있습니다.</p>}
          </div>
        </aside>

        <section className="cx-panel cx-insights-slot" aria-label="고객 인사이트 영역">
          <InsightsPanel customers={rows} selectedId={selected?.id} onSelect={(customer) => void pickFromInsight(customer)} />
        </section>

        {selected
          ? <PhotoPanel api={api} organizationId={organizationId} customerId={selected.id} readOnly={readOnly} />
          : (
            <section className="cx-panel cx-photos" aria-label="고객 사진">
              <h3 className="cx-photos__title">이 고객의 사진</h3>
              <p className="cx-photos__empty muted">목록에서 고객을 선택하면 사진이 날짜별로 정리되어 표시됩니다.</p>
            </section>
          )}
      </div>
    </section>
  );
}
