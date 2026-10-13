import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { ServerConfig } from '../config.js';

const organizationId = 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const config: ServerConfig = { APP_SUPABASE_URL: 'https://example.supabase.co', APP_SUPABASE_PUBLISHABLE_KEY: 'key', APP_FILE_BUCKET: 'business-files', APP_API_PORT: 8000 };
const headers = { authorization: 'Bearer access' };

describe('module registration', () => {
  it('registers every converted module when a config is supplied', async () => {
    const app = createApp({ config });
    const paths = [
      'catalog-products', 'document-templates', 'files', 'finance-transactions', 'visits', 'treatment-sale-drafts', 'appointment-resources', 'management-preview',
    ];
    for (const path of paths) {
      const response = await app.inject({ url: `/api/v1/organizations/${organizationId}/${path}` });
      expect(response.statusCode, path).not.toBe(404);
    }
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/organizations/${organizationId}/subscription` })).statusCode).not.toBe(404);
    await app.close();
  });
});

describe('appointment rules carried over from the Python server', () => {
  const access = (role: 'owner' | 'member') => ({ requireAccess: vi.fn(async (_t: string, _o: string, _f: string, write?: boolean) => { if (write && role === 'member') throw new Error('forbidden'); return role; }) });

  it('rejects a half-open or reversed list range and allows members to read', async () => {
    const appointments = { list: vi.fn(async () => []) };
    const app = createApp({ organizations: access('member') as never, appointments: appointments as never });
    const base = `/api/v1/organizations/${organizationId}/appointments`;
    expect((await app.inject({ url: `${base}?from_date=2026-10-01`, headers })).statusCode).toBe(422);
    expect((await app.inject({ url: `${base}?from_date=2026-10-10&to_date=2026-10-01`, headers })).statusCode).toBe(422);
    expect((await app.inject({ url: `${base}?from_date=2026-01-01&to_date=2027-06-01`, headers })).statusCode).toBe(422);
    expect((await app.inject({ url: `${base}?from_date=2026-10-01&to_date=2026-10-31`, headers })).statusCode).toBe(200);
    expect(appointments.list).toHaveBeenCalledWith('access', organizationId, { customerId: undefined, fromDate: '2026-10-01', toDate: '2026-10-31' });
    await app.close();
  });

  it('lets members create appointments with resource ids but rejects duplicate resources', async () => {
    const saved = vi.fn(async (_t: string, _o: string, _id: string | null, _input: object) => ({ id: 'x' }));
    const app = createApp({ organizations: access('member') as never, appointments: { save: saved } as never });
    const body = { customer_id: organizationId, staff_id: organizationId, service_id: organizationId, start_at: '2026-10-13T01:00:00+09:00', operation_id: organizationId };
    const url = `/api/v1/organizations/${organizationId}/appointments`;
    expect((await app.inject({ method: 'POST', url, headers, payload: { ...body, resource_ids: [organizationId, organizationId] } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url, headers, payload: { ...body, resource_ids: [organizationId] } })).statusCode).toBe(201);
    expect(saved.mock.calls[0][3]).toMatchObject({ resource_ids: [organizationId] });
    await app.close();
  });
});

describe('organizations', () => {
  it('creates an organization and reports the missing feature code', async () => {
    const organizations = {
      create: vi.fn(async (_t: string, name: string, slug: string) => ({ id: organizationId, name, slug, role: 'owner' })),
      list: vi.fn(),
    };
    const app = createApp({ organizations: organizations as never });
    const created = await app.inject({ method: 'POST', url: '/api/v1/organizations', headers, payload: { name: '새 매장', slug: 'new-shop' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ slug: 'new-shop', role: 'owner' });
    expect((await app.inject({ method: 'POST', url: '/api/v1/organizations', headers, payload: { name: '' } })).statusCode).toBe(422);
    await app.close();
  });
});

describe('sign-up', () => {
  const body = { email: 'new@example.com', password: 'long-enough-password', display_name: '신규 원장' };
  const session = { accessToken: 'a', refreshToken: 'r', user: { userId: organizationId, email: body.email, displayName: body.display_name } };

  it('returns a session when no email confirmation is required', async () => {
    const app = createApp({ auth: { signIn: vi.fn(), signUp: vi.fn(async () => session) } });
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: body });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ access_token: 'a', email_confirmation_required: false, user: { display_name: '신규 원장' } });
    await app.close();
  });

  it('asks for email confirmation without a session and rejects short passwords', async () => {
    const app = createApp({ auth: { signIn: vi.fn(), signUp: vi.fn(async () => null) } });
    const confirmation = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: body });
    expect(confirmation.json()).toEqual({ email_confirmation_required: true });
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { ...body, password: 'short' } })).statusCode).toBe(422);
    await app.close();
  });
});
