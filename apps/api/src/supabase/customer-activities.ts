import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { ApiFailure } from '../errors.js';

const activity = z.object({ id: z.uuid(), organization_id: z.uuid(), customer_id: z.uuid(), activity_type: z.string(), title: z.string(), description: z.string(), occurred_at: z.string() });
export type CustomerActivity = z.infer<typeof activity>;
export type ActivityInput = Pick<CustomerActivity, 'activity_type' | 'title' | 'description'> & { occurred_at: string | null };

export function createCustomerActivityGateway(config: ServerConfig, fetcher: typeof fetch = fetch) {
  async function request(token: string, method: 'GET' | 'POST' | 'DELETE', params: Record<string, string> = {}, body?: unknown): Promise<unknown> {
    const url = new URL('/rest/v1/customer_activities', config.APP_SUPABASE_URL);
    url.search = new URLSearchParams(params).toString();
    try {
      const response = await fetcher(url, { method, headers: { apikey: config.APP_SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(method === 'GET' ? {} : { Prefer: 'return=representation' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: 'error' });
      if (response.status === 401) throw new ApiFailure(401, 'Not authenticated');
      if (response.status === 403) throw new ApiFailure(403, 'Access denied');
      if (!response.ok) throw new ApiFailure(503, 'Customer activity service unavailable');
      return await response.json();
    } catch (error) {
      if (error instanceof ApiFailure) throw error;
      throw new ApiFailure(503, 'Customer activity service unavailable');
    }
  }
  function rows(value: unknown): CustomerActivity[] {
    const result = z.array(activity).safeParse(value);
    if (!result.success) throw new ApiFailure(503, 'Customer activity service unavailable');
    return result.data;
  }
  const select = 'id,organization_id,customer_id,activity_type,title,description,occurred_at';
  return {
    async list(token: string, organizationId: string, customerId: string) { return rows(await request(token, 'GET', { select, organization_id: `eq.${organizationId}`, customer_id: `eq.${customerId}`, order: 'occurred_at.desc' })); },
    async create(token: string, organizationId: string, customerId: string, input: ActivityInput) {
      const body: Record<string, unknown> = { ...input, organization_id: organizationId, customer_id: customerId };
      if (input.occurred_at === null) delete body.occurred_at;
      const result = rows(await request(token, 'POST', {}, body));
      if (!result[0]) throw new ApiFailure(503, 'Customer activity service unavailable');
      return result[0];
    },
    async remove(token: string, organizationId: string, customerId: string, activityId: string) { return rows(await request(token, 'DELETE', { id: `eq.${activityId}`, organization_id: `eq.${organizationId}`, customer_id: `eq.${customerId}` })).length > 0; },
  };
}

export type CustomerActivityGateway = {
  list(token: string, organizationId: string, customerId: string): Promise<CustomerActivity[]>;
  create(token: string, organizationId: string, customerId: string, input: ActivityInput): Promise<CustomerActivity>;
  remove(token: string, organizationId: string, customerId: string, activityId: string): Promise<boolean>;
};
