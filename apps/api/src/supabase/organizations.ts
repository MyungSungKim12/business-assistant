import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { ApiFailure } from '../errors.js';
import { createAccessCache, type AccessCache } from '../security/access-cache.js';
import { memberDetail, memberRef, memberRuleFailure, type MemberRole } from './organization-members.js';

const organization = z.object({id:z.uuid(),name:z.string(),slug:z.string()});
const membership = z.object({role:z.enum(['owner','admin','member']),organizations:organization.nullable().optional()});
const subscription = z.object({
  status:z.string(), ends_at:z.iso.datetime({offset:true}).nullable(),
  plans:z.object({code:z.string(),plan_features:z.array(z.object({feature_code:z.string()}))}),
});
export type OrganizationGatewayOptions = {
  /** 권한 검사 캐시 유지 시간(초, 기본 30, 0 이면 끔). 서버는 APP_ACCESS_CACHE_TTL_SEC 로 정한다. */
  accessCacheTtlSec?: number;
  now?: () => number;
  /** 테스트에서 직접 만든 캐시를 주입한다. */
  accessCache?: AccessCache;
};

export function createOrganizationGateway(config: ServerConfig, fetcher: typeof fetch = fetch, options: OrganizationGatewayOptions = {}) {
  const accessCache = options.accessCache ?? createAccessCache({ ttlSec: options.accessCacheTtlSec ?? 30, now: options.now });
  /** 구성원 RPC 호출. 업무 규칙 오류(400/403)는 코드가 있는 응답으로 바꾼다. */
  async function memberRpc(token:string, name:string, args:Record<string,unknown>):Promise<unknown> {
    const url = new URL('/rest/v1/rpc/'+name, config.APP_SUPABASE_URL);
    let response:Response;
    let text:string;
    try {
      response = await fetcher(url, {
        method:'POST',
        headers:{apikey:config.APP_SUPABASE_PUBLISHABLE_KEY,Authorization:'Bearer '+token,'Content-Type':'application/json'},
        body:JSON.stringify(args), signal:AbortSignal.timeout(10000), redirect:'error',
      });
      text = await response.text();
    } catch {
      throw new ApiFailure(503,'Organization service unavailable');
    }
    let data:unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) throw memberRuleFailure(response.status,data) ?? new ApiFailure(503,'Organization service unavailable');
    return data;
  }
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
    /** 이메일·표시 이름·가입일을 포함한 구성원 목록(owner/admin 전용, DB 함수가 다시 확인). */
    async membersDetail(token:string,id:string) {
      return parse(z.array(memberDetail),await memberRpc(token,'list_organization_members',{p_org:id}));
    },
    /** 이미 가입한 사용자의 이메일로 구성원을 추가한다. 성공하면 권한 캐시를 비운다. */
    async addMemberByEmail(token:string,id:string,email:string,role:MemberRole) {
      const added = parse(memberRef,await memberRpc(token,'add_organization_member_by_email',{p_org:id,p_email:email,p_role:role}));
      accessCache.invalidateOrganization(id);
      return added;
    },
    async setMemberRole(token:string,id:string,userId:string,role:MemberRole) {
      const changed = parse(memberRef,await memberRpc(token,'set_organization_member_role',{p_org:id,p_user:userId,p_role:role}));
      accessCache.invalidateOrganization(id);
      return changed;
    },
    async removeMember(token:string,id:string,userId:string) {
      await memberRpc(token,'remove_organization_member',{p_org:id,p_user:userId});
      accessCache.invalidateOrganization(id);
    },
    /** 권한 캐시 무효화(멤버십이 다른 경로로 바뀐 경우). */
    invalidateAccess(id:string) { accessCache.invalidateOrganization(id); },
    async currentSubscription(token:string,id:string) {
      await requireMembership(token,id);
      const sub = await activeSubscription(token,id);
      if (!sub) throw new ApiFailure(404,'Active subscription not found');
      return sub;
    },
    async requireAccess(token:string,id:string,feature:string,write=false) {
      const cacheKey = {token,organizationId:id,feature,write};
      const cached = accessCache.get(cacheKey);
      if (cached !== undefined) return cached;
      const role = await requireMembership(token,id);
      if (write && role !== 'owner' && role !== 'admin') throw new ApiFailure(403,'Organization management permission required');
      const sub = await activeSubscription(token,id);
      if (!sub?.features.includes(feature)) throw new ApiFailure(403,'Feature not available',{feature_code:feature});
      accessCache.set(cacheKey,role);
      return role;
    },
  };
}
export type OrganizationGateway = ReturnType<typeof createOrganizationGateway>;

