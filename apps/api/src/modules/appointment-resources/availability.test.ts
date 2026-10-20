import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auth, buildApp, fakeFetch, fakeOrganizations, ORG, testConfig, type FakeCall, type FakeReply } from '../catalog/testkit.js';
import { computeAvailability, withinStaffHours, zonedParts, type AvailabilityInput, type AvailabilitySlot, type WorkingHourInput } from './availability.js';
import { registerAppointmentResourceModule } from './index.js';

// 2026-12-14 는 월요일(ISO 1)이다. 라우트 테스트는 실제 현재 시각을 쓰므로 먼 미래 날짜를 고른다.
const DATE = '2026-12-14';
const STAFF_A = 'a1a9c39f-d8e8-4df8-a623-1f23a3a936bd';
const STAFF_B = 'b2a9c39f-d8e8-4df8-a623-1f23a3a936bd';
const ROOM_1 = 'c3a9c39f-d8e8-4df8-a623-1f23a3a936bd';
const ROOM_2 = 'd4a9c39f-d8e8-4df8-a623-1f23a3a936bd';
const hour = (start: string, end: string, weekday = 1): WorkingHourInput => ({ weekday, start_time: start, end_time: end, timezone_name: 'Asia/Seoul' });
const at = (time: string, date = DATE) => `${date}T${time}:00+09:00`;
const staff = (id: string, hours: WorkingHourInput[] = [hour('09:00:00', '18:00:00')], timeOff: Array<{ start_at: string; end_at: string }> = []) => ({ id, name: id === STAFF_A ? '가담당' : '나담당', hours, time_off: timeOff });
const base = (overrides: Partial<AvailabilityInput> = {}): AvailabilityInput => ({
  date: DATE, durationMinutes: 60, bufferMinutes: 0, staff: [staff(STAFF_A)], appointments: [], resources: [], requirements: [], ...overrides,
});
const slot = (slots: AvailabilitySlot[], start: string) => slots.find((item) => item.start === start)!;
const availableTimes = (slots: AvailabilitySlot[]) => slots.filter((item) => item.available).map((item) => item.start);
const appointment = (startTime: string, endTime: string, extra: Record<string, unknown> = {}) => ({
  id: 'e5a9c39f-d8e8-4df8-a623-1f23a3a936bd', staff_id: STAFF_A, start_at: at(startTime), end_at: at(endTime), buffer_minutes: 0, status: 'reserved', resource_ids: [], ...extra,
});

describe('computeAvailability: 근무시간', () => {
  it('근무시간 안에서 점유 구간이 끝나는 마지막 시작 시각까지만 연다', () => {
    const times = availableTimes(computeAvailability(base()));
    expect(times[0]).toBe('09:00');
    expect(times.at(-1)).toBe('17:00');
    expect(times).toHaveLength(17);
    expect(slot(computeAvailability(base()), '08:30').blocked).toEqual([{ code: 'outside_hours', staff_id: STAFF_A }]);
  });

  it('점심처럼 근무 행이 둘로 나뉘면 점유 구간이 점심에 걸치는 시각은 불가다', () => {
    const lunch = [hour('09:00:00', '12:00:00'), hour('13:00:00', '18:00:00')];
    const slots = computeAvailability(base({ staff: [staff(STAFF_A, lunch)] }));
    expect(availableTimes(slots).filter((time) => time >= '10:00' && time <= '13:00')).toEqual(['10:00', '10:30', '11:00', '13:00']);
    expect(slot(slots, '11:30').blocked[0]).toMatchObject({ code: 'outside_hours' });
    expect(slot(slots, '12:00').available).toBe(false);
  });

  it('소요 + 여유 시간이 근무 종료를 넘기면 불가다', () => {
    const slots = computeAvailability(base({ bufferMinutes: 30 }));
    expect(availableTimes(slots).at(-1)).toBe('16:30');
  });

  it('다른 요일의 근무시간은 쓰지 않는다', () => {
    const tuesdayOnly = computeAvailability(base({ staff: [staff(STAFF_A, [hour('09:00:00', '18:00:00', 2)])] }));
    expect(availableTimes(tuesdayOnly)).toEqual([]);
  });

  it('근무시간이 없는 담당자는 제한이 없지만 안내용 09~21시 창 안에서만 연다', () => {
    const slots = computeAvailability(base({ staff: [staff(STAFF_A, [])] }));
    expect(availableTimes(slots)[0]).toBe('09:00');
    expect(availableTimes(slots).at(-1)).toBe('20:00');
    expect(slot(slots, '08:30').blocked[0]).toMatchObject({ code: 'outside_default_window' });
  });
});

