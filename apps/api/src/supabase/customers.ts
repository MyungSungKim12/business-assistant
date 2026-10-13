import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { ApiFailure } from '../errors.js';
import { withPgErrorMap } from '../modules/catalog/pgErrors.js';
import { createRest } from './rest.js';

const customer = z.object({
  id: z.uuid(), organization_id: z.uuid(), name: z.string(), email: z.string().nullable(), phone: z.string().nullable(), notes: z.string(),
  birth_date: z.string().nullable(), skin_type: z.string().nullable(), concerns: z.array(z.string()), allergies: z.string(),
  last_visit_date: z.string().nullable(), next_visit_date: z.string().nullable(), tags: z.array(z.string()), status: z.string(),
  created_at: z.string().optional(),
});

export type CustomerInput = z.infer<typeof customer>;
type EditableCustomer = Omit<CustomerInput, 'id' | 'organization_id'>;

/** GET /customers(기존 경로)가 한 번에 돌려주는 최대 행 수. 더 많으면 /customers/search를 쓴다. */
export const LEGACY_LIST_LIMIT = 5000;

export const customerStatuses = ['active', 'archived', 'inactive', 'vip', 'blocked'] as const;
export const customerSorts = ['name', 'created_at', 'last_visit_date'] as const;

export type CustomerSearchQuery = {
  q: string;
  status: (typeof customerStatuses)[number] | 'all';
  sort: (typeof customerSorts)[number];
  direction: 'asc' | 'desc';
  limit: number;
  offset: number;
};
export type CustomerSearchResult = { items: CustomerInput[]; total: number };

const tagCount = z.object({ tag: z.string(), count: z.number().int() });
const duplicateGroup = z.object({ reason: z.enum(['phone', 'email']), key: z.string(), customers: z.array(customer) });
const mergeResult = z.object({
  primary: customer, secondary_id: z.uuid(), moved: z.record(z.string(), z.number()), history_id: z.uuid().optional(),
});
export type CustomerTagCount = z.infer<typeof tagCount>;
export type DuplicateCustomerGroup = z.infer<typeof duplicateGroup>;
export type CustomerMergeResult = z.infer<typeof mergeResult>;
export type CustomerMergeResolved = Partial<Pick<EditableCustomer, 'name' | 'email' | 'phone' | 'birth_date' | 'skin_type' | 'allergies' | 'notes' | 'tags' | 'concerns' | 'last_visit_date' | 'next_visit_date'>>;
export type CustomerMergeInput = { secondaryId: string; operationId: string; resolved?: CustomerMergeResolved };

/**
 * PostgREST `or=(...)` 조건을 만든다. 값에서 구문을 깨는 문자(따옴표·괄호·쉼표·와일드카드·역슬래시 등)는 공백으로 바꾼다.
 * 숫자만 입력하면 저장된 하이픈 형식과도 맞도록 숫자 사이에 와일드카드를 넣는다. 태그는 정확히 일치하는 것만 찾는다.
 */
