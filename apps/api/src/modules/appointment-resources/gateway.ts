import { z } from 'zod';
import type { ServerConfig } from '../../config.js';
import { ApiFailure } from '../../errors.js';
import { createRest, type Query } from '../../supabase/rest.js';
import { withPgErrorMap } from '../catalog/pgErrors.js';

const UNAVAILABLE = 'Appointment service unavailable';
const PAGE = 200;

const row = { id: z.uuid(), organization_id: z.uuid() };
const kind = z.enum(['room', 'equipment']);

export const staffSchema = z.object({ ...row, name: z.string(), is_active: z.boolean(), schedule_version: z.number().int().min(1).default(1) });
export const serviceSchema = z.object({
  ...row, name: z.string(), duration_minutes: z.number().int().min(5).max(480), buffer_minutes: z.number().int().min(0).max(120),
  is_active: z.boolean(), resource_version: z.number().int().min(1).default(1),
});
export const resourceSchema = z.object({ ...row, name: z.string(), kind, is_active: z.boolean(), version: z.number().int().min(1) });
const requirementRowSchema = z.object({ ...row, service_id: z.uuid(), kind, quantity: z.number().int().min(1).max(10) });
export const requirementsResultSchema = z.object({
  service_id: z.uuid(), resource_version: z.number().int().min(1), requirements: z.array(z.record(z.string(), z.unknown())),
});
export const workingHourSchema = z.object({ ...row, staff_id: z.uuid(), weekday: z.number().int().min(1).max(7), start_time: z.string(), end_time: z.string(), timezone_name: z.string() });
export const timeOffSchema = z.object({
  ...row, staff_id: z.uuid(), start_at: z.string(), end_at: z.string(), reason: z.string(),
  status: z.enum(['active', 'canceled']), version: z.number().int().min(1),
});
export const workingHoursResultSchema = z.object({ staff_id: z.uuid(), schedule_version: z.number().int().min(1), timezone_name: z.string(), hours: z.array(workingHourSchema) });
/** 자원 선택(resource_ids)이 포함된 예약 행. 기존 appointments 모듈의 스키마에는 resource_ids가 없다. */
export const appointmentSchema = z.object({
  ...row, customer_id: z.uuid(), staff_id: z.uuid(), service_id: z.uuid(), service_name_snapshot: z.string(),
  duration_minutes: z.number().int(), buffer_minutes: z.number().int(), start_at: z.string(), end_at: z.string(),
  status: z.enum(['reserved', 'confirmed', 'checked_in', 'completed', 'canceled', 'no_show']),
  source: z.enum(['manual', 'phone', 'walk_in', 'online']), cancellation_reason: z.string().nullable(),
  version: z.number().int().min(1), resource_ids: z.array(z.uuid()).max(20).default([]),
});

export type AppointmentStaff = z.infer<typeof staffSchema>;
export type AppointmentService = z.infer<typeof serviceSchema>;
export type AppointmentResource = z.infer<typeof resourceSchema>;
export type WorkingHoursResult = z.infer<typeof workingHoursResultSchema>;
export type AppointmentTimeOff = z.infer<typeof timeOffSchema>;
export type ResourceAppointment = z.infer<typeof appointmentSchema>;
export type ResourceKind = z.infer<typeof kind>;
export type Requirement = { kind: ResourceKind; quantity: number };
export type WorkingHourInput = { weekday: number; start: string; end: string };
export type AppointmentSaveInput = {
  customer_id: string; staff_id: string; service_id: string; start_at: string; source: 'manual' | 'phone' | 'walk_in' | 'online';
  expected_version: number | null; operation_id: string; resource_ids: string[];
};

