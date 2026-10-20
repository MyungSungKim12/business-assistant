import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auth, buildApp, fakeFetch, fakeOrganizations, OP, ORG, OTHER_ORG, testConfig, type FakeCall, type FakeReply, type Role } from '../catalog/testkit.js';
import { createAppointmentResourceGateway, registerAppointmentResourceModule } from './index.js';

const id = (n: number) => `${n}a9c39fd-8e8c-4df8-a623-1f23a3a936bd`;
const STAFF = id(1), SERVICE = id(2), RESOURCE = id(3), CUSTOMER = id(4), APPT_ID = id(5), LEAVE = id(6);
const RESOURCE_ROW = { id: RESOURCE, organization_id: ORG, name: '관리실 1', kind: 'room', is_active: true, version: 1 };
const STAFF_ROW = { id: STAFF, organization_id: ORG, name: '담당자', is_active: true, schedule_version: 1 };
const SERVICE_ROW = { id: SERVICE, organization_id: ORG, name: '관리', duration_minutes: 60, buffer_minutes: 10, is_active: true, resource_version: 3 };
const HOUR = { id: id(7), organization_id: ORG, staff_id: STAFF, weekday: 4, start_time: '09:00:00', end_time: '18:00:00', timezone_name: 'Asia/Seoul' };
const TIME_OFF = { id: LEAVE, organization_id: ORG, staff_id: STAFF, start_at: '2026-10-08T15:00:00+09:00', end_at: '2026-10-08T16:00:00+09:00', reason: '교육', status: 'active', version: 1 };
const APPOINTMENT = {
  id: APPT_ID, organization_id: ORG, customer_id: CUSTOMER, staff_id: STAFF, service_id: SERVICE, service_name_snapshot: '관리', duration_minutes: 60, buffer_minutes: 10,
  start_at: '2026-10-08T10:00:00+09:00', end_at: '2026-10-08T11:00:00+09:00', status: 'reserved', source: 'phone', cancellation_reason: null, version: 1, resource_ids: [RESOURCE],
};
const REQUIREMENT_ROW = { id: id(8), organization_id: ORG, service_id: SERVICE, kind: 'room', quantity: 1 };
const name = (call: FakeCall) => call.url.pathname.split('/').pop() ?? '';

/** 테이블·RPC 이름으로 응답을 고르는 가짜 Supabase. */
const supabase = (overrides: Record<string, unknown> = {}) => (call: FakeCall): FakeReply => {
  const table: Record<string, unknown> = {
    appointment_staff: [STAFF_ROW], appointment_services: [SERVICE_ROW], appointment_resources: [RESOURCE_ROW],
    appointment_service_resource_requirements: [REQUIREMENT_ROW], appointment_staff_working_hours: [HOUR], appointment_staff_time_off: [TIME_OFF],
    appointments: [APPOINTMENT],
    create_appointment_staff: STAFF_ROW, create_appointment_service: SERVICE_ROW, create_appointment_resource: RESOURCE_ROW,
    update_appointment_resource: { ...RESOURCE_ROW, is_active: false, version: 2 },
    replace_appointment_service_resource_requirements: { service_id: SERVICE, resource_version: 4, requirements: [{ kind: 'room', quantity: 1 }] },
    replace_appointment_staff_hours: { staff_id: STAFF, schedule_version: 2, timezone_name: 'Asia/Seoul', hours: [HOUR] },
    create_appointment_staff_time_off: TIME_OFF,
    cancel_appointment_staff_time_off: { ...TIME_OFF, status: 'canceled', version: 2 },
    save_appointment_with_resources: APPOINTMENT,
    ...overrides,
  };
  return { body: table[name(call)] ?? null };
};

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });
function setup(reply: (call: FakeCall) => FakeReply = supabase(), role: Role = 'owner', features = ['task.basic']) {
  const { fetcher, calls } = fakeFetch(reply);
  const organizations = fakeOrganizations(role, features);
  app = buildApp((instance) => registerAppointmentResourceModule(instance, organizations, testConfig, fetcher));
  const send = (method: 'GET' | 'POST' | 'PUT', path: string, payload?: unknown) => app.inject({ method, url: `/api/v1/organizations/${ORG}/${path}`, headers: auth, payload: payload as never });
  return { send, calls, organizations };
}
const op = (extra: Record<string, unknown> = {}) => ({ ...extra, operation_id: OP });

