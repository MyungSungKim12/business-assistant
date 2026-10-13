import { z } from 'zod';
import type { ServerConfig } from '../../config.js';
import { ApiFailure } from '../../errors.js';
import { createRest } from '../../supabase/rest.js';

const UNAVAILABLE = 'Admin subscription service unavailable';

/**
 * 플랫폼 관리자 설정. Python Settings.platform_admin_user_ids(APP_PLATFORM_ADMIN_USER_IDS, 쉼표로 구분한 UUID)와 같다.
 * ServerConfig에는 아직 이 키가 없으므로, 있으면 config 값을 쓰고 없으면 process.env를 읽는다(통합 시 config로 옮길 수 있다).
 */
export type AdminConfig = ServerConfig & { APP_PLATFORM_ADMIN_USER_IDS?: string };

export function platformAdminIds(config: AdminConfig, environment: Record<string, string | undefined> = process.env): Set<string> {
  const raw = config.APP_PLATFORM_ADMIN_USER_IDS ?? environment.APP_PLATFORM_ADMIN_USER_IDS ?? '';
  const ids = raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  // 형식이 잘못된 항목은 관리자로 인정하지 않는다(fail closed).
  return new Set(ids.filter((id) => z.uuid().safeParse(id).success));
}

export type SubscriptionInput = { plan_code: string; status: string; starts_at: string; ends_at: string | null };

export function createAdminGateway(config: AdminConfig, fetcher: typeof fetch = fetch, environment: Record<string, string | undefined> = process.env) {
  const rest = createRest(config, fetcher, UNAVAILABLE);
  return {
    /** 서비스 키가 설정되어 있는지. 없으면 관리자 기능을 제공하지 않는다. */
    configured: () => Boolean(config.APP_SUPABASE_SERVICE_KEY),
    /** 토큰 소유자의 사용자 ID(공개 키 + 사용자 토큰으로 Auth 서버에 확인). */
    userId: (token: string) => rest.userId(token),
    isPlatformAdmin: (userId: string) => platformAdminIds(config, environment).has(userId.toLowerCase()),
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
  };
}
export type AdminGateway = ReturnType<typeof createAdminGateway>;
