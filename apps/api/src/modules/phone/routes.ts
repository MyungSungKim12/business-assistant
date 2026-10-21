import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiFailure } from '../../errors.js';
import { bearerToken } from '../../routes/organizations.js';
import { decodeCursor, encodeCursor } from '../../routes/customers.js';
import type { CustomerGateway } from '../../supabase/customers.js';
import type { CustomerActivityGateway } from '../../supabase/customer-activities.js';
import { normalizePhoneNumber } from './phone.js';

const orgParams = z.object({ organizationId: z.uuid() });
const PAGE_SIZE = 200;
const memoInput = z.object({ customer_id: z.uuid(), phone: z.string().trim().min(1).max(40), memo: z.string().trim().min(1).max(10_000), occurred_at: z.iso.datetime({ offset: true }).nullable().default(null) }).strict();

type OrgAccess = Pick<{ requireAccess(token: string, id: string, feature: string, write?: boolean): Promise<string> }, 'requireAccess'>;

export function registerPhoneRoutes(app: FastifyInstance, organizations: OrgAccess | undefined, customers: CustomerGateway | undefined, activities: CustomerActivityGateway | undefined): void {
  function context(request: FastifyRequest) {
    const token = bearerToken(request);
    const params = orgParams.safeParse(request.params);
    if (!organizations || !customers?.search || !activities) throw new ApiFailure(503, 'Phone companion unavailable');
    if (!params.success) throw new ApiFailure(422, 'Invalid organization ID');
    return { token, organizationId: params.data.organizationId };
  }

  async function exactMatches(token: string, organizationId: string, rawPhone: string) {
    const normalized = normalizePhoneNumber(rawPhone);
    if (!normalized) throw new ApiFailure(422, 'Invalid caller number');
    const digits = normalized.replace(/\D/g, '');
    const result = await customers!.search!(token, organizationId, { q: digits, status: 'active', sort: 'name', direction: 'asc', limit: PAGE_SIZE, offset: 0 });
    const matches = result.items.filter(customer => customer.organization_id === organizationId && customer.status === 'active' && normalizePhoneNumber(customer.phone) === normalized)
      .map(({ id, name, phone }) => ({ customer_id: id, name, phone: phone!, phone_e164: normalized }));
    return { normalized, matches };
  }

  app.get('/api/v1/organizations/:organizationId/mobile/phone-directory', async request => {
    const current = context(request);
    const query = z.object({ cursor: z.string().max(64).optional() }).strict().safeParse(request.query);
    if (!query.success) throw new ApiFailure(422, 'Invalid phone directory cursor');
    const offset = decodeCursor(query.data.cursor);
    if (offset === undefined) throw new ApiFailure(422, 'Invalid phone directory cursor');
    await organizations!.requireAccess(current.token, current.organizationId, 'crm.basic');
    const page = await customers!.search!(current.token, current.organizationId, { q: '', status: 'active', sort: 'name', direction: 'asc', limit: PAGE_SIZE, offset });
    const items = page.items.flatMap(({ id, organization_id: rowOrganizationId, status, name, phone }) => {
      if (rowOrganizationId !== current.organizationId || status !== 'active') return [];
      const phoneE164 = normalizePhoneNumber(phone);
      return phoneE164 ? [{ customer_id: id, name, phone: phone!, phone_e164: phoneE164 }] : [];
    });
    const nextOffset = offset + page.items.length;
    return { items, next_cursor: nextOffset < page.total && page.items.length > 0 ? encodeCursor(nextOffset) : null };
  });

  app.post('/api/v1/organizations/:organizationId/mobile/phone-identification', async request => {
    const current = context(request);
    const input = z.object({ number: z.string().trim().min(1).max(40) }).strict().safeParse(request.body);
    if (!input.success) throw new ApiFailure(422, 'Invalid caller number');
    await organizations!.requireAccess(current.token, current.organizationId, 'crm.basic');
    const result = await exactMatches(current.token, current.organizationId, input.data.number);
    return { phone_e164: result.normalized, matches: result.matches };
  });

  app.post('/api/v1/organizations/:organizationId/mobile/phone-memos', async (request, reply) => {
    const current = context(request);
    const input = memoInput.safeParse(request.body);
    if (!input.success) throw new ApiFailure(422, 'Invalid call memo');
    await organizations!.requireAccess(current.token, current.organizationId, 'crm.basic');
    const exact = await exactMatches(current.token, current.organizationId, input.data.phone);
    const match = exact.matches.find(customer => customer.customer_id === input.data.customer_id);
    if (!match) throw new ApiFailure(404, 'Customer phone match not found');
    const created = await activities!.create(current.token, current.organizationId, match.customer_id, {
      activity_type: 'phone_call', title: '전화 상담', description: input.data.memo, occurred_at: input.data.occurred_at,
    });
    return reply.code(201).send(created);
  });
}
