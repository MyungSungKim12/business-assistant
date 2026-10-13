import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { ApiFailure } from '../errors.js';

const customer = z.object({
  id: z.uuid(), organization_id: z.uuid(), name: z.string(), email: z.string().nullable(), phone: z.string().nullable(), notes: z.string(),
  birth_date: z.string().nullable(), skin_type: z.string().nullable(), concerns: z.array(z.string()), allergies: z.string(),
  last_visit_date: z.string().nullable(), next_visit_date: z.string().nullable(), tags: z.array(z.string()), status: z.string(),
});

export type CustomerInput = z.infer<typeof customer>;

export function createCustomerGateway(config: ServerConfig, fetcher: typeof fetch = fetch) {
  async function request(token: string, method: 'GET' | 'POST' | 'PATCH', params: Record<string, string> = {}, body?: unknown): Promise<unknown> {
    const url = new URL('/rest/v1/customers', config.APP_SUPABASE_URL);
    url.search = new URLSearchParams(params).toString();
    try {
      const response = await fetcher(url, {
        method,
        headers: { apikey: config.APP_SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(method === 'GET' ? {} : { Prefer: 'return=representation' }) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: 'error',
      });
      if (response.status === 401) throw new ApiFailure(401, 'Not authenticated');
      if (response.status === 403) throw new ApiFailure(403, 'Access denied');
      if (!response.ok) throw new ApiFailure(503, 'Customer service unavailable');
      return await response.json();
    } catch (error) {
      if (error instanceof ApiFailure) throw error;
      throw new ApiFailure(503, 'Customer service unavailable');
    }
  }
  function rows(value: unknown): CustomerInput[] {
    const result = z.array(customer).safeParse(value);
    if (!result.success) throw new ApiFailure(503, 'Customer service unavailable');
    return result.data;
  }
  const select = 'id,organization_id,name,email,phone,notes,birth_date,skin_type,concerns,allergies,last_visit_date,next_visit_date,tags,status';
  return {
    async list(token: string, organizationId: string) {
      return rows(await request(token, 'GET', { select, organization_id: `eq.${organizationId}`, order: 'name.asc' }));
    },
    async create(token: string, organizationId: string, input: Omit<CustomerInput, 'id' | 'organization_id'>) {
      const result = rows(await request(token, 'POST', {}, { ...input, organization_id: organizationId }));
      if (!result[0]) throw new ApiFailure(503, 'Customer service unavailable');
      return result[0];
    },
    async update(token: string, organizationId: string, customerId: string, patch: Partial<Omit<CustomerInput, 'id' | 'organization_id'>>) {
      const result = rows(await request(token, 'PATCH', { id: `eq.${customerId}`, organization_id: `eq.${organizationId}` }, patch));
      return result[0] ?? null;
    },
  };
}

export type CustomerGateway = {
  list(token: string, organizationId: string): Promise<CustomerInput[]>;
  create(token: string, organizationId: string, input: Omit<CustomerInput, 'id' | 'organization_id'>): Promise<CustomerInput>;
  update(token: string, organizationId: string, customerId: string, patch: Partial<Omit<CustomerInput, 'id' | 'organization_id'>>): Promise<CustomerInput | null>;
};
