import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../app.js';
import { createOrganizationGateway } from '../supabase/organizations.js';
import { fakeFetch, ORG, testConfig } from '../modules/catalog/testkit.js';
import type { AuditEvent, AuditRecorder } from './recorder.js';

const USER = 'b9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const TARGET = 'c9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const headers = { authorization: 'Bearer access' };

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

function setup(rpcStatus = 200) {
  const events: AuditEvent[] = [];
  const audit: AuditRecorder = { record: async (_token, event) => { events.push(event); }, recordRequired: async (_token, event) => { events.push(event); } };
  const { fetcher } = fakeFetch((call) => {
    if (call.url.pathname === '/auth/v1/user') return { body: { id: USER } };
    return { status: rpcStatus, body: rpcStatus === 200 ? { user_id: TARGET, role: 'admin', removed: true } : { message: 'last_owner' } };
  });
  app = createApp({ organizations: createOrganizationGateway(testConfig, fetcher), audit });
  return events;
}
const url = (suffix = '') => `/api/v1/organizations/${ORG}/members${suffix}`;

describe('구성원 변경 감사 기록', () => {
  it('추가·역할 변경·제거를 member.* 로 기록하고 이메일은 남기지 않는다', async () => {
    const events = setup();
    await app.inject({ method: 'POST', url: url(), headers, payload: { email: 'new@example.com', role: 'admin' } });
    await app.inject({ method: 'PATCH', url: url(`/${TARGET}`), headers, payload: { role: 'admin' } });
    await app.inject({ method: 'DELETE', url: url(`/${TARGET}`), headers });
    expect(events.map((event) => [event.action, event.targetType, event.targetId])).toEqual([
      ['member.add', 'member', null], ['member.role_change', 'member', TARGET], ['member.remove', 'member', TARGET],
    ]);
    expect(events[0].metadata).toEqual({ role: 'admin' });
    expect(events[1].metadata).toEqual({ role: 'admin' });
    expect(JSON.stringify(events)).not.toContain('new@example.com');
    expect(events.every((event) => event.organizationId === ORG)).toBe(true);
  });

  it('실패한 요청(예: 마지막 owner 보호)은 기록하지 않는다', async () => {
    const events = setup(400);
    const response = await app.inject({ method: 'DELETE', url: url(`/${TARGET}`), headers });
    expect(response.statusCode).toBe(409);
    expect(events).toEqual([]);
  });
});