export function customerSearchFilter(raw: string): string | null {
  const text = raw.replace(/[\\"%*_,(){}]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const parts = [`name.ilike."*${text}*"`, `email.ilike."*${text}*"`, `phone.ilike."*${text}*"`, `tags.cs.{${text}}`];
  const digits = text.replace(/\D/g, '');
  if (digits.length >= 3 && /^[\d\s-]+$/.test(text)) parts.push(`phone.ilike."*${digits.split('').join('*')}*"`);
  return `(${parts.join(',')})`;
}

/** 정렬 값을 PostgREST order 문자열로 바꾼다. 같은 값이 있어도 순서가 흔들리지 않도록 id를 마지막에 붙인다. */
export function customerSearchOrder(sort: CustomerSearchQuery['sort'], direction: CustomerSearchQuery['direction']): string {
  const nulls = sort === 'last_visit_date' ? '.nullslast' : '';
  return `${sort}.${direction}${nulls},id.asc`;
}

/** `Content-Range: 0-49/1234` 또는 `* /0` 형식에서 전체 건수를 읽는다. */
export function parseContentRangeTotal(header: string | null): number | null {
  const match = /\/(\d+)$/.exec(header ?? '');
  return match ? Number(match[1]) : null;
}

export function createCustomerGateway(config: ServerConfig, fetcher: typeof fetch = fetch) {
  const rest = createRest(config, withPgErrorMap(fetcher), 'Customer service unavailable');

  async function send(token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', params: Record<string, string> = {}, body?: unknown, extra: Record<string, string> = {}): Promise<{ data: unknown; range: string | null }> {
    const url = new URL('/rest/v1/customers', config.APP_SUPABASE_URL);
    url.search = new URLSearchParams(params).toString();
    try {
      const response = await fetcher(url, {
        method,
        headers: { apikey: config.APP_SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(method === 'GET' ? {} : { Prefer: 'return=representation' }), ...extra },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: 'error',
      });
      if (response.status === 401) throw new ApiFailure(401, 'Not authenticated');
      if (response.status === 403) throw new ApiFailure(403, 'Access denied');
      if (!response.ok) throw new ApiFailure(503, 'Customer service unavailable');
      return { data: await response.json(), range: response.headers.get('content-range') };
    } catch (error) {
      if (error instanceof ApiFailure) throw error;
      throw new ApiFailure(503, 'Customer service unavailable');
    }
  }
  const request = async (token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', params: Record<string, string> = {}, body?: unknown): Promise<unknown> =>
    (await send(token, method, params, body)).data;
  function rows(value: unknown): CustomerInput[] {
    const result = z.array(customer).safeParse(value);
    if (!result.success) throw new ApiFailure(503, 'Customer service unavailable');
    return result.data;
  }
  const select = 'id,organization_id,name,email,phone,notes,birth_date,skin_type,concerns,allergies,last_visit_date,next_visit_date,tags,status,created_at';
  const rpc = <T>(token: string, name: string, organizationId: string, args: Record<string, unknown>, schema: z.ZodType<T>) =>
    rest.rpc(token, name, { p_organization_id: organizationId, ...args }, schema);

  function assertOwnRows(items: Array<{ organization_id: string }>, organizationId: string): void {
    if (items.some((item) => item.organization_id !== organizationId)) throw new ApiFailure(503, 'Customer service unavailable');
  }

  return {
    /** 기존 전체 목록. 서버 상한(LEGACY_LIST_LIMIT)까지만 돌려주므로 더 많은 조직은 /customers/search를 쓴다. */
    async list(token: string, organizationId: string) {
      return rows(await request(token, 'GET', { select, organization_id: `eq.${organizationId}`, order: 'name.asc', limit: String(LEGACY_LIST_LIMIT) }));
    },
    /** 이름·연락처·이메일·태그 검색, 상태·정렬, 페이지(offset)와 전체 건수를 한 번에 읽는다. */
    async search(token: string, organizationId: string, query: CustomerSearchQuery): Promise<CustomerSearchResult> {
      const params: Record<string, string> = {
        select, organization_id: `eq.${organizationId}`, order: customerSearchOrder(query.sort, query.direction),
        limit: String(query.limit), offset: String(query.offset),
      };
      if (query.status !== 'all') params.status = `eq.${query.status}`;
      const filter = customerSearchFilter(query.q);
      if (filter) params.or = filter;
      const { data, range } = await send(token, 'GET', params, undefined, { Prefer: 'count=exact' });
      const items = rows(data);
      assertOwnRows(items, organizationId);
      const total = parseContentRangeTotal(range);
      return { items, total: total ?? query.offset + items.length };
    },
    async create(token: string, organizationId: string, input: EditableCustomer) {
      const result = rows(await request(token, 'POST', {}, { ...input, organization_id: organizationId }));
      if (!result[0]) throw new ApiFailure(503, 'Customer service unavailable');
      return result[0];
    },
    /** 고객 행을 영구 삭제한다. 삭제된 행이 없으면 false. 화면은 삭제 대신 보관(status=archived)을 쓴다. */
    async remove(token: string, organizationId: string, customerId: string) {
      const result = rows(await request(token, 'DELETE', { id: `eq.${customerId}`, organization_id: `eq.${organizationId}`, select }));
      return result.length > 0;
    },
    async update(token: string, organizationId: string, customerId: string, patch: Partial<EditableCustomer>) {
      const result = rows(await request(token, 'PATCH', { id: `eq.${customerId}`, organization_id: `eq.${organizationId}` }, patch));
      return result[0] ?? null;
    },
    listTags: (token: string, organizationId: string) => rpc(token, 'list_customer_tags', organizationId, {}, z.array(tagCount)),
    renameTag: (token: string, organizationId: string, from: string, to: string) =>
      rpc(token, 'rename_customer_tag', organizationId, { p_from: from, p_to: to }, z.object({ updated: z.number().int() }).loose()),
    mergeTags: (token: string, organizationId: string, from: string[], to: string) =>
      rpc(token, 'merge_customer_tags', organizationId, { p_from: from, p_to: to }, z.object({ updated: z.number().int() }).loose()),
    deleteTag: (token: string, organizationId: string, tag: string) =>
      rpc(token, 'delete_customer_tag', organizationId, { p_tag: tag }, z.object({ updated: z.number().int() }).loose()),
    async duplicateGroups(token: string, organizationId: string) {
      const groups = await rpc(token, 'find_duplicate_customer_groups', organizationId, {}, z.array(duplicateGroup));
      for (const group of groups) assertOwnRows(group.customers, organizationId);
      return groups;
    },
    async merge(token: string, organizationId: string, primaryId: string, input: CustomerMergeInput): Promise<CustomerMergeResult> {
      const result = await rpc(token, 'merge_customers', organizationId, {
        p_primary_id: primaryId, p_secondary_id: input.secondaryId, p_operation_id: input.operationId, p_resolved: input.resolved ?? null,
      }, mergeResult);
      if (result.primary.organization_id !== organizationId || result.primary.id !== primaryId) throw new ApiFailure(503, 'Customer service unavailable');
      return result;
    },
  };
}

export type CustomerToolsGateway = Pick<ReturnType<typeof createCustomerGateway>, 'search' | 'listTags' | 'renameTag' | 'mergeTags' | 'deleteTag' | 'duplicateGroups' | 'merge'>;

type CoreCustomerGateway = {
  list(token: string, organizationId: string): Promise<CustomerInput[]>;
  create(token: string, organizationId: string, input: EditableCustomer): Promise<CustomerInput>;
  update(token: string, organizationId: string, customerId: string, patch: Partial<EditableCustomer>): Promise<CustomerInput | null>;
  remove(token: string, organizationId: string, customerId: string): Promise<boolean>;
};

/** 검색·태그·병합 메서드는 선택 항목이다(기존 테스트용 가짜 게이트웨이와 호환). 없으면 해당 라우트는 503을 돌려준다. */
export type CustomerGateway = CoreCustomerGateway & Partial<CustomerToolsGateway>;
