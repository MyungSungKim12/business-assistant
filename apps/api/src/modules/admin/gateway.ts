import { z } from 'zod';
import type { ServerConfig } from '../../config.js';
import { ApiFailure } from '../../errors.js';
import { createRest } from '../../supabase/rest.js';
import { sanitizeMetadata } from '../../audit/recorder.js';

const UNAVAILABLE = 'Admin subscription service unavailable';

/**
 * 관리자 서버(admin-server.ts) 전용 설정. 서비스 키(APP_SUPABASE_SERVICE_KEY)와 플랫폼 관리자 목록
 * (APP_PLATFORM_ADMIN_USER_IDS, 쉼표로 구분한 UUID)은 일반 API 의 ServerConfig 에 없고 이 프로세스만 읽는다.
 */
export type AdminConfig = ServerConfig & { APP_SUPABASE_SERVICE_KEY?: string; APP_PLATFORM_ADMIN_USER_IDS?: string };

export function platformAdminIds(config: AdminConfig, environment: Record<string, string | undefined> = process.env): Set<string> {
  const raw = config.APP_PLATFORM_ADMIN_USER_IDS ?? environment.APP_PLATFORM_ADMIN_USER_IDS ?? '';
  const ids = raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  // 형식이 잘못된 항목은 관리자로 인정하지 않는다(fail closed).
  return new Set(ids.filter((id) => z.uuid().safeParse(id).success));
}

export type AdminAuditInput = { actorId: string; organizationId: string | null; action: string; targetType?: string; targetId?: string | null; metadata: Record<string, unknown>; requestId?: string; ip?: string };
export type SubscriptionInput = { plan_code: string; status: string; starts_at: string; ends_at: string | null };
export type PlanStorageQuota = { plan_code: string; plan_name: string; quota_bytes: number | null };

const planStorageQuotaSchema = z.object({ code: z.string().min(1).max(40), name: z.string().min(1).max(100), file_storage_quota_bytes: z.number().int().min(0).max(1099511627776).nullable() });

function parsePlanStorageQuota(value: unknown): PlanStorageQuota {
  const result = planStorageQuotaSchema.safeParse(value);
  if (!result.success) throw new ApiFailure(503, UNAVAILABLE);
  return { plan_code: result.data.code, plan_name: result.data.name, quota_bytes: result.data.file_storage_quota_bytes };
}

