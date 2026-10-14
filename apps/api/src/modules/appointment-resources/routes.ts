import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiFailure } from '../../errors.js';
import { bearerToken } from '../../routes/organizations.js';
import type { OrgAccess } from '../catalog/routes.js';
import type { AppointmentResourceGateway } from './gateway.js';

const FEATURE = 'task.basic';
const version = z.number().int().min(1);
const operationId = z.uuid();
const name = (max: number) => z.string().max(max).transform((value) => value.trim()).pipe(z.string().min(1));
const kind = z.enum(['room', 'equipment']);
const awareDateTime = z.iso.datetime({ offset: true });

const staffRequest = z.object({ name: name(120) }).strict();
const serviceRequest = z.object({
  name: name(160), duration_minutes: z.number().int().min(5).max(480), buffer_minutes: z.number().int().min(0).max(120).default(0),
}).strict();
const serviceUpdate = z.object({
  name: name(160), duration_minutes: z.number().int().min(5).max(480), buffer_minutes: z.number().int().min(0).max(120),
  price_krw: z.number().int().min(0).max(1_000_000_000), category: z.string().max(60).transform((value) => value.trim()),
  is_active: z.boolean(), expected_version: version, operation_id: operationId,
}).strict();
const resourceRequest = z.object({ name: name(120), kind, operation_id: operationId }).strict();
const resourceUpdate = z.object({ name: name(120), is_active: z.boolean(), expected_version: version, operation_id: operationId }).strict();
const requirementsRequest = z.object({
  requirements: z.array(z.object({ kind, quantity: z.number().int().min(1).max(10) }).strict()).max(2),
  expected_version: version, operation_id: operationId,
}).strict().refine((value) => new Set(value.requirements.map((item) => item.kind)).size === value.requirements.length, 'Resource requirement kinds must be unique');
const consumablesRequest = z.object({
  items: z.array(z.object({ product_id: z.uuid(), quantity: z.number().int().min(1).max(1_000_000) }).strict()).max(100),
}).strict().refine((value) => new Set(value.items.map((item) => item.product_id)).size === value.items.length, 'Consumable products must be unique');

/** "HH:MM" 또는 "HH:MM:SS"를 "HH:MM:SS"로 통일한다(Python time → JSON 직렬화와 같다). */
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/).transform((value) => (value.length === 5 ? `${value}:00` : value));
const workingHour = z.object({ weekday: z.number().int().min(1).max(7), start: clock, end: clock }).strict()
  .refine((value) => value.end > value.start, 'Working hour end must follow start');
const workingHoursRequest = z.object({
  timezone_name: z.string().transform((value) => value.trim()).pipe(z.string().min(1).max(100)).default('Asia/Seoul'),
  hours: z.array(workingHour).max(21), expected_version: version, operation_id: operationId,
}).strict();
const timeOffRequest = z.object({
  start_at: awareDateTime, end_at: awareDateTime, reason: name(1000), operation_id: operationId,
}).strict().refine((value) => Date.parse(value.end_at) > Date.parse(value.start_at), 'Time off requires an aware increasing period');
const cancelTimeOff = z.object({ expected_version: version, operation_id: operationId }).strict();

/**
 * 예약 공간·장비 자원, 서비스별 필수 자원, 담당자 근무시간·휴무, 담당자·서비스 생성 라우트(Python api/appointments.py 중
 * 기존 appointments 라우트에 없는 부분). 읽기는 조직 구성원(member 포함), 쓰기는 owner/admin이며 모두 task.basic 기능이 필요하다.
 * 목록 GET /appointment-staff·/appointment-services, 예약 CRUD·전이는 기존 appointments 라우트가 소유하므로 여기서 등록하지 않는다.
 */
