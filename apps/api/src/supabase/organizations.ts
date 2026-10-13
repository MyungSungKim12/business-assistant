import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { ApiFailure } from '../errors.js';

const organization = z.object({id:z.uuid(),name:z.string(),slug:z.string()});
const membership = z.object({role:z.enum(['owner','admin','member']),organizations:organization.nullable().optional()});
const subscription = z.object({
  status:z.string(), ends_at:z.iso.datetime({offset:true}).nullable(),
  plans:z.object({code:z.string(),plan_features:z.array(z.object({feature_code:z.string()}))}),
});
export function createOrganizationGateway(config: ServerConfig, fetcher: typeof fetch = fetch) {
  async function request(token:string, path:string, params:Record<string,string> = {}, body?:unknown):Promise<unknown> {
    const url = new URL(path, config.APP_SUPABASE_URL);
    url.search = new URLSearchParams(params).toString();
    try {
      const response = await fetcher(url, {
        method:body === undefined ? 'GET':'POST',
        headers:{apikey:config.APP_SUPABASE_PUBLISHABLE_KEY,Authorization:'Bearer '+token,'Content-Type':'application/json'},
        body:body === undefined ? undefined:JSON.stringify(body),
        signal:AbortSignal.timeout(10000), redirect:'error',
      });
      if (response.status === 401) throw new ApiFailure(401,'Not authenticated');
      if (response.status === 403) throw new ApiFailure(403,'Access denied');
      if (!response.ok) throw new ApiFailure(503,'Organization service unavailable');
      return await response.json();
    } catch(error) {
      if (error instanceof ApiFailure) throw error;
      throw new ApiFailure(503,'Organization service unavailable');
    }
  }
  function parse<T>(schema:z.ZodType<T>, value:unknown):T {
    const result = schema.safeParse(value);
    if (!result.success) throw new ApiFailure(503,'Organization service unavailable');
    return result.data;
  }
  async function identify(token:string) {
    return parse(z.object({id:z.uuid()}),await request(token,'/auth/v1/user')).id;
  }
  async function requireMembership(token:string, id:string) {
    const user = await identify(token);
    const exists = parse(z.boolean(),await request(token,'/rest/v1/rpc/organization_exists',{}, {target_organization_id:id}));
    if (!exists) throw new ApiFailure(404,'Organization not found');
    const rows = parse(z.array(membership),await request(token,'/rest/v1/memberships',{select:'role',organization_id:'eq.'+id,user_id:'eq.'+user}));
    if (!rows.length) throw new ApiFailure(403,'Organization membership required');
    return rows[0].role;
  }
  async function activeSubscription(token:string,id:string) {
    const rows = parse(z.array(subscription),await request(token,'/rest/v1/subscriptions',{
      select:'status,ends_at,plans(code,plan_features(feature_code))',organization_id:'eq.'+id,
      status:'in.(trialing,active)',or:'(ends_at.is.null,ends_at.gt.'+new Date().toISOString()+')',
      order:'starts_at.desc',limit:'1',
    }));
    const row = rows[0];
    if (!row) return null;
    return {organization_id:id,plan_code:row.plans.code,status:row.status,ends_at:row.ends_at,features:row.plans.plan_features.map(item=>item.feature_code).sort()};
  }
  return {
    async create(token:string,name:string,slug:string) {
      const rows = parse(z.array(organization),await request(token,'/rest/v1/rpc/create_organization',{},{target_name:name,target_slug:slug}));
      if (!rows[0]) throw new ApiFailure(503,'Organization service unavailable');
      return {...rows[0],role:'owner' as const};
    },
    async list(token:string) {
      const user = await identify(token);
      const rows = parse(z.array(membership),await request(token,'/rest/v1/memberships',{select:'role,organizations(id,name,slug)',user_id:'eq.'+user}));
      return rows.flatMap(row=>row.organizations ? [{...row.organizations,role:row.role}]:[]);
    },
    async entitlements(token:string,id:string) {
      await requireMembership(token,id);
      const sub = await activeSubscription(token,id);
      return {organization_id:id,plan_code:sub?.plan_code ?? null,features:sub?.features ?? []};
    },
    async members(token:string,id:string) {
      const role = await requireMembership(token,id);
      if (role !== 'owner' && role !== 'admin') throw new ApiFailure(403,'Organization management permission required');
      return parse(z.array(z.object({user_id:z.uuid(),role:z.string()})),await request(token,'/rest/v1/memberships',{select:'user_id,role',organization_id:'eq.'+id}));
    },
    async currentSubscription(token:string,id:string) {
      await requireMembership(token,id);
      const sub = await activeSubscription(token,id);
      if (!sub) throw new ApiFailure(404,'Active subscription not found');
      return sub;
    },
    async requireAccess(token:string,id:string,feature:string,write=false) {
      const role = await requireMembership(token,id);
      if (write && role !== 'owner' && role !== 'admin') throw new ApiFailure(403,'Organization management permission required');
      const sub = await activeSubscription(token,id);
      if (!sub?.features.includes(feature)) throw new ApiFailure(403,'Feature not available',{feature_code:feature});
      return role;
    },
  };
}
export type OrganizationGateway = ReturnType<typeof createOrganizationGateway>;

