import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiFailure } from '../../errors.js';
import { bearerToken } from '../../routes/organizations.js';
import { decodeCursor, encodeCursor } from '../../routes/customers.js';
import type { CustomerGateway, CustomerInput } from '../../supabase/customers.js';
import type { CustomerActivityGateway } from '../../supabase/customer-activities.js';
import { normalizePhoneNumber } from './phone.js';
import { registerIncomingCallRoutes } from './incoming-calls.js';
import type { AuthGateway } from '../../routes/auth.js';
import { phoneResult, type PhoneGateway } from './gateway.js';

const orgParams = z.object({ organizationId: z.uuid() });
const PAGE_SIZE = 200;
// Legacy VIP is a live customer state; inactive/blocked/archived never enter phone matching.
const callableStatus = (status:string) => status==='active'||status==='vip';
const memoInput = z.object({ customer_id: z.uuid(), phone: z.string().trim().min(1).max(40), memo: z.string().trim().min(1).max(10_000), occurred_at: z.iso.datetime({ offset: true }).nullable().default(null) }).strict();

type OrgAccess = Pick<{ requireAccess(token: string, id: string, feature: string, write?: boolean): Promise<string> }, 'requireAccess'>;

export function registerPhoneRoutes(app: FastifyInstance, organizations: OrgAccess | undefined, customers: CustomerGateway | undefined, activities: CustomerActivityGateway | undefined, auth?: AuthGateway, phone?: PhoneGateway): void {
  function context(request: FastifyRequest) {
    const token = bearerToken(request);
    const params = orgParams.safeParse(request.params);
    if (!organizations || !customers?.search || !activities) throw new ApiFailure(503, 'Phone companion unavailable');
    if (!params.success) throw new ApiFailure(422, 'Invalid organization ID');
    return { token, organizationId: params.data.organizationId };
  }

  async function matchingProfiles(token: string, organizationId: string, rawPhone: string) {
    const normalized = normalizePhoneNumber(rawPhone);
    if (!normalized) throw new ApiFailure(422, 'Invalid caller number');
    // Both 010... and +82 10... contain the national significant digits, whereas
    // searching for 8210... cannot find a number stored in domestic form.
    // Search is only a candidate filter; normalized equality remains mandatory.
    const digits = normalized.startsWith('+82') ? normalized.slice(3) : normalized.slice(1);
    const profiles: CustomerInput[] = [];
    let offset = 0;
    while (true) {
      const result = await customers!.search!(token, organizationId, { q: digits, status: 'all', sort: 'name', direction: 'asc', limit: PAGE_SIZE, offset });
      profiles.push(...result.items.filter(customer => customer.organization_id === organizationId && callableStatus(customer.status) && normalizePhoneNumber(customer.phone) === normalized));
      offset += result.items.length;
      if (offset >= result.total) break;
      if (result.items.length === 0) throw new ApiFailure(503, 'Phone lookup incomplete. Please retry.');
    }
    return { normalized, profiles };
  }
  async function exactMatches(token: string, organizationId: string, rawPhone: string) {
    const { normalized, profiles } = await matchingProfiles(token, organizationId, rawPhone);
    return { normalized, matches: profiles.map(({ id, name, phone }) => ({ customer_id: id, name, phone: phone!, phone_e164: normalized })) };
  }

  registerIncomingCallRoutes(app, context, organizations, auth, phone);

  const directoryRequests=new Map<string,number>();let totalDirectoryRequests=0;
  app.get('/api/v1/organizations/:organizationId/mobile/phone-directory-sync',async(request,reply)=>{
    const current=context(request);
    if(!phone||!auth?.getUser)throw new ApiFailure(503,'Phone directory unavailable');
    const query=z.object({cursor:z.string().min(1).max(512).regex(/^[a-zA-Z0-9:-]+$/).optional()}).strict().safeParse(request.query);
    if(!query.success)throw new ApiFailure(422,'Invalid directory cursor');
    await organizations!.requireAccess(current.token,current.organizationId,'crm.basic');
    const user=await auth.getUser(current.token);
    if(!z.uuid().safeParse(user.userId).success)throw new ApiFailure(401,'Invalid account');
    const key=current.organizationId+':'+user.userId;
    if((directoryRequests.get(key)??0)>=2||totalDirectoryRequests>=64)throw new ApiFailure(429,'Too many directory requests');
    directoryRequests.set(key,(directoryRequests.get(key)??0)+1);totalDirectoryRequests++;
    try{return reply.header('Cache-Control','no-store').send(phoneResult('directory',await phone.request(current.token,current.organizationId,'directory',query.data),current.organizationId));}
    finally{totalDirectoryRequests--;const n=(directoryRequests.get(key)??1)-1;if(n)directoryRequests.set(key,n);else directoryRequests.delete(key);}
  });

  // PC-only enrichment. This route is intentionally outside the mobile tunnel allowlist.
  app.post('/api/v1/organizations/:organizationId/phone/caller-profile', async (request, reply) => {
    const current = context(request);
    const input = z.object({ customer_id: z.uuid(), number: z.string().trim().min(1).max(40) }).strict().safeParse(request.body);
    if (!input.success) throw new ApiFailure(422, 'Invalid caller profile request');
    await organizations!.requireAccess(current.token, current.organizationId, 'crm.basic');
    const { profiles } = await matchingProfiles(current.token, current.organizationId, input.data.number);
    const profile = profiles.find(row => row.id === input.data.customer_id);
    if (!profile) throw new ApiFailure(404, 'Customer phone match not found');
    reply.header('Cache-Control', 'no-store');
    return { customer_id: profile.id, notes: (profile.notes ?? '').slice(0, 5000), allergies: (profile.allergies ?? '').slice(0, 1000), tags: (profile.tags ?? []).slice(0, 8).map(tag => tag.slice(0, 50)) };
  });

  app.get('/api/v1/organizations/:organizationId/mobile/phone-directory', async request => {
    const current = context(request);
    const query = z.object({ cursor: z.string().max(64).optional() }).strict().safeParse(request.query);
    if (!query.success) throw new ApiFailure(422, 'Invalid phone directory cursor');
    const offset = decodeCursor(query.data.cursor);
    if (offset === undefined) throw new ApiFailure(422, 'Invalid phone directory cursor');
    await organizations!.requireAccess(current.token, current.organizationId, 'crm.basic');
    const page = await customers!.search!(current.token, current.organizationId, { q: '', status: 'all', sort: 'name', direction: 'asc', limit: PAGE_SIZE, offset });
    const items = page.items.flatMap(({ id, organization_id: rowOrganizationId, status, name, phone }) => {
      if (rowOrganizationId !== current.organizationId || !callableStatus(status)) return [];
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