export function registerAppointmentResourceRoutes(app: FastifyInstance, organizations: OrgAccess | undefined, gateway: AppointmentResourceGateway | undefined): void {
  const base = '/api/v1/organizations/:organizationId';
  function context(request: FastifyRequest, shape: Record<string, z.ZodType> = {}) {
    const token = bearerToken(request);
    const params = z.object({ organizationId: z.uuid(), ...shape }).safeParse(request.params);
    if (!params.success) throw new ApiFailure(422, 'Invalid request path');
    if (!organizations || !gateway) throw new ApiFailure(503, 'Appointment service unavailable');
    return { token, gateway, params: params.data as Record<string, string> & { organizationId: string } };
  }
  function body<T>(schema: z.ZodType<T>, request: FastifyRequest): T {
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) throw new ApiFailure(422, 'Invalid appointment request');
    return parsed.data;
  }
  const authorize = (token: string, organizationId: string, write: boolean) => organizations!.requireAccess(token, organizationId, FEATURE, write);

  app.post(`${base}/appointment-staff`, async (request, reply) => {
    const c = context(request);
    const input = body(staffRequest, request);
    await authorize(c.token, c.params.organizationId, true);
    return reply.code(201).send(await c.gateway.createStaff(c.token, c.params.organizationId, input.name));
  });
  app.get(`${base}/appointment-staff/:staffId/availability`, async (request) => {
    const c = context(request, { staffId: z.uuid() });
    await authorize(c.token, c.params.organizationId, false);
    return c.gateway.getStaffAvailability(c.token, c.params.organizationId, c.params.staffId);
  });
  app.put(`${base}/appointment-staff/:staffId/working-hours`, async (request) => {
    const c = context(request, { staffId: z.uuid() });
    const input = body(workingHoursRequest, request);
    await authorize(c.token, c.params.organizationId, true);
    return c.gateway.replaceStaffHours(c.token, c.params.organizationId, c.params.staffId, input);
  });
  app.post(`${base}/appointment-staff/:staffId/time-off`, async (request, reply) => {
    const c = context(request, { staffId: z.uuid() });
    const input = body(timeOffRequest, request);
    await authorize(c.token, c.params.organizationId, true);
    return reply.code(201).send(await c.gateway.createTimeOff(c.token, c.params.organizationId, c.params.staffId, input));
  });
  app.post(`${base}/appointment-staff/:staffId/time-off/:timeOffId/cancel`, async (request) => {
    const c = context(request, { staffId: z.uuid(), timeOffId: z.uuid() });
    const input = body(cancelTimeOff, request);
    await authorize(c.token, c.params.organizationId, true);
    return c.gateway.cancelTimeOff(c.token, c.params.organizationId, c.params.staffId, c.params.timeOffId, input);
  });

  app.post(`${base}/appointment-services`, async (request, reply) => {
    const c = context(request);
    const input = body(serviceRequest, request);
    await authorize(c.token, c.params.organizationId, true);
    return reply.code(201).send(await c.gateway.createService(c.token, c.params.organizationId, input.name, input.duration_minutes, input.buffer_minutes));
  });
  /** Node 전용 확장 목록: 가격·카테고리·편집 버전(service_version)을 포함한다(기존 GET /appointment-services 응답은 바꾸지 않는다). */
  app.get(`${base}/appointment-service-details`, async (request) => {
    const c = context(request);
    await authorize(c.token, c.params.organizationId, false);
    return c.gateway.listServices(c.token, c.params.organizationId);
  });
  app.put(`${base}/appointment-services/:serviceId`, async (request) => {
    const c = context(request, { serviceId: z.uuid() });
    const input = body(serviceUpdate, request);
    await authorize(c.token, c.params.organizationId, true);
    return c.gateway.updateService(c.token, c.params.organizationId, c.params.serviceId, input);
  });
  app.get(`${base}/appointment-services/:serviceId/resource-requirements`, async (request) => {
    const c = context(request, { serviceId: z.uuid() });
    await authorize(c.token, c.params.organizationId, false);
    return c.gateway.listRequirements(c.token, c.params.organizationId, c.params.serviceId);
  });
  /** Node 전용 보조 경로: 필수 자원 기준과 낙관적 잠금 버전(resource_version)을 한 번에 읽는다(기존 서비스 목록 스키마가 버전을 버리기 때문). */
  app.get(`${base}/appointment-services/:serviceId/resource-setup`, async (request) => {
    const c = context(request, { serviceId: z.uuid() });
    await authorize(c.token, c.params.organizationId, false);
    return c.gateway.getRequirementSetup(c.token, c.params.organizationId, c.params.serviceId);
  });
  app.put(`${base}/appointment-services/:serviceId/resource-requirements`, async (request) => {
    const c = context(request, { serviceId: z.uuid() });
    const input = body(requirementsRequest, request);
    await authorize(c.token, c.params.organizationId, true);
    return c.gateway.replaceRequirements(c.token, c.params.organizationId, c.params.serviceId, input);
  });
  app.get(`${base}/appointment-services/:serviceId/consumables`, async (request) => {
    const c = context(request, { serviceId: z.uuid() });
    await authorize(c.token, c.params.organizationId, false);
    return c.gateway.listConsumables(c.token, c.params.organizationId, c.params.serviceId);
  });
  app.put(`${base}/appointment-services/:serviceId/consumables`, async (request) => {
    const c = context(request, { serviceId: z.uuid() });
    const input = body(consumablesRequest, request);
    await authorize(c.token, c.params.organizationId, true);
    return c.gateway.replaceConsumables(c.token, c.params.organizationId, c.params.serviceId, input.items);
  });

  app.get(`${base}/appointment-resources`, async (request) => {
    const c = context(request);
    await authorize(c.token, c.params.organizationId, false);
    return c.gateway.listResources(c.token, c.params.organizationId);
  });
  app.post(`${base}/appointment-resources`, async (request, reply) => {
    const c = context(request);
    const input = body(resourceRequest, request);
    await authorize(c.token, c.params.organizationId, true);
    return reply.code(201).send(await c.gateway.createResource(c.token, c.params.organizationId, input.name, input.kind, input.operation_id));
  });
  app.put(`${base}/appointment-resources/:resourceId`, async (request) => {
    const c = context(request, { resourceId: z.uuid() });
    const input = body(resourceUpdate, request);
    await authorize(c.token, c.params.organizationId, true);
    return c.gateway.updateResource(c.token, c.params.organizationId, c.params.resourceId, input);
  });
}