describe('computeAvailability: 자정 근처', () => {
  it('점유 구간이 자정을 넘으면 근무시간이 있어도 불가이고 마지막 시각 칸이 존재한다', () => {
    const night = [hour('20:00:00', '23:59:59')];
    const slots = computeAvailability(base({ staff: [staff(STAFF_A, night)], durationMinutes: 60 }));
    expect(slot(slots, '23:30').available).toBe(false);
    expect(slot(slots, '22:30').available).toBe(true);
    expect(slots).toHaveLength(48);
    expect(slots[0]!.start).toBe('00:00');
    expect(slots.at(-1)!.start).toBe('23:30');
  });

  it('전날 늦게 시작해 자정을 넘기는 예약(여유 포함)은 0시대 시각을 막는다', () => {
    const late = appointment('23:00', '23:50', { start_at: at('23:00', '2026-12-13'), end_at: at('23:50', '2026-12-13'), buffer_minutes: 30 });
    const slots = computeAvailability(base({ staff: [staff(STAFF_A, [hour('00:00:00', '23:59:59')])], appointments: [late], date: DATE }));
    expect(slot(slots, '00:00').blocked).toEqual([{ code: 'staff_busy', staff_id: STAFF_A }]);
    expect(slot(slots, '00:30').blocked).toEqual([]);
  });

  it('시간대가 다른 근무시간 행도 해당 시간대의 요일·시각으로 판정한다', () => {
    // 한국 월요일 08:00 = 미국 동부(EST) 일요일 18:00
    const utc = new Date(`${DATE}T08:00:00+09:00`).getTime();
    expect(zonedParts(utc, 'America/New_York')).toMatchObject({ isoWeekday: 7, date: '2026-12-13', minuteOfDay: 18 * 60 });
    expect(withinStaffHours([{ weekday: 7, start_time: '18:00:00', end_time: '23:00:00', timezone_name: 'America/New_York' }], utc, utc + 3_600_000)).toBe(true);
  });
});

describe('computeAvailability: 휴무와 기존 예약', () => {
  it('휴무와 겹치는 점유 구간은 불가이고 경계(끝=시작)는 가능하다', () => {
    const off = [{ start_at: at('13:00'), end_at: at('15:00') }];
    const slots = computeAvailability(base({ staff: [staff(STAFF_A, [hour('09:00:00', '18:00:00')], off)] }));
    expect(slot(slots, '12:30').blocked).toEqual([{ code: 'time_off', staff_id: STAFF_A }]);
    expect(slot(slots, '12:00').available).toBe(true);
    expect(slot(slots, '14:30').available).toBe(false);
    expect(slot(slots, '15:00').available).toBe(true);
  });

  it('활성 예약만 막고 취소·완료 예약과 수정 중인 자기 자신은 막지 않는다', () => {
    const slots = computeAvailability(base({ appointments: [appointment('10:00', '11:00'), appointment('14:00', '15:00', { status: 'canceled' }), appointment('16:00', '17:00', { status: 'completed' })] }));
    expect(slot(slots, '10:00').blocked).toEqual([{ code: 'staff_busy', staff_id: STAFF_A }]);
    expect(slot(slots, '09:30').available).toBe(false);
    expect(slot(slots, '09:00').available).toBe(true);
    expect(slot(slots, '11:00').available).toBe(true);
    expect(slot(slots, '14:00').available).toBe(true);
    expect(slot(slots, '16:00').available).toBe(true);
    const editing = computeAvailability(base({ appointments: [appointment('10:00', '11:00')], excludeAppointmentId: 'e5a9c39f-d8e8-4df8-a623-1f23a3a936bd' }));
    expect(slot(editing, '10:00').available).toBe(true);
  });

  it('기존 예약의 여유 시간도 점유한다', () => {
    const slots = computeAvailability(base({ appointments: [appointment('10:00', '11:00', { buffer_minutes: 30 })] }));
    expect(slot(slots, '11:00').available).toBe(false);
    expect(slot(slots, '11:30').available).toBe(true);
  });

  it('과거 시각은 past 사유로 불가다', () => {
    const slots = computeAvailability(base({ now: new Date(at('10:00')) }));
    expect(slot(slots, '10:00').blocked[0]).toEqual({ code: 'past', staff_id: null });
    expect(slot(slots, '10:30').available).toBe(true);
  });
});

