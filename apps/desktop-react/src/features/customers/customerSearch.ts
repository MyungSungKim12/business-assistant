import { z } from 'zod';
import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { customerSchema } from '../../api/schemas';
import type { Customer } from './types';

/** 서버 검색 한 번에 읽는 건수. 총 건수가 이 값 이하이면 한 번에 다 읽은 것이다. */
export const PAGE_SIZE = 200;
/** 총 고객 수가 이 값 이하이면 예전처럼 전체를 불러와 화면에서 거른다. 넘으면 서버 검색·페이지로 전환한다. */
export const LOCAL_LIMIT = 1000;

export type CustomerSort = 'name' | 'created_at' | 'last_visit_date';
export type StatusFilter = 'active' | 'archived' | 'all';
export const SORT_LABELS: Record<CustomerSort, string> = { name: '이름순', created_at: '최근 등록순', last_visit_date: '수기 최근 방문순' };

const searchResponse = z.object({ items: z.array(customerSchema), total: z.number().int(), next_cursor: z.string().nullable() });
export type CustomerSearchPage = z.infer<typeof searchResponse>;

export type SearchParams = { q: string; status: StatusFilter; sort: CustomerSort; limit?: number; cursor?: string | null };

export function searchPath(organizationId: string, params: SearchParams): string {
  const query = new URLSearchParams({ status: params.status, sort: params.sort, limit: String(params.limit ?? PAGE_SIZE) });
  if (params.q.trim()) query.set('q', params.q.trim());
  if (params.cursor) query.set('cursor', params.cursor);
  return `/organizations/${organizationId}/customers/search?${query.toString()}`;
}

export function searchCustomers(api: ApiClient, organizationId: string, params: SearchParams): Promise<CustomerSearchPage> {
  return api.call('GET', searchPath(organizationId, params), searchResponse);
}

/**
 * 서버 검색을 시도한다. 권한·인증 오류는 그대로 던지고, 구버전 서버·형식 불일치 등 그 밖의 실패는 null(전체 목록으로 대체)로 돌려준다.
 */
export async function trySearchCustomers(api: ApiClient, organizationId: string, params: SearchParams): Promise<CustomerSearchPage | null> {
  try {
    return await searchCustomers(api, organizationId, params);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) throw error;
    return null;
  }
}

const digitsOf = (value: string) => value.replace(/\D/g, '');

/** 이름·연락처(숫자만 비교 포함)·이메일·태그에 검색어가 들어 있는지. */
export function matchesCustomer(customer: Customer, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = `${customer.name} ${customer.phone ?? ''} ${customer.email ?? ''} ${customer.tags.join(' ')}`.toLowerCase();
  if (haystack.includes(needle)) return true;
  const digits = digitsOf(needle);
  return digits.length >= 3 && digitsOf(customer.phone ?? '').includes(digits);
}

const byName = (a: Customer, b: Customer) => a.name.localeCompare(b.name, 'ko');
const descendingDate = (pick: (customer: Customer) => string | null | undefined) => (a: Customer, b: Customer) => {
  const left = pick(a) ?? '';
  const right = pick(b) ?? '';
  if (left === right) return byName(a, b);
  if (!left) return 1;
  if (!right) return -1;
  return left < right ? 1 : -1;
};

export function sortCustomers(rows: readonly Customer[], sort: CustomerSort): Customer[] {
  const list = [...rows];
  if (sort === 'created_at') return list.sort(descendingDate((customer) => customer.created_at));
  if (sort === 'last_visit_date') return list.sort(descendingDate((customer) => customer.last_visit_date));
  return list.sort(byName);
}

export function filterCustomers(rows: readonly Customer[], options: { query: string; status: StatusFilter; sort: CustomerSort }): Customer[] {
  const matched = rows.filter((customer) => (options.status === 'all' || customer.status === options.status) && matchesCustomer(customer, options.query));
  return sortCustomers(matched, options.sort);
}