describe('공간·장비 자원', () => {
  it('member도 목록을 읽을 수 있다', async () => {
    const { send, calls, organizations } = setup(undefined, 'member');
    const response = await send('GET', 'appointment-resources');
    expect(response.statusCode).toBe(200);
    expect(response.json()[0].kind).toBe('room');
    expect(calls[0].url.pathname).toBe('/rest/v1/appointment_resources');
    expect(calls[0].url.searchParams.get('organization_id')).toBe(`eq.${ORG}`);
    expect(calls[0].headers.Authorization).toBe('Bearer user-token');
    expect(organizations.calls).toEqual([{ feature: 'task.basic', write: false }]);
  });

  it('생성은 관리자만 하고 멱등 키와 이름·구분을 RPC에 넘긴다', async () => {
    const { send, calls } = setup();
    const response = await send('POST', 'appointment-resources', op({ name: ' 관리실 1 ', kind: 'room' }));
    expect(response.statusCode).toBe(201);
    expect(calls[0].body).toEqual({ p_organization_id: ORG, p_name: '관리실 1', p_kind: 'room', p_operation_id: OP });
    const denied = setup(undefined, 'member');
    expect((await denied.send('POST', 'appointment-resources', op({ name: '장비', kind: 'equipment' }))).statusCode).toBe(403);
    expect(denied.calls).toHaveLength(0);
  });

  it('수정은 expected_version을 넘기고 member는 거부된다', async () => {
    const update = op({ name: '관리실 1', is_active: false, expected_version: 1 });
    const { send, calls } = setup();
    const response = await send('PUT', `appointment-resources/${RESOURCE}`, update);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ is_active: false, version: 2 });
    expect(calls[0].body).toEqual({ p_organization_id: ORG, p_resource_id: RESOURCE, p_name: '관리실 1', p_is_active: false, p_expected_version: 1, p_operation_id: OP });
    expect((await setup(undefined, 'member').send('PUT', `appointment-resources/${RESOURCE}`, update)).statusCode).toBe(403);
  });

  it('수정 응답의 자원 ID가 다르면 닫힌 실패(503)다', async () => {
    const { send } = setup(supabase({ update_appointment_resource: { ...RESOURCE_ROW, id: id(9) } }));
    expect((await send('PUT', `appointment-resources/${RESOURCE}`, op({ name: 'x', is_active: true, expected_version: 1 }))).statusCode).toBe(503);
  });

  it('잘못된 입력은 422이고 RPC에 닿지 않는다', async () => {
    const { send, calls } = setup();
    for (const bad of [op({ name: ' ', kind: 'room' }), op({ name: 'x', kind: 'vehicle' }), { name: 'x', kind: 'room' }, op({ name: 'x', kind: 'room', extra: 1 })]) {
      expect((await send('POST', 'appointment-resources', bad)).statusCode).toBe(422);
    }
    expect((await send('PUT', `appointment-resources/${RESOURCE}`, op({ name: 'x', is_active: 'no', expected_version: 1 }))).statusCode).toBe(422);
    expect((await send('PUT', `appointment-resources/${RESOURCE}`, op({ name: 'x', is_active: true, expected_version: 0 }))).statusCode).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it('다른 조직 행이나 중복 행이 섞인 응답은 503이다', async () => {
    expect((await setup(supabase({ appointment_resources: [{ ...RESOURCE_ROW, organization_id: OTHER_ORG }] })).send('GET', 'appointment-resources')).statusCode).toBe(503);
    expect((await setup(supabase({ appointment_resources: [RESOURCE_ROW, RESOURCE_ROW] })).send('GET', 'appointment-resources')).statusCode).toBe(503);
  });

  it('200건을 넘는 목록은 페이지를 이어 읽는다', async () => {
    const make = (n: number) => ({ ...RESOURCE_ROW, id: `${String(n).padStart(8, '0')}-8e8c-4df8-a623-1f23a3a936bd` });
    const pages = [Array.from({ length: 200 }, (_, index) => make(index + 1)), [make(500)]];
    let page = 0;
    const { send, calls } = setup(() => {const current=page++;return {body:pages[current],headers:{'Content-Range':current===0?'0-199/201':'200-200/201'}};});
    const response = await send('GET', 'appointment-resources');
    expect(response.json()).toHaveLength(201);
    expect(calls.map((call) => call.url.searchParams.get('offset'))).toEqual(['0', '200']);
    expect(calls[0].url.searchParams.get('limit')).toBe('250');
  });

  it('충돌(P0001)은 409, 없음은 404, 검증은 422로 매핑한다', async () => {
    for (const [code, status] of [['P0001', 409], ['P0002', 404], ['22023', 422]] as const) {
      const { send } = setup(() => ({ status: 400, body: { code, message: 'internal secret' } }));
      const response = await send('POST', 'appointment-resources', op({ name: 'x', kind: 'room' }));
      expect(response.statusCode).toBe(status);
      expect(response.body).not.toContain('secret');
    }
  });
});