describe('computeAvailability: 여러 담당자', () => {
  it('한 명이라도 가능하면 가능하고 불가한 담당자의 사유는 blocked에 남긴다', () => {
    const slots = computeAvailability(base({ staff: [staff(STAFF_A), staff(STAFF_B)], appointments: [appointment('10:00', '11:00')] }));
    expect(slot(slots, '10:00')).toMatchObject({ available: true, staff_ids: [STAFF_B], blocked: [{ code: 'staff_busy', staff_id: STAFF_A }] });
  });

  it('모든 담당자가 불가이면 불가이고 담당자별 사유를 모두 돌려준다', () => {
    const slots = computeAvailability(base({
      staff: [staff(STAFF_A), staff(STAFF_B, [hour('13:00:00', '18:00:00')])], appointments: [appointment('10:00', '11:00')],
    }));
    expect(slot(slots, '10:00')).toMatchObject({ available: false, staff_ids: [] });
    expect(slot(slots, '10:00').blocked).toEqual([{ code: 'staff_busy', staff_id: STAFF_A }, { code: 'outside_hours', staff_id: STAFF_B }]);
  });
});

describe('computeAvailability: 자원', () => {
  const rooms = [{ id: ROOM_1, kind: 'room' as const, is_active: true }, { id: ROOM_2, kind: 'room' as const, is_active: true }];
  const needRoom = [{ kind: 'room' as const, quantity: 1 }];

  it('빈 자원이 필요한 수량 이상이면 가능하다', () => {
    const slots = computeAvailability(base({ staff: [staff(STAFF_A), staff(STAFF_B)], resources: rooms, requirements: needRoom, appointments: [appointment('10:00', '11:00', { resource_ids: [ROOM_1] })] }));
    expect(slot(slots, '10:00').available).toBe(true);
  });

  it('모든 자원이 쓰이는 시각은 담당자가 비어도 resource_unavailable로 불가이고 부족 수량을 알려 준다', () => {
    const busy = [appointment('10:00', '11:00', { resource_ids: [ROOM_1] }), appointment('10:00', '11:00', { id: 'f6a9c39f-d8e8-4df8-a623-1f23a3a936bd', staff_id: STAFF_B, resource_ids: [ROOM_2] })];
    const slots = computeAvailability(base({ staff: [staff(STAFF_A), staff(STAFF_B)], resources: rooms, requirements: needRoom, appointments: busy }));
    const blocked = slot(slots, '10:00');
    expect(blocked.available).toBe(false);
    expect(blocked.blocked).toContainEqual({ code: 'resource_unavailable', staff_id: null, kind: 'room', needed: 1, free: 0 });
    expect(slot(slots, '11:00').available).toBe(true);
  });

  it('비활성 자원은 세지 않고 필요한 수량이 가능한 수보다 크면 불가다', () => {
    const slots = computeAvailability(base({ resources: [rooms[0]!, { ...rooms[1]!, is_active: false }], requirements: [{ kind: 'room', quantity: 2 }] }));
    expect(availableTimes(slots)).toEqual([]);
    expect(slot(slots, '10:00').blocked[0]).toMatchObject({ needed: 2, free: 1 });
  });

  it('사용자가 고른 자원이 그 시각에 쓰이면 불가이고 다른 자원이 비어 있어도 고른 것을 기준으로 한다', () => {
    const slots = computeAvailability(base({
      resources: rooms, requirements: needRoom, selectedResourceIds: [ROOM_1], appointments: [appointment('10:00', '11:00', { staff_id: STAFF_B, resource_ids: [ROOM_1] })],
    }));
    expect(slot(slots, '10:00').available).toBe(false);
    expect(slot(slots, '10:00').blocked).toContainEqual({ code: 'resource_unavailable', staff_id: null, kind: 'room', resource_id: ROOM_1 });
    expect(slot(slots, '12:00').available).toBe(true);
  });

  it('자원 여유 시간 겹침도 반영한다', () => {
    const slots = computeAvailability(base({ resources: [rooms[0]!], requirements: needRoom, appointments: [appointment('10:00', '11:00', { buffer_minutes: 30, resource_ids: [ROOM_1], staff_id: STAFF_B })] }));
    expect(slot(slots, '11:00').available).toBe(false);
    expect(slot(slots, '11:30').available).toBe(true);
  });
});

