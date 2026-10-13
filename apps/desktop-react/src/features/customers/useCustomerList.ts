import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { LOCAL_LIMIT, PAGE_SIZE, searchCustomers, trySearchCustomers, type CustomerSort, type StatusFilter } from './customerSearch';
import type { Customer } from './types';

/** all: 전체를 불러와 화면에서 거른다(고객이 적을 때). paged: 서버 검색·페이지로 일부만 불러온다(고객이 많을 때). */
export type ListMode = 'all' | 'paged';

export type ListParams = { query: string; status: StatusFilter; sort: CustomerSort };

export interface CustomerListState {
  rows: Customer[];
  setRows: Dispatch<SetStateAction<Customer[]>>;
  /** 서버가 알려 준 전체 건수(paged 모드의 검색 조건 기준, all 모드는 불러온 건수). */
  total: number;
  /** 보관 포함 조직 전체 고객 수(첫 조회 때 알게 된 값). */
  organizationTotal: number;
  mode: ListMode;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string;
  reload: () => Promise<void>;
  loadMore: () => Promise<void>;
}

const SEARCH_DEBOUNCE_MS = 300;

function loadErrorText(error: unknown): string {
  const status = error instanceof ApiError ? error.status : undefined;
  if (status === 403) return '고객관리 권한이 없습니다.';
  if (status === 404) return '고객 정보를 찾을 수 없습니다.';
  return '고객 목록을 불러오지 못했습니다.';
}

/**
 * 고객 목록 불러오기.
 *  1) 서버 검색으로 첫 페이지와 총 건수를 읽는다(구버전 서버면 예전 전체 목록으로 대체).
 *  2) 총 건수가 PAGE_SIZE 이하면 그대로 전체, LOCAL_LIMIT 이하면 전체 목록을 읽어 all 모드, 넘으면 paged 모드.
 *  3) paged 모드에서는 검색어(지연 300ms)·상태·정렬이 바뀔 때마다 서버에 다시 묻고 "더 보기"로 다음 페이지를 붙인다.
 */
export function useCustomerList(api: ApiClient, organizationId: string, params: ListParams): CustomerListState {
  const [rows, setRows] = useState<Customer[]>([]);
  const [total, setTotal] = useState(0);
  const [organizationTotal, setOrganizationTotal] = useState(0);
  const [mode, setMode] = useState<ListMode>('all');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const requestId = useRef(0);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const modeRef = useRef<ListMode>('all');

  const runSearch = useCallback(async (reset: boolean, from: string | null, ticket: number) => {
    const { query, status, sort } = paramsRef.current;
    const page = await searchCustomers(api, organizationId, { q: query, status, sort, cursor: from });
    if (ticket !== requestId.current) return;
    setRows((old) => (reset ? page.items : [...old, ...page.items.filter((item) => !old.some((row) => row.id === item.id))]));
    setTotal(page.total);
    setCursor(page.next_cursor);
  }, [api, organizationId]);

  const reload = useCallback(async () => {
    const ticket = ++requestId.current;
    setLoading(true);
    setError('');
    try {
      const first = await trySearchCustomers(api, organizationId, { q: '', status: 'all', sort: 'name' });
      if (ticket !== requestId.current) return;
      if (first === null || (first.total > PAGE_SIZE && first.total <= LOCAL_LIMIT)) {
        const all = await api.listCustomers(organizationId);
        if (ticket !== requestId.current) return;
        modeRef.current = 'all'; setMode('all'); setRows(all); setTotal(all.length); setOrganizationTotal(all.length); setCursor(null);
      } else if (first.total <= PAGE_SIZE) {
        modeRef.current = 'all'; setMode('all'); setRows(first.items); setTotal(first.total); setOrganizationTotal(first.total); setCursor(null);
      } else {
        modeRef.current = 'paged'; setMode('paged'); setOrganizationTotal(first.total);
        await runSearch(true, null, ticket);
      }
    } catch (failure) {
      if (ticket === requestId.current) setError(loadErrorText(failure));
    } finally {
      if (ticket === requestId.current) setLoading(false);
    }
  }, [api, organizationId, runSearch]);

  useEffect(() => { void reload(); }, [reload]);

  // paged 모드에서 조건이 바뀌면 서버에 다시 묻는다. 검색어는 입력이 멈춘 뒤에만 보낸다.
  const firstConditions = useRef(true);
  useEffect(() => {
    if (firstConditions.current) { firstConditions.current = false; return undefined; }
    if (modeRef.current !== 'paged') return undefined;
    const timer = setTimeout(() => {
      const ticket = ++requestId.current;
      setLoading(true);
      setError('');
      runSearch(true, null, ticket)
        .catch((failure) => { if (ticket === requestId.current) setError(loadErrorText(failure)); })
        .finally(() => { if (ticket === requestId.current) setLoading(false); });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [params.query, params.status, params.sort, runSearch]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    const ticket = requestId.current;
    setLoadingMore(true);
    try {
      await runSearch(false, cursor, ticket);
    } catch (failure) {
      setError(loadErrorText(failure));
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, runSearch]);

  return { rows, setRows, total, organizationTotal, mode, loading, loadingMore, hasMore: cursor !== null, error, reload, loadMore };
}
