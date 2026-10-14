import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auth, buildApp, fakeFetch, fakeOrganizations, ORG, OTHER_ORG, testConfig, type FakeCall, type FakeReply, type Role } from '../catalog/testkit.js';
import { registerAppointmentResourceModule } from './index.js';

const id = (n: number) => `${n}a9c39fd-8e8c-4df8-a623-1f23a3a936bd`;
const STAFF_A = id(1), STAFF_B = id(2), SERVICE = id(3), OTHER_SERVICE = id(4);
const SERVICE_ROW = { id: SERVICE, organization_id: ORG, name: '관리', duration_minutes: 60, buffer_minutes: 10, is_active: true, resource_version: 1 };
const name = (call: FakeCall) => call.url.pathname.split('/').pop() ?? '';

const supabase = (overrides: Record<string, unknown> = {}) => (call: FakeCall): FakeReply => {
  const table: Record<string, unknown> = {
    appointment_services: [SERVICE_ROW],
    appointment_service_staff: [
      { organization_id: ORG, service_id: SERVICE, staff_id: STAFF_A },
      { organization_id: ORG, service_id: SERVICE, staff_id: STAFF_B },
    ],
    set_appointment_service_staff: [STAFF_A],
    ...overrides,
  };
  return { body: table[name(call)] ?? null };
};

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });
function setup(reply: (call: FakeCall) => FakeReply = supabase(), role: Role = 'owner') {
  const { fetcher, calls } = fakeFetch(reply);
  const organizations = fakeOrganizations(role, ['task.basic']);
  app = buildApp((instance) => registerAppointmentResourceModule(instance, organizations, testConfig, fetcher));
  const send = (method: 'GET' | 'PUT', path: string, payload?: unknown) => app.inject({ method, url: `/api/v1/organizations/${ORG}/${path}`, headers: auth, payload: payload as never });
  return { send, calls, organizations };
}

describe('서비스별 담당 가능 직원 (SVC-11)', () => {
  it('전체 목록은 service_id·staff_id만 돌려주고 member도 읽는다', async () => {
    const { send, calls, organizations } = setup(undefined, 'member');
    const response = await send('GET', 'appointment-service-staff');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ service_id: SERVICE, staff_id: STAFF_A }, { service_id: SERVICE, staff_id: STAFF_B }]);
    expect(calls[0].url.pathname).toBe('/rest/v1/appointment_service_staff');
    expect(calls[0].url.searchParams.get('organization_id')).toBe(`eq.${ORG}`);
    expect(organizations.calls).toEqual([{ feature: 'task.basic', write: false }]);
  });

  it('다른 조직 행이 섞인 응답은 닫힌 실패(503)다', async () => {
    const { send } = setup(supabase({ appointment_service_staff: [{ organization_id: OTHER_ORG, service_id: SERVICE, staff_id: STAFF_A }] }));
    expect((await send('GET', 'appointment-service-staff')).statusCode).toBe(503);
  });

  it('서비스 한 개의 직원 ID 목록을 읽고 없는 서비스는 404다', async () => {
    const { send } = setup(supabase({ appointment_service_staff: [{ organization_id: ORG, service_id: SERVICE, staff_id: STAFF_B }] }));
    const response = await send('GET', `appointment-services/${SERVICE}/staff`);
    expect(response.json()).toEqual({ staff_ids: [STAFF_B] });
    expect((await send('GET', `appointment-services/${OTHER_SERVICE}/staff`)).statusCode).toBe(404);
  });

  it('다른 서비스 행이 섞이면 503이다', async () => {
    const { send } = setup(supabase({ appointment_service_staff: [{ organization_id: ORG, service_id: OTHER_SERVICE, staff_id: STAFF_A }] }));
    expect((await send('GET', `appointment-services/${SERVICE}/staff`)).statusCode).toBe(503);
  });

  it('저장은 관리자만 하고 RPC에 직원 ID 배열을 그대로 넘긴다', async () => {
    const { send, calls, organizations } = setup();
    const response = await send('PUT', `appointment-services/${SERVICE}/staff`, { staff_ids: [STAFF_A] });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ staff_ids: [STAFF_A] });
    const rpc = calls.find((call) => name(call) === 'set_appointment_service_staff')!;
    expect(rpc.body).toEqual({ p_organization_id: ORG, p_service_id: SERVICE, p_staff_ids: [STAFF_A] });
    expect(organizations.calls.at(-1)).toEqual({ feature: 'task.basic', write: true });
  });

  it('빈 배열로 제한을 풀 수 있다', async () => {
    const { send } = setup(supabase({ set_appointment_service_staff: [] }));
    const response = await send('PUT', `appointment-services/${SERVICE}/staff`, { staff_ids: [] });
    expect(response.json()).toEqual({ staff_ids: [] });
  });

  it('member의 저장은 거부되고 RPC에 닿지 않는다', async () => {
    const { send, calls } = setup(undefined, 'member');
    expect((await send('PUT', `appointment-services/${SERVICE}/staff`, { staff_ids: [STAFF_A] })).statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('잘못된 입력(중복, ID 형식, 알 수 없는 필드, 101명)은 422이고 RPC에 닿지 않는다', async () => {
    const { send, calls } = setup();
    const put = (payload: unknown) => send('PUT', `appointment-services/${SERVICE}/staff`, payload);
    expect((await put({ staff_ids: [STAFF_A, STAFF_A] })).statusCode).toBe(422);
    expect((await put({ staff_ids: ['not-a-uuid'] })).statusCode).toBe(422);
    expect((await put({ staff_ids: [], extra: 1 })).statusCode).toBe(422);
    expect((await put({ staff_ids: Array.from({ length: 101 }, (_, i) => `${String(i).padStart(8, '0')}-8e8c-4df8-a623-1f23a3a936bd`) })).statusCode).toBe(422);
    expect((await send('PUT', 'appointment-services/not-a-uuid/staff', { staff_ids: [] })).statusCode).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it('DB 검증 실패는 422, 서비스 없음은 404로 매핑한다', async () => {
    const failing = (code: string) => (call: FakeCall): FakeReply => (name(call) === 'set_appointment_service_staff' ? { status: 400, body: { code, message: 'x' } } : supabase()(call));
    expect((await setup(failing('22023')).send('PUT', `appointment-services/${SERVICE}/staff`, { staff_ids: [STAFF_A] })).statusCode).toBe(422);
    await app.close();
    expect((await setup(failing('P0002')).send('PUT', `appointment-services/${SERVICE}/staff`, { staff_ids: [STAFF_A] })).statusCode).toBe(404);
  });
});
