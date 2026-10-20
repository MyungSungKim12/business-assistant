import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { ApiFailure } from '../errors.js';
import { appointmentStatusEventSchema } from '../routes/appointmentHistory.js';
import { createAppointmentResourceGateway } from '../modules/appointment-resources/gateway.js';
import { withPgErrorMap } from '../modules/catalog/pgErrors.js';
import { appointmentSchema, appointmentServiceSchema, appointmentStaffSchema, type AppointmentGateway, type WaitlistEntry } from '../routes/appointments.js';

const UNAVAILABLE = 'Appointment service unavailable';
const waitlistSchema=z.object({id:z.uuid(),organization_id:z.uuid(),customer_id:z.uuid(),service_id:z.uuid(),staff_id:z.uuid().nullable(),preferred_date:z.iso.date().nullable(),note:z.string(),status:z.enum(['waiting','contacted','booked','canceled']),version:z.number().int(),created_at:z.string()});

/**
 * 예약 게이트웨이. 목록·저장은 자원 선택(resource_ids)과 한국 시간 기간 규칙을 가진
 * appointment-resources 게이트웨이에 위임하고, 담당자·서비스 목록과 상태 전이는 여기서 처리한다.
 * DB 오류 코드(P0001 등)는 withPgErrorMap으로 409/404/403/422에 매핑한다.
 */
export function createAppointmentGateway(config: ServerConfig, rawFetcher: typeof fetch = fetch): AppointmentGateway {
  const fetcher = withPgErrorMap(rawFetcher);
  const resources = createAppointmentResourceGateway(config, fetcher);

  async function call(token: string, path: string, params: Record<string, string> = {}, body?: unknown, method?: string): Promise<unknown> {
    const url = new URL(`/rest/v1/${path}`, config.APP_SUPABASE_URL);
    url.search = new URLSearchParams(params).toString();
    try {
      const response = await fetcher(url, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
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
    async history(token, organizationId, appointmentId) {
      const rows = parse(z.array(appointmentStatusEventSchema), await call(token, 'rpc/get_appointment_status_events', {}, { p_organization_id: organizationId, p_appointment_id: appointmentId }), organizationId);
      if (new Set(rows.map(row=>row.id)).size!==rows.length || rows.some((row,index)=>row.appointment_id!==appointmentId || (index>0 && row.appointment_version<=rows[index-1].appointment_version))) throw new ApiFailure(503,UNAVAILABLE);
      return rows;
    },
    list: (token, organizationId, query) => resources.listAppointments(token, organizationId, query),
    async listStaff(token, organizationId) {
      return parse(z.array(appointmentStaffSchema), await call(token, 'appointment_staff', { organization_id: `eq.${organizationId}`, order: 'name.asc' }), organizationId);
    },
    async listServices(token, organizationId) {
      return parse(z.array(appointmentServiceSchema), await call(token, 'appointment_services', { organization_id: `eq.${organizationId}`, order: 'name.asc' }), organizationId);
    },
    save: (token, organizationId, id, input) => resources.saveAppointment(token, organizationId, id, input),
    async listWaitlist(token, organizationId) {
      const rows = parse(z.array(waitlistSchema), await call(token, 'appointment_waitlist', { organization_id: `eq.${organizationId}`, order: 'created_at.asc,id.asc' }), organizationId);
      return rows;
    },
    async createWaitlist(token, organizationId, input) {
      const result = parse(waitlistSchema, await call(token, 'rpc/create_appointment_waitlist', {}, {
        p_organization_id: organizationId, p_customer_id: input.customer_id, p_service_id: input.service_id,
        p_staff_id: input.staff_id, p_preferred_date: input.preferred_date, p_note: input.note, p_operation_id: input.operation_id,
      }), organizationId);
      return result;
    },
    async updateWaitlist(token, organizationId, id, input) {
      return parse(waitlistSchema, await call(token, 'rpc/update_appointment_waitlist_status', {}, {
        p_organization_id: organizationId, p_waitlist_id: id, p_status: input.status, p_expected_version: input.expected_version,
      }), organizationId);
    },
    async bookWaitlist(token, organizationId, id, input) {
      const resultSchema = z.object({ appointment: appointmentSchema, waitlist: waitlistSchema, replayed: z.boolean() });
      const parsed = resultSchema.safeParse(await call(token, 'rpc/book_appointment_from_waitlist', {}, {
        p_organization_id: organizationId, p_waitlist_id: id, p_staff_id: input.staff_id, p_start_at: input.start_at,
        p_resource_ids: input.resource_ids, p_expected_version: input.expected_version, p_operation_id: input.operation_id,
      }));
      if (!parsed.success) throw new ApiFailure(503, UNAVAILABLE);
      const result = parsed.data;
      parse(appointmentSchema, result.appointment, organizationId);
      parse(waitlistSchema, result.waitlist, organizationId);
      if (result.waitlist.id !== id || result.appointment.customer_id !== result.waitlist.customer_id || result.appointment.service_id !== result.waitlist.service_id) throw new ApiFailure(503, UNAVAILABLE);
      return result;
    },
    async setMemo(token, organizationId, id, memo) {
      const saved = parse(appointmentSchema, await call(token, 'rpc/set_appointment_memo', {}, { p_organization_id: organizationId, p_appointment_id: id, p_memo: memo }), organizationId);
      return saved;
    },
    async transition(token, organizationId, id, input) {
      return parse(appointmentSchema, await call(token, 'rpc/transition_appointment', {}, { p_organization_id: organizationId, p_appointment_id: id, ...prefixed(input) }), organizationId);
    },
  };
}
