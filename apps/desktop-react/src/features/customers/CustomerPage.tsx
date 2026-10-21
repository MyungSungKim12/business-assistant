import { useCallback, useEffect, useMemo, useState } from 'react';
import { confirm, notify } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { customerPayload, emptyCustomer, type Customer } from './types';
import { CustomerGrid } from './CustomerGrid';
import { CustomerForm } from './CustomerForm';
import { InsightsPanel } from './InsightsPanel';
import { ActivityPanel } from './activities/ActivityPanel';
import { PhotoPanel } from './photos/PhotoPanel';
import { confirmDiscard } from './changeGuard';
import { ExportButton } from '../../lib/io/ExportButton';
import { customerExportColumns } from './io/customerExport';
import { CustomerImportDialog } from './io/CustomerImportDialog';
import { DuplicateMergeDialog } from './DuplicateMergeDialog';
import { TagManagerDialog } from './TagManagerDialog';
import { CustomerRetentionDialog } from './CustomerRetentionDialog';
import { PhoneMemoDialog } from './PhoneMemoDialog';
import { filterCustomers, SORT_LABELS, type CustomerSort, type StatusFilter } from './customerSearch';
import { isMergeArchive, restoreConfirmText } from './restore';
import { useCustomerList } from './useCustomerList';
import './customers.css';
import './crmTools.css';
import { useVisitFacts } from './visitFacts';

type Props = {
  api: ApiClient;
  organizationId: string;
  readOnly: boolean;
  /** 전체 검색 등에서 고객을 고른 채 화면을 열 때 선택할 고객. focusNonce가 바뀌면 같은 고객도 다시 선택한다. */
  focusCustomerId?: string;
  focusNonce?: number;
};

/**
 * 고객관리: 위쪽은 목록(왼쪽, 크기 고정)과 선택 고객 상세(오른쪽),
 * 아래쪽은 업무 인사이트(왼쪽)와 선택 고객의 사진 갤러리(오른쪽).
 * 고객이 많으면(LOCAL_LIMIT 초과) 서버 검색·페이지로 일부만 불러오고, 적으면 예전처럼 전체를 불러와 화면에서 거른다.
 */
