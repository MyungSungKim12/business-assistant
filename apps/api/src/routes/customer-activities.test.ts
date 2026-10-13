import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';

const organizationId = 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const customerId = 'c9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const activityId = 'd9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const activity = { id: activityId, organization_id: organizationId, customer_id: customerId, activity_type: 'note', title: '상담 완료', description: '자극 주의', occurred_at: '2026-10-13T00:00:00Z' };

function fixture() {
  const writes: boolean[] = [];
  const organizations = { requireAccess: async (_token: string, _organizationId: string, feature: string, write = false) => { expect(feature).toBe('crm.basic'); writes.push(write); return 'owner'; } };
  const activities = {
    list: async () => [activity],
    create: async (_token: string, _organizationId: string, _customerId: string, input: { title: string }) => ({ ...activity, ...input }),
    remove: async (_token: string, _organizationId: string, _customerId: string, id: string) => id === activityId,
  };
  return { app: createApp({ organizations: organizations as never, activities }), writes };
}

describe('customer activity HTTP flow', () => {
  it('lists activity records only for the selected organization and customer', async () => {
    const { app, writes } = fixture();
    const result = await app.inject({ url: `/api/v1/organizations/${organizationId}/customers/${customerId}/activities`, headers: { authorization: 'Bearer access' } });
    expect(result.statusCode).toBe(200); expect(result.json()).toEqual([activity]); expect(writes).toEqual([false]);
    await app.close();
  });

  it('creates a plain-text activity with management permission', async () => {
    const { app, writes } = fixture();
    const result = await app.inject({ method: 'POST', url: `/api/v1/organizations/${organizationId}/customers/${customerId}/activities`, headers: { authorization: 'Bearer access' }, payload: { activity_type: 'note', title: '추가 상담', description: '<b>HTML이 아닌 텍스트</b>', occurred_at: '2026-10-13T01:00:00Z' } });
    expect(result.statusCode).toBe(201); expect(result.json()).toMatchObject({ organization_id: organizationId, customer_id: customerId, title: '추가 상담', description: '<b>HTML이 아닌 텍스트</b>' }); expect(writes).toEqual([true]);
    await app.close();
  });

  it('does not delete an activity outside the requested customer', async () => {
    const { app, writes } = fixture();
    const result = await app.inject({ method: 'DELETE', url: `/api/v1/organizations/${organizationId}/customers/${customerId}/activities/e9cc39fd-8e8c-4df8-a623-1f23a3a936bd`, headers: { authorization: 'Bearer access' } });
    expect(result.statusCode).toBe(404); expect(writes).toEqual([true]);
    await app.close();
  });
});
