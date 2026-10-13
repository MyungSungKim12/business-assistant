import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { ApiFailure } from '../errors.js';
import { createAppointmentResourceGateway } from '../modules/appointment-resources/gateway.js';
import { withPgErrorMap } from '../modules/catalog/pgErrors.js';
import { appointmentSchema, appointmentServiceSchema, appointmentStaffSchema, type AppointmentGateway } from '../routes/appointments.js';

const UNAVAILABLE = 'Appointment service unavailable';

/**
 * 예약 게이트웨이. 목록·저장은 자원 선택(resource_ids)과 한국 시간 기간 규칙을 가진
 * appointment-resources 게이트웨이에 위임하고, 담당자·서비스 목록과 상태 전이는 여기서 처리한다.
 * DB 오류 코드(P0001 등)는 withPgErrorMap으로 409/404/403/422에 매핑한다.
 */
export function createAppointmentGateway(config: ServerConfig, rawFetcher: typeof fetch = fetch): AppointmentGateway {
  const fetcher = withPgErrorMap(rawFetcher);
  const resources = createAppointmentResourceGateway(config, fetcher);

  async function call(token: string, path: string, params: Record<string, string> = {}, body?: unknown): Promise<unknown> {
    const url = new URL(`/rest/v1/${path}`, config.APP_SUPABASE_URL);
    url.search = new URLSearchParams(params).toString();
    try {
      const response = await fetcher(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { apikey: config.APP_SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 401) throw new ApiFailure(401, 'Not authenticated');
      if (response.status === 403) throw new ApiFailure(403, 'Access denied');
      if (response.status === 404) throw new ApiFailure(404, 'Appointment not found');
      if (response.status === 409) throw new ApiFailure(409, 'Appointment conflict; reload and retry');
      if (response.status === 422) throw new ApiFailure(422, 'Invalid appointment request');
      if (!response.ok) throw new ApiFailure(503, UNAVAILABLE);
      return await response.json();
    } catch (error) {
      if (error instanceof ApiFailure) throw error;
      throw new ApiFailure(503, UNAVAILABLE);
    }
  }

  function parse<T>(schema: z.ZodType<T>, value: unknown, organizationId: string): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new ApiFailure(503, UNAVAILABLE);
    const rows = (Array.isArray(result.data) ? result.data : [result.data]) as Array<{ organization_id?: string }>;
    if (rows.some((row) => row.organization_id !== organizationId)) throw new ApiFailure(503, UNAVAILABLE);
    return result.data;
  }

  const prefixed = (input: object) => Object.fromEntries(Object.entries(input).map(([key, value]) => [`p_${key}`, value]));

  return {
    list: (token, organizationId, query) => resources.listAppointments(token, organizationId, query),
    async listStaff(token, organizationId) {
      return parse(z.array(appointmentStaffSchema), await call(token, 'appointment_staff', { organization_id: `eq.${organizationId}`, order: 'name.asc' }), organizationId);
    },
    async listServices(token, organizationId) {
      return parse(z.array(appointmentServiceSchema), await call(token, 'appointment_services', { organization_id: `eq.${organizationId}`, order: 'name.asc' }), organizationId);
    },
    save: (token, organizationId, id, input) => resources.saveAppointment(token, organizationId, id, input),
    async transition(token, organizationId, id, input) {
      return parse(appointmentSchema, await call(token, 'rpc/transition_appointment', {}, { p_organization_id: organizationId, p_appointment_id: id, ...prefixed(input) }), organizationId);
    },
  };
}