describe('서비스별 필수 자원', () => {
  it('목록은 종류·수량만 돌려주고 member가 읽는다', async () => {
    const { send, calls } = setup(undefined, 'member');
    const response = await send('GET', `appointment-services/${SERVICE}/resource-requirements`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ kind: 'room', quantity: 1 }]);
    expect(calls[0].url.pathname).toBe('/rest/v1/appointment_service_resource_requirements');
    expect(calls[0].url.searchParams.get('service_id')).toBe(`eq.${SERVICE}`);
  });

  it('다른 서비스의 기준이 섞이면 503이다', async () => {
    expect((await setup(supabase({ appointment_service_resource_requirements: [{ ...REQUIREMENT_ROW, service_id: id(9) }] })).send('GET', `appointment-services/${SERVICE}/resource-requirements`)).statusCode).toBe(503);
  });

  it('기준과 낙관적 잠금 버전을 함께 읽는 보조 경로를 제공한다', async () => {
    const response = await setup().send('GET', `appointment-services/${SERVICE}/resource-setup`);
    expect(response.json()).toEqual({ service_id: SERVICE, resource_version: 3, requirements: [{ kind: 'room', quantity: 1 }] });
    expect((await setup(supabase({ appointment_services: [] })).send('GET', `appointment-services/${SERVICE}/resource-setup`)).statusCode).toBe(404);
  });

  it('저장은 관리자만 하고 expected_version과 멱등 키를 보낸다', async () => {
    const request = op({ requirements: [{ kind: 'room', quantity: 1 }], expected_version: 3 });
    const { send, calls } = setup();
    const response = await send('PUT', `appointment-services/${SERVICE}/resource-requirements`, request);
    expect(response.statusCode).toBe(200);
    expect(response.json().resource_version).toBe(4);
    expect(calls[0].body).toEqual({ p_organization_id: ORG, p_service_id: SERVICE, p_requirements: [{ kind: 'room', quantity: 1 }], p_expected_version: 3, p_operation_id: OP });
    expect((await setup(undefined, 'member').send('PUT', `appointment-services/${SERVICE}/resource-requirements`, request)).statusCode).toBe(403);
  });

  it('빈 기준(자원 불필요)도 저장할 수 있다', async () => {
    const { send, calls } = setup();
    expect((await send('PUT', `appointment-services/${SERVICE}/resource-requirements`, op({ requirements: [], expected_version: 1 }))).statusCode).toBe(200);
    expect((calls[0].body as { p_requirements: unknown }).p_requirements).toEqual([]);
  });

  it.each([
    ['수량 0', [{ kind: 'room', quantity: 0 }]],
    ['수량 11', [{ kind: 'room', quantity: 11 }]],
    ['수량이 불리언', [{ kind: 'room', quantity: true }]],
    ['중복 종류', [{ kind: 'room', quantity: 1 }, { kind: 'room', quantity: 2 }]],
    ['3개 항목', [{ kind: 'room', quantity: 1 }, { kind: 'equipment', quantity: 1 }, { kind: 'room', quantity: 1 }]],
    ['알 수 없는 종류', [{ kind: 'vehicle', quantity: 1 }]],
  ])('잘못된 기준(%s)은 422', async (_label, requirements) => {
    const { send, calls } = setup();
    expect((await send('PUT', `appointment-services/${SERVICE}/resource-requirements`, op({ requirements, expected_version: 1 }))).statusCode).toBe(422);
    expect(calls).toHaveLength(0);
  });
});

