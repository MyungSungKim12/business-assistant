import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiFailure } from '../../errors.js';
import { bearerToken } from '../../routes/organizations.js';
import type { OrgAccess } from '../catalog/routes.js';
import { computeAvailability, DEFAULT_STEP_MINUTES, type AvailabilitySlot, type ResourceRequirementInput } from './availability.js';
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
export const availabilitySearchQuery=z.object({service_id:z.uuid(),from_date:z.iso.date(),days:z.coerce.number().int().min(1).max(14).default(7),staff_id:z.uuid().optional(),resource_ids:idList.optional(),exclude_appointment_id:z.uuid().optional(),step_minutes:z.coerce.number().int().refine(value=>(SLOT_STEPS as readonly number[]).includes(value)).optional()});
export type AvailabilitySearchQuery=z.infer<typeof availabilitySearchQuery>;

type Reader = Pick<AppointmentResourceGateway, 'listServices' | 'listStaff' | 'listResources' | 'listRequirements' | 'getStaffSchedules' | 'listAppointments' | 'getServiceStaff'>;

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
  const [services, allStaff, resources, requirements, assignedStaff] = await Promise.all([
    gateway.listServices(token, organizationId), gateway.listStaff(token, organizationId),
    gateway.listResources(token, organizationId), gateway.listRequirements(token, organizationId, query.service_id),
    gateway.getServiceStaff(token, organizationId, query.service_id),
  ]);
  const service = services.find((item) => item.id === query.service_id && item.is_active);
  if (!service) throw new ApiFailure(404, 'Service not found');
  const activeStaff = allStaff.filter((item) => item.is_active);
  if (query.staff_id && !activeStaff.some(item => item.id === query.staff_id)) throw new ApiFailure(404, 'Staff not found');
  const eligibleStaff = activeStaff.filter(item => assignedStaff.length === 0 || assignedStaff.includes(item.id));
  const staff = query.staff_id ? eligibleStaff.filter((item) => item.id === query.staff_id) : eligibleStaff;
  if (query.staff_id && staff.length === 0) throw new ApiFailure(422, 'Staff cannot perform this service');

  const [schedules, appointments] = await Promise.all([
    gateway.getStaffSchedules(token, organizationId, staff.map(item=>item.id), query.date),
    // 전날 늦은 예약의 여유 시간이 0시대 슬롯과 겹칠 수 있어 전날부터 읽는다.
    gateway.listAppointments(token, organizationId, { fromDate: addDays(query.date, -1), toDate: addDays(query.date,1) }),
  ]);
  if(schedules.length!==staff.length||schedules.some((schedule,index)=>schedule.staff_id!==staff[index].id))throw new ApiFailure(503,'Appointment service unavailable');
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

/** 여러 날을 한 번의 API 요청으로 찾는다. 기준 데이터와 예약·근무 범위는 한 번만 조회해 슬롯별 근거를 계산한다. */
export async function loadAvailabilitySearch(gateway:Reader,token:string,organizationId:string,query:AvailabilitySearchQuery,now:Date=new Date()){
 const toDate=addDays(query.from_date,query.days-1);
 const [services,allStaff,resources,requirements,assignedStaff]=await Promise.all([
  gateway.listServices(token,organizationId),gateway.listStaff(token,organizationId),gateway.listResources(token,organizationId),
  gateway.listRequirements(token,organizationId,query.service_id),gateway.getServiceStaff(token,organizationId,query.service_id),
 ]);
 const service=services.find(item=>item.id===query.service_id&&item.is_active);if(!service)throw new ApiFailure(404,'Service not found');
 const activeStaff=allStaff.filter(item=>item.is_active);
 if(query.staff_id&&!activeStaff.some(item=>item.id===query.staff_id))throw new ApiFailure(404,'Staff not found');
 const eligible=activeStaff.filter(item=>assignedStaff.length===0||assignedStaff.includes(item.id));
 const staff=query.staff_id?eligible.filter(item=>item.id===query.staff_id):eligible;
 if(query.staff_id&&staff.length===0)throw new ApiFailure(422,'Staff cannot perform this service');
 const [schedules,appointments]=await Promise.all([
  gateway.getStaffSchedules(token,organizationId,staff.map(item=>item.id),query.from_date,toDate),
  gateway.listAppointments(token,organizationId,{fromDate:addDays(query.from_date,-1),toDate:addDays(toDate,1)}),
 ]);
 if(schedules.length!==staff.length||schedules.some((item,index)=>item.staff_id!==staff[index].id))throw new ApiFailure(503,'Appointment service unavailable');
 const scheduleById=new Map(schedules.map(item=>[item.staff_id,item]));
 const stepMinutes=query.step_minutes??DEFAULT_STEP_MINUTES,recommendations: Array<{date:string;start:string;start_at:string;end_at:string;staff_ids:string[];available_staff_count:number;duration_minutes:number;buffer_minutes:number;required_resources:ResourceRequirementInput[];reason:string}>=[];
 for(let offset=0;offset<query.days;offset++){
  const date=addDays(query.from_date,offset);
  const slots=computeAvailability({date,durationMinutes:service.duration_minutes,bufferMinutes:service.buffer_minutes,stepMinutes,
   staff:staff.map(item=>{const schedule=scheduleById.get(item.id)!;return{id:item.id,name:item.name,hours:schedule.hours.map(hour=>({weekday:hour.weekday,start_time:hour.start_time,end_time:hour.end_time,timezone_name:hour.timezone_name})),time_off:schedule.time_off.map(off=>({start_at:off.start_at,end_at:off.end_at}))};}),
   appointments,resources,requirements,selectedResourceIds:query.resource_ids,excludeAppointmentId:query.exclude_appointment_id,now});
  for(const slot of slots){if(slot.available)recommendations.push({date,start:slot.start,start_at:slot.start_at,end_at:slot.end_at,staff_ids:slot.staff_ids,available_staff_count:slot.staff_ids.length,duration_minutes:service.duration_minutes,buffer_minutes:service.buffer_minutes,required_resources:requirements,reason:`근무·휴무·예약 충돌과 필수 자원 조건을 통과한 가장 이른 시간입니다. 담당 가능 ${slot.staff_ids.length}명`});}
 }
 recommendations.sort((a,b)=>a.start_at.localeCompare(b.start_at)||b.available_staff_count-a.available_staff_count);
 recommendations.forEach((recommendation,index)=>{
  recommendation.reason=index===0
   ? `선택한 시술·담당자와 근무·휴무·예약 충돌 및 필수 자원 조건을 통과한 가장 이른 시간입니다. 담당 가능 ${recommendation.available_staff_count}명`
   : `선택 조건을 통과한 이후 추천 시간입니다. 담당 가능 ${recommendation.available_staff_count}명`;
 });
 return {service_id:service.id,from_date:query.from_date,to_date:toDate,step_minutes:stepMinutes,recommendations:recommendations.slice(0,30),advisory:ADVISORY};
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
  app.get('/api/v1/organizations/:organizationId/appointment-availability-search',async request=>{
    const token=bearerToken(request),params=z.object({organizationId:z.uuid()}).safeParse(request.params);
    if(!params.success)throw new ApiFailure(422,'Invalid request path');if(!organizations||!gateway)throw new ApiFailure(503,'Appointment service unavailable');
    const query=availabilitySearchQuery.safeParse(request.query);if(!query.success)throw new ApiFailure(422,'Invalid availability search');
    await organizations.requireAccess(token,params.data.organizationId,FEATURE,false);
    return loadAvailabilitySearch(gateway,token,params.data.organizationId,query.data,now());
  });
}