// ---- 라우트 ----
const SERVICE = '2b9c39fd-8e8c-4df8-a623-1f23a3a936bd';
const SERVICE_ROW = { id: SERVICE, organization_id: ORG, name: '관리', duration_minutes: 60, buffer_minutes: 0, is_active: true, resource_version: 1 };
const STAFF_ROW = { id: STAFF_A, organization_id: ORG, name: '가담당', is_active: true, schedule_version: 1 };
const HOUR_ROW = { id: '7b9c39fd-8e8c-4df8-a623-1f23a3a936bd', organization_id: ORG, staff_id: STAFF_A, weekday: 1, start_time: '09:00:00', end_time: '18:00:00', timezone_name: 'Asia/Seoul' };
const table = (call: FakeCall) => call.url.pathname.split('/').pop() ?? '';
const reply = (overrides: Record<string, unknown> = {}) => (call: FakeCall): FakeReply => {
  const rows: Record<string, unknown> = {
    appointment_services: [SERVICE_ROW], appointment_staff: [STAFF_ROW], appointment_resources: [], appointment_service_resource_requirements: [],
    appointment_staff_working_hours: [HOUR_ROW], appointment_staff_time_off: [], appointments: [], ...overrides,
  };
  return { body: rows[table(call)] ?? [] };
};

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });
function setup(handler = reply(), features = ['task.basic']) {
  const { fetcher, calls } = fakeFetch(handler);
  const organizations = fakeOrganizations('member', features);
  app = buildApp((instance) => registerAppointmentResourceModule(instance, organizations, testConfig, fetcher));
  const get = (query: string) => app.inject({ method: 'GET', url: `/api/v1/organizations/${ORG}/appointment-availability?${query}`, headers: auth });
  return { get, calls, organizations };
}