describe('담당자 근무시간과 휴무', () => {
  const hoursBody = (hours: unknown = [{ weekday: 4, start: '09:00', end: '18:00' }], extra: Record<string, unknown> = {}) => op({ timezone_name: 'Asia/Seoul', hours, expected_version: 1, ...extra });

  it('가용 정보는 담당자 버전, 근무시간, 진행 중 휴무를 돌려준다', async () => {
    const { send, calls } = setup(undefined, 'member');
    const response = await send('GET', `appointment-staff/${STAFF}/availability`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ staff_id: STAFF, schedule_version: 1, hours: [HOUR], time_off: [TIME_OFF] });
    expect(calls.map((call) => call.url.pathname)).toEqual(['/rest/v1/appointment_staff', '/rest/v1/appointment_staff_working_hours', '/rest/v1/appointment_staff_time_off']);
    expect(calls[0].url.searchParams.get('id')).toBe(`eq.${STAFF}`);
    expect(calls[1].url.searchParams.get('staff_id')).toBe(`eq.${STAFF}`);
    expect(calls[2].url.searchParams.get('status')).toBe('eq.active');
  });

  it('없는 담당자는 404', async () => {
    expect((await setup(supabase({ appointment_staff: [] })).send('GET', `appointment-staff/${STAFF}/availability`)).statusCode).toBe(404);
  });

  it('근무시간 교체는 HH:MM:SS로 정규화해 expected_version과 함께 보낸다', async () => {
    const { send, calls } = setup();
    const response = await send('PUT', `appointment-staff/${STAFF}/working-hours`, hoursBody());
    expect(response.statusCode).toBe(200);
    expect(response.json().schedule_version).toBe(2);
    expect(calls[0].body).toEqual({ p_organization_id: ORG, p_staff_id: STAFF, p_timezone_name: 'Asia/Seoul', p_hours: [{ weekday: 4, start: '09:00:00', end: '18:00:00' }], p_expected_version: 1, p_operation_id: OP });
    expect((await setup(undefined, 'member').send('PUT', `appointment-staff/${STAFF}/working-hours`, hoursBody())).statusCode).toBe(403);
  });

  it('시간대를 생략하면 Asia/Seoul이다', async () => {
    const { send, calls } = setup();
    await send('PUT', `appointment-staff/${STAFF}/working-hours`, op({ hours: [], expected_version: 1 }));
    expect((calls[0].body as { p_timezone_name: string }).p_timezone_name).toBe('Asia/Seoul');
  });

  it.each([
    ['종료가 시작보다 빠름', [{ weekday: 4, start: '18:00', end: '09:00' }]],
    ['시작과 종료가 같음', [{ weekday: 4, start: '09:00', end: '09:00' }]],
    ['요일 범위 밖', [{ weekday: 8, start: '09:00', end: '18:00' }]],
    ['요일 0', [{ weekday: 0, start: '09:00', end: '18:00' }]],
    ['시각 형식 오류', [{ weekday: 4, start: '9am', end: '18:00' }]],
    ['22개 항목', Array.from({ length: 22 }, () => ({ weekday: 1, start: '09:00', end: '10:00' }))],
  ])('잘못된 근무시간(%s)은 422', async (_label, hours) => {
    const { send, calls } = setup();
    expect((await send('PUT', `appointment-staff/${STAFF}/working-hours`, hoursBody(hours))).statusCode).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it('휴무 등록은 오프셋이 있는 증가 구간과 사유를 요구한다', async () => {
    const valid: Record<string, unknown> = op({ start_at: '2026-10-08T15:00:00+09:00', end_at: '2026-10-08T16:00:00+09:00', reason: ' 교육 ' });
    const { send, calls } = setup();
    const response = await send('POST', `appointment-staff/${STAFF}/time-off`, valid);
    expect(response.statusCode).toBe(201);
    expect(calls[0].body).toEqual({ p_organization_id: ORG, p_staff_id: STAFF, p_start_at: '2026-10-08T15:00:00+09:00', p_end_at: '2026-10-08T16:00:00+09:00', p_reason: '교육', p_operation_id: OP });
    expect((await setup(undefined, 'member').send('POST', `appointment-staff/${STAFF}/time-off`, valid)).statusCode).toBe(403);
    const invalid = [
      { ...valid, start_at: '2026-10-08T15:00:00' },
      { ...valid, end_at: '2026-10-08T14:00:00+09:00' },
      { ...valid, end_at: valid.start_at },
      { ...valid, reason: '  ' },
    ];
    const strict = setup();
    for (const bad of invalid) expect((await strict.send('POST', `appointment-staff/${STAFF}/time-off`, bad)).statusCode).toBe(422);
    expect(strict.calls).toHaveLength(0);
  });

  it('휴무 취소는 휴무·담당자 ID가 일치해야 한다', async () => {
    const request = op({ expected_version: 1 });
    const { send, calls } = setup();
    const response = await send('POST', `appointment-staff/${STAFF}/time-off/${LEAVE}/cancel`, request);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'canceled', version: 2 });
    expect(calls[0].body).toEqual({ p_organization_id: ORG, p_time_off_id: LEAVE, p_expected_version: 1, p_operation_id: OP });
    expect((await setup(supabase({ cancel_appointment_staff_time_off: { ...TIME_OFF, staff_id: id(9) } })).send('POST', `appointment-staff/${STAFF}/time-off/${LEAVE}/cancel`, request)).statusCode).toBe(503);
    expect((await setup(undefined, 'member').send('POST', `appointment-staff/${STAFF}/time-off/${LEAVE}/cancel`, request)).statusCode).toBe(403);
  });

  it('기존 예약과 충돌하는 변경은 409다', async () => {
    const { send } = setup(() => ({ status: 400, body: { code: 'P0001', message: 'conflict' } }));
    expect((await send('PUT', `appointment-staff/${STAFF}/working-hours`, hoursBody())).statusCode).toBe(409);
  });

  it('근무시간 응답에 다른 조직 행이 있으면 503', async () => {
    const bad = { staff_id: STAFF, schedule_version: 2, timezone_name: 'Asia/Seoul', hours: [{ ...HOUR, organization_id: OTHER_ORG }] };
    expect((await setup(supabase({ replace_appointment_staff_hours: bad })).send('PUT', `appointment-staff/${STAFF}/working-hours`, hoursBody())).statusCode).toBe(503);
  });
});

