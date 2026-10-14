import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';

const organizationId = 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const taskId = 'b9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const headers = { authorization: 'Bearer access' };
const base = `/api/v1/organizations/${organizationId}/tasks`;

function fixture() {
  const calls: Array<{ kind: string; input?: Record<string, unknown> }> = [];
  const organizations = { requireAccess: async (_token: string, _organizationId: string, feature: string) => { expect(feature).toBe('task.basic'); return 'owner'; } };
  const tasks = {
    list: async () => [],
    create: async (_t: string, _o: string, input: Record<string, unknown>) => { calls.push({ kind: 'create', input }); return { id: taskId, organization_id: organizationId, created_by: organizationId, status: 'open', ...input }; },
    update: async (_t: string, _o: string, _id: string, input: Record<string, unknown>) => { calls.push({ kind: 'update', input }); return { id: taskId, organization_id: organizationId, created_by: organizationId, title: 't', description: 'd', due_at: null, status: 'open', priority: 'normal', labels: [], checklist: [], ...input }; },
    remove: async () => true,
  };
  return { app: createApp({ organizations: organizations as never, tasks: tasks as never }), calls };
}

describe('task routes', () => {
  it('상태만 바꾸는 PATCH는 설명·기한·우선순위·라벨·체크리스트를 기본값으로 덮어쓰지 않는다', async () => {
    const { app, calls } = fixture();
    const result = await app.inject({ method: 'PATCH', url: `${base}/${taskId}`, headers, payload: { status: 'done' } });
    expect(result.statusCode).toBe(200);
    expect(calls).toEqual([{ kind: 'update', input: { status: 'done' } }]);
    await app.close();
  });

  it('기한만 바꾸거나 체크리스트만 바꿔도 보낸 필드만 갱신한다', async () => {
    const { app, calls } = fixture();
    await app.inject({ method: 'PATCH', url: `${base}/${taskId}`, headers, payload: { due_at: null } });
    await app.inject({ method: 'PATCH', url: `${base}/${taskId}`, headers, payload: { checklist: [{ id: 'a', text: '확인', done: true }] } });
    expect(calls.map((call) => call.input)).toEqual([{ due_at: null }, { checklist: [{ id: 'a', text: '확인', done: true }] }]);
    await app.close();
  });

  it('빈 PATCH와 알 수 없는 필드는 거절한다', async () => {
    const { app, calls } = fixture();
    expect((await app.inject({ method: 'PATCH', url: `${base}/${taskId}`, headers, payload: {} })).statusCode).toBe(422);
    expect((await app.inject({ method: 'PATCH', url: `${base}/${taskId}`, headers, payload: { created_by: taskId } })).statusCode).toBe(422);
    expect(calls).toEqual([]);
    await app.close();
  });

  it('생성할 때는 기본값을 채우고 라벨·체크리스트를 받는다', async () => {
    const { app, calls } = fixture();
    const result = await app.inject({ method: 'POST', url: base, headers, payload: { title: '월말 정리', labels: ['재고', '월말'], checklist: [{ id: 'a', text: '상자', done: false }] } });
    expect(result.statusCode).toBe(200);
    expect(calls[0].input).toEqual({ title: '월말 정리', description: '', due_at: null, priority: 'normal', labels: ['재고', '월말'], checklist: [{ id: 'a', text: '상자', done: false }], recurrence: null, customer_id: null });
    const bare = await app.inject({ method: 'POST', url: base, headers, payload: { title: '기본' } });
    expect(bare.statusCode).toBe(200);
    expect(calls[1].input).toMatchObject({ labels: [], checklist: [] });
    await app.close();
  });

  it('라벨·체크리스트 한도와 형식을 검사한다', async () => {
    const { app, calls } = fixture();
    const post = (payload: unknown) => app.inject({ method: 'POST', url: base, headers, payload: payload as never });
    expect((await post({ title: 'x', labels: Array.from({ length: 11 }, (_, i) => `l${i}`) })).statusCode).toBe(422);
    expect((await post({ title: 'x', labels: ['중복', '중복'] })).statusCode).toBe(422);
    expect((await post({ title: 'x', labels: ['가'.repeat(31)] })).statusCode).toBe(422);
    expect((await post({ title: 'x', checklist: Array.from({ length: 51 }, (_, i) => ({ id: String(i), text: 't', done: false })) })).statusCode).toBe(422);
    expect((await post({ title: 'x', checklist: [{ id: 'a', text: '', done: false }] })).statusCode).toBe(422);
    expect((await post({ title: 'x', checklist: [{ id: 'a', text: 't', done: 'yes' }] })).statusCode).toBe(422);
    expect(calls).toEqual([]);
    await app.close();
  });
});

describe('task recurrence and customer link (048)', () => {
  const customerId = 'c9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
  it('accepts recurrence with a due date and a customer link on create', async () => {
    const { app, calls } = fixture();
    const result = await app.inject({ method: 'POST', url: base, headers, payload: { title: '정기 점검', due_at: '2026-10-20T01:00:00Z', recurrence: 'weekly', customer_id: customerId } });
    expect(result.statusCode).toBe(200);
    expect(calls[0].input).toMatchObject({ recurrence: 'weekly', customer_id: customerId, due_at: '2026-10-20T01:00:00Z' });
    await app.close();
  });

  it('defaults to no recurrence and no customer, and rejects recurrence without a due date', async () => {
    const { app, calls } = fixture();
    await app.inject({ method: 'POST', url: base, headers, payload: { title: '기본' } });
    expect(calls[0].input).toMatchObject({ recurrence: null, customer_id: null });
    expect((await app.inject({ method: 'POST', url: base, headers, payload: { title: 'x', recurrence: 'daily' } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: base, headers, payload: { title: 'x', due_at: '2026-10-20T01:00:00Z', recurrence: 'yearly' } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: base, headers, payload: { title: 'x', customer_id: 'not-a-uuid' } })).statusCode).toBe(422);
    expect(calls).toHaveLength(1);
    await app.close();
  });

  it('patches recurrence and customer alone, including clearing them', async () => {
    const { app, calls } = fixture();
    await app.inject({ method: 'PATCH', url: `${base}/${taskId}`, headers, payload: { recurrence: 'monthly' } });
    await app.inject({ method: 'PATCH', url: `${base}/${taskId}`, headers, payload: { recurrence: null, customer_id: null } });
    expect(calls.map((call) => call.input)).toEqual([{ recurrence: 'monthly' }, { recurrence: null, customer_id: null }]);
    await app.close();
  });
});
