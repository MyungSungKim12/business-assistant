import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auth, buildApp, fakeFetch, fakeOrganizations, OP, ORG, testConfig, type FakeCall, type FakeReply, type Role } from '../catalog/testkit.js';
import { registerAppointmentResourceModule } from './index.js';

const id = (n: number) => `${n}a9c39fd-8e8c-4df8-a623-1f23a3a936bd`;
const SERVICE = id(2);
const SERVICE_ROW = { id: SERVICE, organization_id: ORG, name: '관리', duration_minutes: 60, buffer_minutes: 10, is_active: true, resource_version: 3 };
const UPDATED = { ...SERVICE_ROW, name: '레이저', duration_minutes: 45, buffer_minutes: 5, is_active: false, price_krw: 50000, category: '피부', service_version: 3 };
const update = { name: ' 레이저 ', duration_minutes: 45, buffer_minutes: 5, price_krw: 50000, category: ' 피부 ', is_active: false, expected_version: 2, operation_id: OP };

const table = (overrides: Record<string, unknown> = {}) => (call: FakeCall): FakeReply => {
  const rows: Record<string, unknown> = { appointment_services: [SERVICE_ROW], update_appointment_service: UPDATED, ...overrides };
  return { body: rows[call.url.pathname.split('/').pop() ?? ''] ?? null };
};

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });
function setup(reply = table(), role: Role = 'owner') {
  const { fetcher, calls } = fakeFetch(reply);
  app = buildApp((instance) => registerAppointmentResourceModule(instance, fakeOrganizations(role, ['task.basic']), testConfig, fetcher));
  const send = (method: 'GET' | 'PUT', path: string, payload?: unknown) => app.inject({ method, url: `/api/v1/organizations/${ORG}/${path}`, headers: auth, payload: payload as never });
  return { send, calls };
}

describe('서비스 수정·확장 목록(SVC-10)', () => {
  it('확장 목록은 가격·카테고리·편집 버전을 주고 구버전 행에는 기본값을 채운다', async () => {
    const extended = { ...SERVICE_ROW, id: id(9), price_krw: 30000, category: '바디', service_version: 4 };
    const response = await setup(table({ appointment_services: [SERVICE_ROW, extended] }), 'member').send('GET', 'appointment-service-details');
    expect(response.statusCode).toBe(200);
    expect(response.json()[0]).toMatchObject({ price_krw: 0, category: '', service_version: 1 });
    expect(response.json()[1]).toMatchObject({ price_krw: 30000, category: '바디', service_version: 4 });
  });

  it('수정은 공백을 정리해 RPC로 넘기고 관리자만 허용한다', async () => {
    const { send, calls } = setup();
    const response = await send('PUT', `appointment-services/${SERVICE}`, update);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ price_krw: 50000, category: '피부', service_version: 3, is_active: false });
    expect(calls[0].url.pathname).toBe('/rest/v1/rpc/update_appointment_service');
    expect(calls[0].body).toEqual({
      p_organization_id: ORG, p_service_id: SERVICE, p_name: '레이저', p_duration_minutes: 45, p_buffer_minutes: 5, p_price_krw: 50000,
      p_category: '피부', p_is_active: false, p_expected_version: 2, p_operation_id: OP,
    });
    const denied = setup(table(), 'member');
    expect((await denied.send('PUT', `appointment-services/${SERVICE}`, update)).statusCode).toBe(403);
    expect(denied.calls).toHaveLength(0);
  });

  it('카테고리는 비워도 되고 범위를 벗어난 값은 422이며 RPC에 닿지 않는다', async () => {
    const { send, calls } = setup();
    expect((await send('PUT', `appointment-services/${SERVICE}`, { ...update, category: '' })).statusCode).toBe(200);
    const bad: Record<string, unknown>[] = [
      { price_krw: -1 }, { price_krw: 1.5 }, { price_krw: '100' }, { category: 'x'.repeat(61) }, { duration_minutes: 4 }, { buffer_minutes: 121 },
      { name: ' ' }, { is_active: 'no' }, { expected_version: 0 }, { extra: 1 },
    ];
    for (const change of bad) expect((await send('PUT', `appointment-services/${SERVICE}`, { ...update, ...change })).statusCode).toBe(422);
    expect(calls).toHaveLength(1);
  });

  it('충돌은 409, 다른 서비스 응답은 503', async () => {
    expect((await setup(() => ({ status: 400, body: { code: 'P0001' } })).send('PUT', `appointment-services/${SERVICE}`, update)).statusCode).toBe(409);
    expect((await setup(table({ update_appointment_service: { ...UPDATED, id: id(9) } })).send('PUT', `appointment-services/${SERVICE}`, update)).statusCode).toBe(503);
  });
});