export function CustomerPage({ api, organizationId, readOnly, focusCustomerId, focusNonce }: Props) {
  const [selected, setSelected] = useState<Customer | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('active');
  const [sort, setSort] = useState<CustomerSort>('name');
  const [actionError, setActionError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [editingBusy, setEditingBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [retentionOpen, setRetentionOpen] = useState(false);
  const [phoneMemoOpen, setPhoneMemoOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const closeImport = useCallback(() => setImporting(false), []);
  const closeTags = useCallback(() => setTagsOpen(false), []);
  const closeMerge = useCallback(() => setMergeOpen(false), []);

  const list = useCustomerList(api, organizationId, { query, status, sort });
  const { rows, setRows, mode } = list;
  const visitFacts=useVisitFacts(api,organizationId,[...rows.map(row=>row.id),...(selected?[selected.id]:[])],focusNonce);
  const selectedFacts=selected?visitFacts.facts.get(selected.id):undefined;
  const paged = mode === 'paged';

  // 목록이 다시 읽히면 선택한 고객을 새 값으로 바꾼다. 전체 모드에서 사라졌으면 선택을 푼다(일부만 읽는 모드는 유지).
  useEffect(() => {
    if (dirty || editingBusy) return;
    setSelected((current) => (current ? rows.find((row) => row.id === current.id) ?? (paged ? current : null) : null));
  }, [rows, paged, dirty, editingBusy]);

  // 검색에서 넘어온 고객을 선택한다. 현재 목록에 없으면(보관 고객 등) 상태 필터를 '전체'로 넓혀 한 번 더 찾는다.
  const [pendingFocus, setPendingFocus] = useState<{ id: string; widened: boolean } | null>(null);
  useEffect(() => {
    if (focusCustomerId) setPendingFocus({ id: focusCustomerId, widened: false });
  }, [focusCustomerId, focusNonce]);
  useEffect(() => {
    if (!pendingFocus || list.loading) return;
    const found = rows.find((row) => row.id === pendingFocus.id);
    if (found) { setSelected(found); setDirty(false); setPendingFocus(null); return; }
    if (!pendingFocus.widened && status !== 'all') { setStatus('all'); setPendingFocus({ ...pendingFocus, widened: true }); return; }
    setPendingFocus(null);
  }, [pendingFocus, rows, list.loading, status]);

  const filtered = useMemo(
    () => (paged ? rows.filter((customer) => status === 'all' || customer.status === status) : filterCustomers(rows, { query, status, sort })),
    [rows, paged, query, status, sort],
  );
  const input = selected ? { ...selected } : emptyCustomer();
  const error = actionError || list.error;

  const changeCustomer = async (next: Customer | null) => {
    if (editingBusy) { notify.info('저장 중입니다. 결과를 확인한 뒤 고객을 변경하세요.'); return; }
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
      const payload = customerPayload(value) as typeof value;
      const saved = selected ? await api.updateCustomer(organizationId, selected.id, payload) : await api.createCustomer(organizationId, payload);
      setRows((old) => (old.some((row) => row.id === saved.id) ? old.map((row) => (row.id === saved.id ? saved : row)) : [saved, ...old]));
      setSelected(saved);
      setActionError('');
      return true;
    } catch {
      setActionError('저장하지 못했습니다. 작성 내용은 유지됩니다.');
      return false;
    }
  }

  async function archive() {
    if (!selected) return;
    try {
      const archived = await api.archiveCustomer(organizationId, selected.id);
      setRows((old) => old.map((row) => (row.id === archived.id ? archived : row)));
      setSelected(archived);
    } catch {
      setActionError('고객 보관에 실패했습니다. 다시 시도해 주세요.');
    }
  }

  /** 보관 고객을 활성으로 되돌린다. 한 명씩 순서대로 처리하고 실패한 수를 알린다. */
  async function restore(targets: Customer[]) {
    if (targets.length === 0 || readOnly) return;
    if (!(await confirm({ title: '보관 고객 복원', message: restoreConfirmText(targets), confirmLabel: '복원' }))) return;
    setRestoring(true);
    setActionError('');
    const restored: Customer[] = [];
    for (const target of targets) {
      try {
        restored.push(await api.updateCustomer(organizationId, target.id, { status: 'active' }));
      } catch {
        // 실패한 고객은 아래에서 개수로 알린다.
      }
    }
    setRestoring(false);
    if (restored.length > 0) {
      const byId = new Map(restored.map((row) => [row.id, row]));
      setRows((old) => old.map((row) => byId.get(row.id) ?? row));
      setSelected((current) => (current ? byId.get(current.id) ?? current : current));
      notify.success(`${restored.length}명을 활성 고객으로 복원했습니다.`);
    }
    if (restored.length < targets.length) setActionError(`${targets.length - restored.length}명은 복원하지 못했습니다. 다시 시도해 주세요.`);
  }

  const restorable = filtered.filter((customer) => customer.status === 'archived');
  const selectedArchived = selected?.status === 'archived' ? selected : null;
  const countText = list.loading ? '' : paged ? `${filtered.length} / ${list.total}명` : `${filtered.length}명`;
  const scopeNote = paged ? `불러온 ${rows.length}명 기준입니다 (전체 ${list.organizationTotal}명 중 일부). 전체 집계가 아닙니다.` : undefined;

  return (
    <section className="cx-page">
      <div className="page-toolbar">
        <div><h1>고객관리</h1><p className="muted">고객 프로필과 상담 정보를 관리합니다.</p></div>
        <div className="cx-toolbar-actions">
          <ExportButton title="고객 목록" columns={customerExportColumns} rows={filtered} allRows={rows} disabled={list.loading} />
          {!readOnly && <button onClick={() => setPhoneMemoOpen(true)}>전화 메모</button>}
          {!readOnly && <button onClick={() => setTagsOpen(true)}>태그 관리</button>}
          {!readOnly && <button onClick={() => setMergeOpen(true)}>중복 병합</button>}
          {!readOnly && <button disabled={!selected} title={!selected ? '고객을 선택하면 보유 정책과 법적 보류를 관리할 수 있습니다.' : undefined} onClick={() => setRetentionOpen(true)}>보유·파기 정책</button>}
          {!readOnly && <button onClick={() => setImporting(true)}>가져오기</button>}
          {!readOnly && <button className="primary-button" onClick={() => void changeCustomer(null)}>새 고객</button>}
        </div>
      </div>
      <div className="cx-board">
        <section className="cx-panel cx-list" aria-label="고객 목록 영역">
          <div className="cx-controls">
            <input aria-label="고객 검색" placeholder="이름, 연락처, 이메일, 태그 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
            <select aria-label="상태 필터" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
              <option value="active">활성 고객</option>
              <option value="archived">보관 고객</option>
              <option value="all">전체</option>
            </select>
            <select aria-label="정렬" value={sort} onChange={(e) => setSort(e.target.value as CustomerSort)}>
              {(Object.keys(SORT_LABELS) as CustomerSort[]).map((key) => <option key={key} value={key}>{SORT_LABELS[key]}</option>)}
            </select>
            <span className="muted cx-count">{countText}</span>
          </div>
          {status === 'archived' && !readOnly && (
            <div className="cxt-restore" role="group" aria-label="보관 고객 복원">
              <span className="muted">보관 고객을 활성으로 되돌립니다.</span>
              <button type="button" disabled={restoring || !selectedArchived} onClick={() => selectedArchived && void restore([selectedArchived])}>선택 고객 복원</button>
              <button type="button" disabled={restoring || restorable.length === 0} onClick={() => void restore(restorable)}>표시된 {restorable.length}명 복원</button>
            </div>
          )}
          {error && <div role="alert" className="form-error cx-error">{error} <button onClick={() => { setActionError(''); void list.reload(); }}>다시 시도</button></div>}
          <div className="cx-grid-slot">
            <CustomerGrid customers={filtered} selectedId={selected?.id} loading={list.loading} onSelect={changeCustomer} visitFacts={visitFacts} />
          </div>
          {paged && (
            <div className="cx-pager">
              <span className="muted">고객이 많아 서버에서 {filtered.length}명씩 나눠 불러옵니다.</span>
              <button type="button" disabled={!list.hasMore || list.loadingMore} onClick={() => void list.loadMore()}>{list.loadingMore ? '불러오는 중…' : list.hasMore ? '더 보기' : '모두 불러옴'}</button>
            </div>
          )}
        </section>

        <aside className="cx-panel cx-detail" aria-label="고객 상세">
          <h2>{selected ? selected.name : '새 고객 등록'}</h2>
          <div className="cx-detail__scroll">
            {selected&&<section aria-label="방문·예약 사실"><h3>방문·예약 원장</h3>{selectedFacts?<dl><dt>최근 실제 방문</dt><dd>{selectedFacts.last_actual_visit_date??'기록 없음'}</dd><dt>다음 예약</dt><dd>{selectedFacts.next_appointment_at?new Date(selectedFacts.next_appointment_at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'예약 없음'}</dd><dt>재방문 권장일</dt><dd>{selectedFacts.recommended_return_date??'없음'} · 실제 예약과 별개</dd></dl>:<p className="muted">{visitFacts.status==='error'?'원장 조회 실패 · SQL 061 적용과 권한을 확인하세요.':'원장을 확인하는 중…'}</p>}<small className="muted">수기 최근 방문: {selected.last_visit_date??'없음'} · 수기 방문 예정: {selected.next_visit_date??'없음'}</small></section>}
            {selected && isMergeArchive(selected) && <p className="muted cx-hint">다른 고객에 병합되어 보관된 고객입니다. 복원하면 중복 고객이 다시 생깁니다.</p>}
            <CustomerForm value={input} readOnly={readOnly} onDirtyChange={setDirty} onBusyChange={setEditingBusy} onSave={save} onArchive={selected && !readOnly ? archive : undefined} />
            {selected
              ? <ActivityPanel api={api} organizationId={organizationId} customerId={selected.id} readOnly={readOnly} />
              : <p className="muted cx-hint">고객을 저장하면 활동 타임라인과 사진을 기록할 수 있습니다.</p>}
          </div>
        </aside>

        <section className="cx-panel cx-insights-slot" aria-label="고객 인사이트 영역">
          <InsightsPanel customers={rows} selectedId={selected?.id} scopeNote={scopeNote} onSelect={(customer) => void pickFromInsight(customer)} visitFacts={visitFacts} />
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
      {importing && <CustomerImportDialog api={api} organizationId={organizationId} existing={rows} onClose={closeImport} onImported={() => void list.reload()} />}
      {tagsOpen && <TagManagerDialog api={api} organizationId={organizationId} onChanged={() => void list.reload()} onClose={closeTags} />}
      {mergeOpen && <DuplicateMergeDialog api={api} organizationId={organizationId} customers={rows} complete={!paged} onMerged={() => void list.reload()} onClose={closeMerge} />}
      {retentionOpen && selected && <CustomerRetentionDialog api={api} organizationId={organizationId} customerId={selected.id} onClose={() => setRetentionOpen(false)} />}
      {phoneMemoOpen && <PhoneMemoDialog api={api} organizationId={organizationId} onClose={() => setPhoneMemoOpen(false)} />}
    </section>
  );
}
