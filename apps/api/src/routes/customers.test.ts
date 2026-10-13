import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';

const organizationId = 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const customerId = 'c9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const customer = {
  id: customerId,
  organization_id: organizationId,
  name: '김고객',
  email: null,
  phone: '010-1234-5678',
  notes: '',
  birth_date: null,
  skin_type: null,
  concerns: [],
  allergies: '',
  last_visit_date: null,
  next_visit_date: null,
  tags: ['재방문'],
  status: 'active',
};

function fixture() {
  const accessCalls: boolean[] = [];
  const access = { requireAccess: async (token: string, id: string, feature: string, write = false) => {
    expect(token).toBe('access');
    expect(id).toBe(organizationId);
    expect(feature).toBe('crm.basic');
    accessCalls.push(write);
    return 'owner';
  } };
  const customers = {
    list: async () => [customer],
    create: async (_token: string, _organizationId: string, input: { name: string }) => ({ ...customer, ...input }),
    update: async (_token: string, _organizationId: string, id: string, patch: { name?: string }) => id === customerId ? { ...customer, ...patch } : null,
  };
  return { app: createApp({ organizations: access as never, customers }), accessCalls };
}

describe('customer HTTP flow', () => {
  it('lists customers only after checking the CRM feature for the requested organization', async () => {
    const { app, accessCalls } = fixture();
    const result = await app.inject({ url: `/api/v1/organizations/${organizationId}/customers`, headers: { authorization: 'Bearer access' } });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual([customer]);
    expect(accessCalls).toEqual([false]);
    await app.close();
  });

  it('creates a customer under the route organization and never accepts an organization id from the body', async () => {
    const { app, accessCalls } = fixture();
    const result = await app.inject({
      method: 'POST', url: `/api/v1/organizations/${organizationId}/customers`, headers: { authorization: 'Bearer access' },
      payload: { ...customer, id: 'd9cc39fd-8e8c-4df8-a623-1f23a3a936bd', organization_id: 'e9cc39fd-8e8c-4df8-a623-1f23a3a936bd' },
    });
    expect(result.statusCode).toBe(422);
    expect(result.json().detail).toBe('Invalid customer input');
    await app.close();
  });

  it('updates only a customer that belongs to the requested organization', async () => {
    const { app, accessCalls } = fixture();
    const result = await app.inject({
      method: 'PATCH', url: `/api/v1/organizations/${organizationId}/customers/${customerId}`, headers: { authorization: 'Bearer access' }, payload: { name: '김수정' },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ id: customerId, organization_id: organizationId, name: '김수정' });
    expect(accessCalls).toEqual([true]);
    await app.close();
  });
});