const KST_OFFSET_MS = 9 * 3_600_000;
const kstToday = (now: Date) => new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export function createAppointmentResourceGateway(config: ServerConfig, fetcher: typeof fetch = fetch, now: () => Date = () => new Date()) {
  const rest = createRest(config, withPgErrorMap(fetcher), UNAVAILABLE);
  const fail = () => new ApiFailure(503, UNAVAILABLE);

  /** Python `_list`와 같이 200건씩 id 순으로 끝까지 읽고, 조직 불일치·중복 행은 닫힌 실패로 처리한다. */
  async function listAll<T extends { id: string; organization_id: string }>(token: string, table: string, organizationId: string, schema: z.ZodType<T>, filters: Query = {}): Promise<T[]> {
    const items: T[] = [];
    for (;;) {
      const page = await rest.select(token, table, { organization_id: `eq.${organizationId}`, order: 'id.asc', limit: String(PAGE), offset: String(items.length), ...filters }, schema);
      if (page.some((item) => item.organization_id !== organizationId)) throw fail();
      items.push(...page);
      if (page.length < PAGE) break;
    }
    if (new Set(items.map((item) => item.id)).size !== items.length) throw fail();
    return items;
  }
  const rpc = <T>(token: string, name: string, organizationId: string, args: Record<string, unknown>, schema: z.ZodType<T>) =>
    rest.rpc(token, name, { p_organization_id: organizationId, ...args }, schema);
  async function single<T extends { organization_id: string }>(token: string, name: string, organizationId: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    const result = await rpc(token, name, organizationId, args, schema);
    if (result.organization_id !== organizationId) throw fail();
    return result;
  }

  async function listRequirements(token: string, organizationId: string, serviceId: string): Promise<Requirement[]> {
    const rows = await listAll(token, 'appointment_service_resource_requirements', organizationId, requirementRowSchema, { service_id: `eq.${serviceId}` });
    if (rows.some((item) => item.service_id !== serviceId)) throw fail();
    return rows.map((item) => ({ kind: item.kind, quantity: item.quantity }));
  }

  return {
    listStaff: (token: string, organizationId: string) => listAll(token, 'appointment_staff', organizationId, staffSchema),
    listServices: (token: string, organizationId: string) => listAll(token, 'appointment_services', organizationId, serviceSchema),
    listResources: (token: string, organizationId: string) => listAll(token, 'appointment_resources', organizationId, resourceSchema),

    createStaff: (token: string, organizationId: string, name: string) => single(token, 'create_appointment_staff', organizationId, { p_name: name }, staffSchema),
    createService: (token: string, organizationId: string, name: string, durationMinutes: number, bufferMinutes: number) =>
      single(token, 'create_appointment_service', organizationId, { p_name: name, p_duration_minutes: durationMinutes, p_buffer_minutes: bufferMinutes }, serviceSchema),

    createResource: (token: string, organizationId: string, name: string, resourceKind: ResourceKind, operationId: string) =>
      single(token, 'create_appointment_resource', organizationId, { p_name: name, p_kind: resourceKind, p_operation_id: operationId }, resourceSchema),
    async updateResource(token: string, organizationId: string, resourceId: string, input: { name: string; is_active: boolean; expected_version: number; operation_id: string }) {
      const result = await single(token, 'update_appointment_resource', organizationId, { p_resource_id: resourceId, p_name: input.name, p_is_active: input.is_active, p_expected_version: input.expected_version, p_operation_id: input.operation_id }, resourceSchema);
      if (result.id !== resourceId) throw fail();
      return result;
    },

    /** 서비스별 필수 자원 기준(공간·장비 수량). */
    listRequirements,
    /** 기준 저장에 필요한 낙관적 잠금 버전(resource_version)과 현재 기준을 함께 돌려준다. */
    async getRequirementSetup(token: string, organizationId: string, serviceId: string) {
      const services = await listAll(token, 'appointment_services', organizationId, serviceSchema, { id: `eq.${serviceId}` });
      const service = services.find((item) => item.id === serviceId);
      if (!service) throw new ApiFailure(404, 'Not found');
      const requirements = await listRequirements(token, organizationId, serviceId);
      return { service_id: service.id, resource_version: service.resource_version, requirements };
    },
    async replaceRequirements(token: string, organizationId: string, serviceId: string, input: { requirements: Requirement[]; expected_version: number; operation_id: string }) {
      const result = await rpc(token, 'replace_appointment_service_resource_requirements', organizationId, {
        p_service_id: serviceId, p_requirements: input.requirements, p_expected_version: input.expected_version, p_operation_id: input.operation_id,
      }, requirementsResultSchema);
      if (result.service_id !== serviceId) throw fail();
      return result;
    },

    /** 담당자 근무시간(주간)과 진행 중인 휴무. */
    async getStaffAvailability(token: string, organizationId: string, staffId: string) {
      const staff = (await listAll(token, 'appointment_staff', organizationId, staffSchema, { id: `eq.${staffId}` })).find((item) => item.id === staffId);
      if (!staff) throw new ApiFailure(404, 'Not found');
      const hours = await listAll(token, 'appointment_staff_working_hours', organizationId, workingHourSchema, { staff_id: `eq.${staffId}` });
      const timeOff = await listAll(token, 'appointment_staff_time_off', organizationId, timeOffSchema, { staff_id: `eq.${staffId}`, status: 'eq.active' });
      return { staff_id: staff.id, schedule_version: staff.schedule_version, hours, time_off: timeOff };
    },
    async replaceStaffHours(token: string, organizationId: string, staffId: string, input: { timezone_name: string; hours: WorkingHourInput[]; expected_version: number; operation_id: string }) {
      const result = await rpc(token, 'replace_appointment_staff_hours', organizationId, {
        p_staff_id: staffId, p_timezone_name: input.timezone_name, p_hours: input.hours, p_expected_version: input.expected_version, p_operation_id: input.operation_id,
      }, workingHoursResultSchema);
      if (result.staff_id !== staffId || result.hours.some((hour) => hour.organization_id !== organizationId || hour.staff_id !== staffId)) throw fail();
      return result;
    },
    async createTimeOff(token: string, organizationId: string, staffId: string, input: { start_at: string; end_at: string; reason: string; operation_id: string }) {
      const result = await single(token, 'create_appointment_staff_time_off', organizationId, {
        p_staff_id: staffId, p_start_at: input.start_at, p_end_at: input.end_at, p_reason: input.reason, p_operation_id: input.operation_id,
      }, timeOffSchema);
      if (result.staff_id !== staffId) throw fail();
      return result;
    },
    async cancelTimeOff(token: string, organizationId: string, staffId: string, timeOffId: string, input: { expected_version: number; operation_id: string }) {
      const result = await single(token, 'cancel_appointment_staff_time_off', organizationId, {
        p_time_off_id: timeOffId, p_expected_version: input.expected_version, p_operation_id: input.operation_id,
      }, timeOffSchema);
      if (result.id !== timeOffId || result.staff_id !== staffId) throw fail();
      return result;
    },

    /**
     * 자원 선택이 포함된 예약 조회·저장. 기존 appointments 라우트가 쓰도록 통합 단계에서 연결한다(라우트는 여기서 등록하지 않는다).
     * 기간 기본값은 Python과 같이 한국 시간 기준 오늘-7일 ~ 오늘+60일이다.
     */
    async listAppointments(token: string, organizationId: string, filter: { customerId?: string; fromDate?: string; toDate?: string } = {}) {
      const today = kstToday(now());
      const start = `${filter.fromDate ?? addDays(today, -7)}T00:00:00+09:00`;
      const end = `${addDays(filter.toDate ?? addDays(today, 60), 1)}T00:00:00+09:00`;
      const filters: Query = { and: `(start_at.gte.${start},start_at.lt.${end})` };
      if (filter.customerId) filters.customer_id = `eq.${filter.customerId}`;
      return listAll(token, 'appointments', organizationId, appointmentSchema, filters);
    },
    async saveAppointment(token: string, organizationId: string, appointmentId: string | null, input: AppointmentSaveInput) {
      const result = await single(token, 'save_appointment_with_resources', organizationId, {
        p_appointment_id: appointmentId, p_customer_id: input.customer_id, p_staff_id: input.staff_id, p_service_id: input.service_id,
        p_start_at: input.start_at, p_source: input.source, p_expected_version: input.expected_version, p_operation_id: input.operation_id,
        p_resource_ids: input.resource_ids,
      }, appointmentSchema);
      if (appointmentId !== null && result.id !== appointmentId) throw fail();
      return result;
    },
  };
}
export type AppointmentResourceGateway = ReturnType<typeof createAppointmentResourceGateway>;