describe('담당자·서비스 생성', () => {
  it('관리자만 만들 수 있고 member와 기능 누락은 403이다', async () => {
    const { send, calls } = setup();
    expect((await send('POST', 'appointment-staff', { name: ' 담당자 ' })).statusCode).toBe(201);
    expect(calls[0].body).toEqual({ p_organization_id: ORG, p_name: '담당자' });
    expect((await send('POST', 'appointment-services', { name: '관리', duration_minutes: 60, buffer_minutes: 10 })).statusCode).toBe(201);
    expect(calls[1].body).toEqual({ p_organization_id: ORG, p_name: '관리', p_duration_minutes: 60, p_buffer_minutes: 10 });
    expect((await setup(undefined, 'member').send('POST', 'appointment-staff', { name: '담당자' })).statusCode).toBe(403);
    expect((await setup(undefined, 'owner', []).send('POST', 'appointment-staff', { name: '담당자' })).statusCode).toBe(403);
  });

  it('버퍼를 생략하면 0이고 범위를 벗어나면 422다', async () => {
    const { send, calls } = setup();
    await send('POST', 'appointment-services', { name: '관리', duration_minutes: 5 });
    expect((calls[0].body as { p_buffer_minutes: number }).p_buffer_minutes).toBe(0);
    for (const bad of [{ name: '관리', duration_minutes: 4 }, { name: '관리', duration_minutes: 481 }, { name: '관리', duration_minutes: 60, buffer_minutes: 121 }, { name: ' ', duration_minutes: 60 }, { name: '관리', duration_minutes: '60' }]) {
      expect((await send('POST', 'appointment-services', bad)).statusCode).toBe(422);
    }
    expect((await send('POST', 'appointment-staff', { name: ' ' })).statusCode).toBe(422);
    expect(calls).toHaveLength(1);
  });

  it('생성 응답의 조직이 다르면 503', async () => {
    expect((await setup(supabase({ create_appointment_staff: { ...STAFF_ROW, organization_id: OTHER_ORG } })).send('POST', 'appointment-staff', { name: 'x' })).statusCode).toBe(503);
  });
});

