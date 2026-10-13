import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiFailure } from '../../errors.js';
import { bearerToken } from '../../routes/organizations.js';
import type { OrgAccess } from '../catalog/routes.js';
import { computeAvailability, DEFAULT_STEP_MINUTES, type AvailabilitySlot } from './availability.js';
import type { AppointmentResourceGateway } from './gateway.js';

const FEATURE = 'task.basic';
const DAY_MS = 86_400_000;
const SLOT_STEPS = [5, 10, 15, 20, 30, 60] as const;

export const ADVISORY = '안내용 계산입니다. 저장할 때 서버의 근무시간·휴무·예약·자원 충돌 검사가 최종 기준이며, 동시에 같은 시각을 고르면 나중 저장이 거절될 수 있습니다.';

const idList = z.string().max(20 * 37).transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean))
  .pipe(z.array(z.uuid()).max(20).refine((items) => new Set(items).size === items.length));
export const availabilityQuery = z.object({
  service_id: z.uuid(),
  date: z.iso.date(),
  staff_id: z.uuid().optional(),
  resource_ids: idList.optional(),
  exclude_appointment_id: z.uuid().optional(),
  step_minutes: z.coerce.number().int().refine((value) => (SLOT_STEPS as readonly number[]).includes(value)).optional(),
});
export type AvailabilityQuery = z.infer<typeof availabilityQuery>;

type Reader = Pick<AppointmentResourceGateway, 'listServices' | 'listStaff' | 'listResources' | 'listRequirements' | 'getStaffAvailability' | 'listAppointments'>;

export type AvailabilityResponse = {
  date: string;
  service_id: string;
  duration_minutes: number;
  buffer_minutes: number;
  step_minutes: number;
  staff: Array<{ id: string; name: string }>;
  required_resources: Array<{ kind: 'room' | 'equipment'; quantity: number }>;
  slots: AvailabilitySlot[];
  advisory: string;
};

const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** 사용자 토큰으로 필요한 표를 읽어 순수 계산 함수에 넘긴다. 쓰기는 하지 않는다. */
export async function loadAvailability(gateway: Reader, token: string, organizationId: string, query: AvailabilityQuery, now: Date = new Date()): Promise<AvailabilityResponse> {
  const [services, allStaff, resources, requirements] = await Promise.all([
    gateway.listServices(token, organizationId), gateway.listStaff(token, organizationId),
    gateway.listResources(token, organizationId), gateway.listRequirements(token, organizationId, query.service_id),
  ]);
  const service = services.find((item) => item.id === query.service_id && item.is_active);
  if (!service) throw new ApiFailure(404, 'Service not found');
  const activeStaff = allStaff.filter((item) => item.is_active);
  const staff = query.staff_id ? activeStaff.filter((item) => item.id === query.staff_id) : activeStaff;
  if (query.staff_id && staff.length === 0) throw new ApiFailure(404, 'Staff not found');

  const [schedules, appointments] = await Promise.all([
    Promise.all(staff.map((item) => gateway.getStaffAvailability(token, organizationId, item.id))),
    // 전날 늦은 예약의 여유 시간이 0시대 슬롯과 겹칠 수 있어 전날부터 읽는다.
    gateway.listAppointments(token, organizationId, { fromDate: addDays(query.date, -1), toDate: query.date }),
  ]);
  const stepMinutes = query.step_minutes ?? DEFAULT_STEP_MINUTES;
  const slots = computeAvailability({
    date: query.date, durationMinutes: service.duration_minutes, bufferMinutes: service.buffer_minutes, stepMinutes,
    staff: staff.map((item, index) => ({
      id: item.id, name: item.name,
      hours: schedules[index]!.hours.map((hour) => ({ weekday: hour.weekday, start_time: hour.start_time, end_time: hour.end_time, timezone_name: hour.timezone_name })),
      time_off: schedules[index]!.time_off.map((off) => ({ start_at: off.start_at, end_at: off.end_at })),
    })),
    appointments, resources, requirements, selectedResourceIds: query.resource_ids, excludeAppointmentId: query.exclude_appointment_id, now,
  });
  return {
    date: query.date, service_id: service.id, duration_minutes: service.duration_minutes, buffer_minutes: service.buffer_minutes, step_minutes: stepMinutes,
    staff: staff.map((item) => ({ id: item.id, name: item.name })), required_resources: requirements, slots, advisory: ADVISORY,
  };
}

/** GET /appointment-availability. 읽기 전용이라 조직 구성원이면 누구나 쓸 수 있다(task.basic 기능 필요). */
export function registerAppointmentAvailabilityRoutes(app: FastifyInstance, organizations: OrgAccess | undefined, gateway: Reader | undefined, now: () => Date = () => new Date()): void {
  app.get('/api/v1/organizations/:organizationId/appointment-availability', async (request) => {
    const token = bearerToken(request);
    const params = z.object({ organizationId: z.uuid() }).safeParse(request.params);
    if (!params.success) throw new ApiFailure(422, 'Invalid request path');
    if (!organizations || !gateway) throw new ApiFailure(503, 'Appointment service unavailable');
    const query = availabilityQuery.safeParse(request.query);
    if (!query.success) throw new ApiFailure(422, 'Invalid availability request');
    await organizations.requireAccess(token, params.data.organizationId, FEATURE, false);
    return loadAvailability(gateway, token, params.data.organizationId, query.data, now());
  });
}
