import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiFailure } from '../../errors.js';
import { bearerToken } from '../../routes/organizations.js';
import type { AdminGateway } from './gateway.js';

const STATUSES = ['trialing', 'active', 'past_due', 'canceled', 'expired'] as const;
const aware = (field: string) => z.iso.datetime({ offset: true, error: `${field} must be timezone-aware` });

/** 구독 교체 요청(Python AdminSubscriptionRequest). plan_code는 공백 제거 후 대문자, 시각은 반드시 오프셋 포함, 종료는 시작보다 뒤. */
export const subscriptionRequest = z.object({
  plan_code: z.string().transform((value) => value.trim().toUpperCase()).pipe(z.string().min(1, 'plan_code is required')),
  status: z.enum(STATUSES, { error: 'unsupported subscription status' }),
  starts_at: aware('starts_at'),
  ends_at: aware('ends_at').nullable(),
}).superRefine((value, ctx) => {
  if (value.ends_at !== null && Date.parse(value.ends_at) <= Date.parse(value.starts_at)) ctx.addIssue({ code: 'custom', message: 'ends_at must be after starts_at', path: ['ends_at'] });
});

/**
 * 플랫폼 관리자 전용 구독 교체. 조직 구성원 권한이 아니라 APP_PLATFORM_ADMIN_USER_IDS 목록으로 판정하고,
 * 서비스 키가 없으면 503이다. 확인 순서: 인증(401) → 서비스 설정(503) → 관리자(403) → 입력(422) → 처리.
 */
export function registerAdminRoutes(app: FastifyInstance, gateway: AdminGateway | undefined): void {
  app.post('/api/v1/admin/organizations/:organizationId/subscription', async (request) => {
    const token = bearerToken(request);
    if (!gateway) throw new ApiFailure(503, 'Admin subscription service unavailable');
    const userId = await gateway.userId(token);
    if (!gateway.configured()) throw new ApiFailure(503, 'Admin subscription service unavailable');
    if (!gateway.isPlatformAdmin(userId)) throw new ApiFailure(403, 'Platform admin required');
    const params = z.object({ organizationId: z.uuid() }).safeParse(request.params);
    if (!params.success) throw new ApiFailure(422, 'Invalid organization ID');
    const body = subscriptionRequest.safeParse(request.body);
    if (!body.success) throw new ApiFailure(422, body.error.issues[0]?.message ?? 'Invalid subscription input');
    return gateway.replaceSubscription(params.data.organizationId, body.data);
  });
}