describe('인증', () => {
  it('토큰이 없으면 401, 잘못된 ID는 422', async () => {
    const { send } = setup();
    expect((await app.inject({ method: 'GET', url: `/api/v1/organizations/${ORG}/appointment-resources` })).statusCode).toBe(401);
    expect((await send('GET', 'appointment-staff/not-a-uuid/availability')).statusCode).toBe(422);
  });
});

/** Python test_supabase_appointments 이식: 예약 조회 범위·저장 페이로드(통합 단계에서 appointments 라우트가 사용). */
describe('예약 게이트웨이(자원 포함)', () => {
  const save = { customer_id: CUSTOMER, staff_id: STAFF, service_id: SERVICE, start_at: '2026-10-08T10:00:00+09:00', source: 'phone' as const, expected_version: null, operation_id: OP, resource_ids: [RESOURCE] };

  it('조회는 조직과 한국 시간 기간으로 제한된다', async () => {
    const { fetcher, calls } = fakeFetch(() => ({ body: [] }));
    const gateway = createAppointmentResourceGateway(testConfig, fetcher);
    expect(await gateway.listAppointments('user-token', ORG, { fromDate: '2026-10-01', toDate: '2026-10-31' })).toEqual([]);
    expect(calls).toHaveLength(1);
    const query = calls[0].url.searchParams;
    expect(query.get('organization_id')).toBe(`eq.${ORG}`);
    expect(query.get('and')).toBe('(start_at.gte.2026-10-01T00:00:00+09:00,start_at.lt.2026-11-01T00:00:00+09:00)');
    expect(calls[0].headers.Authorization).toBe('Bearer user-token');
  });

  it('기간을 생략하면 한국 날짜 기준 -7일 ~ +60일이고 고객 필터를 붙일 수 있다', async () => {
    const { fetcher, calls } = fakeFetch(() => ({ body: [] }));
    const gateway = createAppointmentResourceGateway(testConfig, fetcher, () => new Date('2026-10-12T16:00:00Z'));
    await gateway.listAppointments('t', ORG, { customerId: CUSTOMER });
    expect(calls[0].url.searchParams.get('and')).toBe('(start_at.gte.2026-10-06T00:00:00+09:00,start_at.lt.2026-12-13T00:00:00+09:00)');
    expect(calls[0].url.searchParams.get('customer_id')).toBe(`eq.${CUSTOMER}`);
  });

  it('다른 조직 예약이 섞이면 닫힌 실패다', async () => {
    const { fetcher } = fakeFetch(() => ({ body: [{ ...APPOINTMENT, organization_id: OTHER_ORG }] }));
    await expect(createAppointmentResourceGateway(testConfig, fetcher).listAppointments('t', ORG)).rejects.toMatchObject({ status: 503 });
  });

  it('저장은 save_appointment_with_resources에 p_resource_ids를 포함한다', async () => {
    const { fetcher, calls } = fakeFetch(() => ({ body: APPOINTMENT }));
    const saved = await createAppointmentResourceGateway(testConfig, fetcher).saveAppointment('t', ORG, null, save);
    expect(saved.resource_ids).toEqual([RESOURCE]);
    expect(calls[0].url.pathname).toBe('/rest/v1/rpc/save_appointment_with_resources');
    expect(calls[0].body).toEqual({
      p_organization_id: ORG, p_appointment_id: null, p_customer_id: CUSTOMER, p_staff_id: STAFF, p_service_id: SERVICE, p_start_at: '2026-10-08T10:00:00+09:00',
      p_source: 'phone', p_expected_version: null, p_operation_id: OP, p_resource_ids: [RESOURCE],
    });
  });

  it('수정 응답의 예약 ID가 다르면 닫힌 실패다', async () => {
    const { fetcher } = fakeFetch(() => ({ body: { ...APPOINTMENT, id: id(9) } }));
    await expect(createAppointmentResourceGateway(testConfig, fetcher).saveAppointment('t', ORG, APPT_ID, { ...save, expected_version: 1 })).rejects.toMatchObject({ status: 503 });
  });

  it('자원 충돌(P0001)은 409로 매핑한다', async () => {
    const { fetcher } = fakeFetch(() => ({ status: 400, body: { code: 'P0001', message: 'Resource conflict' } }));
    await expect(createAppointmentResourceGateway(testConfig, fetcher).saveAppointment('t', ORG, null, save)).rejects.toMatchObject({ status: 409 });
  });
});