describe('GET appointment-availability', () => {
  it('인증·기능 권한이 없으면 묶음 DB 조회를 시작하지 않는다',async()=>{
    const {get,calls}=setup(reply(),[]);
    expect((await app.inject({url:`/api/v1/organizations/${ORG}/appointment-availability?service_id=${SERVICE}&date=${DATE}`})).statusCode).toBe(401);
    expect((await get(`service_id=${SERVICE}&date=${DATE}`)).statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });
  it('서비스에 지정되지 않은 직원은 추천에서 빼고 명시 조회는 422로 거절한다', async () => {
    const {get,calls}=setup(reply({appointment_service_staff:[{organization_id:ORG,service_id:SERVICE,staff_id:STAFF_B}]}));
    const result=await get(`service_id=${SERVICE}&date=${DATE}`);
    expect(result.statusCode).toBe(200);
    expect(result.json().staff).toEqual([]);
    expect(result.json().slots.some((slot:AvailabilitySlot)=>slot.available)).toBe(false);
    expect(calls.some(call=>table(call)==='appointment_staff_working_hours')).toBe(false);
    expect((await get(`service_id=${SERVICE}&date=${DATE}&staff_id=${STAFF_A}`)).statusCode).toBe(422);
  });

  it('서비스·담당자·근무시간을 읽어 슬롯과 안내 문구를 돌려주고 쓰기 요청은 보내지 않는다', async () => {
    const { get, calls, organizations } = setup();
    const response = await get(`service_id=${SERVICE}&date=${DATE}`);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { slots: AvailabilitySlot[]; staff: unknown[]; duration_minutes: number; advisory: string; step_minutes: number };
    expect(body.duration_minutes).toBe(60);
    expect(body.step_minutes).toBe(30);
    expect(body.staff).toEqual([{ id: STAFF_A, name: '가담당' }]);
    expect(body.advisory).toContain('최종 기준');
    expect(availableTimes(body.slots)[0]).toBe('09:00');
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    expect(calls.every((call) => call.headers.Authorization === 'Bearer user-token')).toBe(true);
    expect(organizations.calls).toEqual([{ feature: 'task.basic', write: false }]);
  });

  it('전날부터 당일까지 예약을 읽고 기존 예약 시각을 막는다', async () => {
    const existing = { ...{ id: 'e5a9c39f-d8e8-4df8-a623-1f23a3a936bd', organization_id: ORG, customer_id: SERVICE, staff_id: STAFF_A, service_id: SERVICE, service_name_snapshot: '관리', duration_minutes: 60, buffer_minutes: 0 }, start_at: at('10:00'), end_at: at('11:00'), status: 'confirmed', source: 'phone', cancellation_reason: null, version: 1, resource_ids: [] };
    const { get, calls } = setup(reply({ appointments: [existing] }));
    const body = (await get(`service_id=${SERVICE}&date=${DATE}&staff_id=${STAFF_A}`)).json() as { slots: AvailabilitySlot[] };
    expect(slot(body.slots, '10:00').blocked).toEqual([{ code: 'staff_busy', staff_id: STAFF_A }]);
    const appointments = calls.find((call) => table(call) === 'appointments')!;
    expect(appointments.url.searchParams.get('and')).toBe('(start_at.gte.2026-12-13T00:00:00+09:00,start_at.lt.2026-12-16T00:00:00+09:00)');
  });

  it('필수 자원을 서비스 기준으로 읽는다', async () => {
    const requirement = { id: '9b9c39fd-8e8c-4df8-a623-1f23a3a936bd', organization_id: ORG, service_id: SERVICE, kind: 'room', quantity: 1 };
    const { get } = setup(reply({ appointment_service_resource_requirements: [requirement] }));
    const body = (await get(`service_id=${SERVICE}&date=${DATE}`)).json() as { slots: AvailabilitySlot[]; required_resources: unknown[] };
    expect(body.required_resources).toEqual([{ kind: 'room', quantity: 1 }]);
    expect(slot(body.slots, '10:00')).toMatchObject({ available: false });
  });

  it('잘못된 입력은 422, 없는 서비스·담당자는 404, 기능이 없으면 거절한다', async () => {
    const { get } = setup();
    for (const query of ['date=2026-10-12', `service_id=${SERVICE}&date=2026-13-40`, `service_id=${SERVICE}&date=${DATE}&step_minutes=7`, `service_id=${SERVICE}&date=${DATE}&resource_ids=nope`]) {
      expect((await get(query)).statusCode, query).toBe(422);
    }
    expect((await get(`service_id=0b9c39fd-8e8c-4df8-a623-1f23a3a936bd&date=${DATE}`)).statusCode).toBe(404);
    expect((await get(`service_id=${SERVICE}&date=${DATE}&staff_id=0b9c39fd-8e8c-4df8-a623-1f23a3a936bd`)).statusCode).toBe(404);
  });
});
