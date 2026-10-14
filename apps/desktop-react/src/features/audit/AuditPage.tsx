import { useEffect, useState, type FormEvent } from 'react';
import type { ApiClient } from '../../api/client';
import type { AuditEvent } from '../../api/schemas';

const PAGE_SIZE = 50;
const formatTime = (value: string) => new Date(value).toLocaleString('ko-KR');

export function AuditPage({ api, organizationId }: { api: ApiClient; organizationId: string }) {
  const [fromInput, setFromInput] = useState('');
  const [toInput, setToInput] = useState('');
  const [actionInput, setActionInput] = useState('');
  const [filters, setFilters] = useState({ from: '', to: '', action: '' });
  const [trail, setTrail] = useState<{ organizationId: string; cursors: Array<string | undefined> }>({ organizationId, cursors: [undefined] });
  const [items, setItems] = useState<AuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadedOrganizationId, setLoadedOrganizationId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const cursors = trail.organizationId === organizationId ? trail.cursors : [undefined];
  const pageIndex = cursors.length - 1;
  const cursor = cursors[pageIndex];
  const visibleItems = loadedOrganizationId === organizationId ? items : [];
  const pageIsCurrent = loadedOrganizationId === organizationId;

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError('');
    const query = {
      ...(filters.from ? { from: `${filters.from}T00:00:00.000+09:00` } : {}),
      ...(filters.to ? { to: `${filters.to}T23:59:59.999+09:00` } : {}),
      ...(filters.action ? { action: filters.action } : {}),
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    };
    void api.listAuditEvents(organizationId, query).then((result) => {
      if (!current) return;
      setItems(result.items);
      setNextCursor(result.next_cursor);
      setLoadedOrganizationId(organizationId);
    }).catch(() => {
      if (!current) return;
      setItems([]);
      setNextCursor(null);
      setLoadedOrganizationId(organizationId);
      setError('감사 로그를 불러오지 못했습니다. 연결과 조회 권한을 확인한 뒤 다시 시도하세요.');
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [api, organizationId, filters, cursor, retry]);

  const applyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFilters({ from: fromInput, to: toInput, action: actionInput.trim() });
    setTrail({ organizationId, cursors: [undefined] });
  };

  const auditTable = (rows: AuditEvent[]) => (
    <div className="data-surface">
      <table>
        <thead><tr><th>일시</th><th>작업</th><th>대상</th><th>행위자</th><th>출처</th><th>IP</th><th>상세</th></tr></thead>
        <tbody>{rows.map((row) => (
          <tr key={row.id}>
            <td>{formatTime(row.created_at)}</td>
            <td><code>{row.action}</code></td>
            <td>{row.target_type}{row.target_id ? <small className="muted"> · {row.target_id}</small> : ''}</td>
            <td>{row.actor_id ?? '시스템'}</td>
            <td>{row.source}</td>
            <td>{row.ip ?? '—'}</td>
            <td>
              <details>
                <summary>보기</summary>
                <pre>{JSON.stringify({ request_id: row.request_id, metadata: row.metadata }, null, 2)}</pre>
              </details>
            </td>
          </tr>
        ))}</tbody>
      </table>
      {!rows.length && <p className="empty-state">감사 기록이 없습니다.</p>}
    </div>
  );

  return (
    <section className="operation-page">
      <div className="page-toolbar">
        <div><p className="eyebrow">SECURITY</p><h1>감사 로그</h1><p className="muted">매장 관리 작업의 기록을 최신순으로 조회합니다. 감사 기록은 변경하거나 삭제할 수 없습니다.</p></div>
      </div>
      <form className="page-toolbar" onSubmit={applyFilters}>
        <label>시작일<input aria-label="시작일" type="date" value={fromInput} onChange={(event) => setFromInput(event.target.value)} /></label>
        <label>종료일<input aria-label="종료일" type="date" value={toInput} onChange={(event) => setToInput(event.target.value)} /></label>
        <label>작업 코드<input aria-label="작업 코드" value={actionInput} onChange={(event) => setActionInput(event.target.value)} placeholder="예: customer.delete" /></label>
        <button type="submit">조회</button>
      </form>
      {error && <div role="alert" className="form-error">{error} <button type="button" onClick={() => setRetry((value) => value + 1)}>다시 시도</button></div>}
      {loading ? <p className="muted" aria-live="polite">감사 로그를 불러오는 중…</p> : error ? null : auditTable(visibleItems)}
      {!loading && pageIsCurrent && !error && <nav className="page-toolbar" aria-label="감사 로그 페이지 이동">
        <button type="button" disabled={pageIndex === 0} onClick={() => setTrail({ organizationId, cursors: cursors.slice(0, -1) })}>이전 페이지</button>
        <span className="muted">{pageIndex + 1} 페이지</span>
        <button type="button" disabled={!nextCursor} onClick={() => nextCursor && setTrail({ organizationId, cursors: [...cursors, nextCursor] })}>다음 페이지</button>
      </nav>}
      <p className="muted">보관 정책: 감사 로그는 수정·삭제하지 않으며 자동 파기하지 않습니다. 조직의 법률·계약상 보관 기간을 확인한 뒤 별도 운영 정책을 정해야 합니다.</p>
    </section>
  );
}