export function createAdminGateway(config: AdminConfig, fetcher: typeof fetch = fetch, environment: Record<string, string | undefined> = process.env) {
  const rest = createRest(config, fetcher, UNAVAILABLE);
  return {
    /** 서비스 키가 설정되어 있는지. 없으면 관리자 기능을 제공하지 않는다. */
    configured: () => Boolean(config.APP_SUPABASE_SERVICE_KEY),
    /** 토큰 소유자의 사용자 ID(공개 키 + 사용자 토큰으로 Auth 서버에 확인). */
    userId: (token: string) => rest.userId(token),
    isPlatformAdmin: (userId: string) => platformAdminIds(config, environment).has(userId.toLowerCase()),
    async listPlanStorageQuotas(): Promise<PlanStorageQuota[]> {
      const serviceKey = config.APP_SUPABASE_SERVICE_KEY;
      if (!serviceKey) throw new ApiFailure(503, UNAVAILABLE);
      const url = new URL('/rest/v1/plans', config.APP_SUPABASE_URL);
      url.search = new URLSearchParams({ select: 'code,name,file_storage_quota_bytes', order: 'code.asc' }).toString();
      try {
        const response = await fetcher(url, { method: 'GET', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }, signal: AbortSignal.timeout(10_000), redirect: 'error' });
        const payload: unknown = await response.json();
        if (!response.ok || !Array.isArray(payload)) throw new ApiFailure(503, UNAVAILABLE);
        return payload.map(parsePlanStorageQuota);
      } catch (error) {
        if (error instanceof ApiFailure) throw error;
        throw new ApiFailure(503, UNAVAILABLE);
      }
    },
    async setPlanStorageQuota(planCode: string, quotaBytes: number | null): Promise<PlanStorageQuota> {
      const serviceKey = config.APP_SUPABASE_SERVICE_KEY;
      if (!serviceKey) throw new ApiFailure(503, UNAVAILABLE);
      const url = new URL('/rest/v1/plans', config.APP_SUPABASE_URL);
      url.search = new URLSearchParams({ code: `eq.${planCode}`, select: 'code,name,file_storage_quota_bytes' }).toString();
      try {
        const response = await fetcher(url, {
          method: 'PATCH', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
          body: JSON.stringify({ file_storage_quota_bytes: quotaBytes }), signal: AbortSignal.timeout(10_000), redirect: 'error',
        });
        const payload: unknown = await response.json();
        if (response.status === 404) throw new ApiFailure(404, 'Plan not found');
        if (!response.ok || !Array.isArray(payload)) throw new ApiFailure(503, UNAVAILABLE);
        if (payload.length === 0) throw new ApiFailure(404, 'Plan not found');
        if (payload.length !== 1) throw new ApiFailure(503, UNAVAILABLE);
        return parsePlanStorageQuota(payload[0]);
      } catch (error) {
        if (error instanceof ApiFailure) throw error;
        throw new ApiFailure(503, UNAVAILABLE);
      }
    },
    /** 서버 전용 서비스 키로 구독을 교체한다. 테넌트 어댑터에서는 쓰지 않는다. */
    async replaceSubscription(organizationId: string, input: SubscriptionInput): Promise<SubscriptionInput> {
      const serviceKey = config.APP_SUPABASE_SERVICE_KEY;
      if (!serviceKey) throw new ApiFailure(503, UNAVAILABLE);
      const url = new URL('/rest/v1/rpc/replace_organization_subscription', config.APP_SUPABASE_URL);
      let payload: unknown;
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target_organization_id: organizationId, target_plan_code: input.plan_code, target_status: input.status,
            target_starts_at: input.starts_at, target_ends_at: input.ends_at,
          }),
          signal: AbortSignal.timeout(10_000), redirect: 'error',
        });
        const text = await response.text();
        if (response.status === 400) {
          let message: unknown;
          try { message = (JSON.parse(text) as { message?: unknown } | null)?.message; } catch { throw new ApiFailure(503, UNAVAILABLE); }
          if (message === 'organization not found') throw new ApiFailure(404, 'Organization not found');
          throw new ApiFailure(422, 'Invalid subscription input');
        }
        if (!response.ok) throw new ApiFailure(503, UNAVAILABLE);
        payload = text ? JSON.parse(text) : null;
      } catch (error) {
        if (error instanceof ApiFailure) throw error;
        throw new ApiFailure(503, UNAVAILABLE);
      }
      if (typeof payload !== 'object' || payload === null || (payload as { plan_code?: unknown }).plan_code !== input.plan_code) throw new ApiFailure(503, UNAVAILABLE);
      return input;
    },
    /**
     * 감사 로그를 서비스 키로 직접 적는다(관리자는 대상 조직의 구성원이 아니라 사용자 토큰 RPC 를 쓸 수 없다).
     * 실패하면 오류를 던지며, 호출자가 로그만 남기고 본 작업 결과는 유지한다.
     */
    async recordAudit(input: AdminAuditInput): Promise<void> {
      const serviceKey = config.APP_SUPABASE_SERVICE_KEY;
      if (!serviceKey) throw new ApiFailure(503, UNAVAILABLE);
      const url = new URL('/rest/v1/audit_events', config.APP_SUPABASE_URL);
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({
            organization_id: input.organizationId, actor_id: input.actorId, action: input.action, target_type: input.targetType ?? 'organization', target_id: input.targetId ?? input.organizationId,
            metadata: sanitizeMetadata(input.metadata), request_id: input.requestId ?? null, ip: input.ip ?? null, source: 'service',
          }),
          signal: AbortSignal.timeout(10_000), redirect: 'error',
        });
        if (!response.ok) throw new ApiFailure(503, UNAVAILABLE);
      } catch (error) {
        if (error instanceof ApiFailure) throw error;
        throw new ApiFailure(503, UNAVAILABLE);
      }
    },
  };
}
export type AdminGateway = ReturnType<typeof createAdminGateway>;
