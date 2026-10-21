import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiFailure } from '../errors.js';
import { bearerToken } from './organizations.js';
import { customerSorts, customerStatuses, type CustomerGateway, type CustomerInput, type CustomerSearchQuery } from '../supabase/customers.js';
import type { AuditRecorder } from '../audit/recorder.js';

const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();
const optionalProfile = {
  email: nullableText(255), phone: nullableText(50), notes: z.string().max(5_000).optional(), birth_date: z.iso.date().nullable().optional(), skin_type: nullableText(100),
  concerns: z.array(z.string().trim().min(1).max(100)).max(30).optional(), allergies: z.string().max(1_000).optional(),
  last_visit_date: z.iso.date().nullable().optional(), next_visit_date: z.iso.date().nullable().optional(), tags: z.array(z.string().trim().min(1).max(50)).max(30).optional(), status: z.enum(['active', 'archived']).optional(),
  marketing_consent: z.boolean().optional(),
};
const createInput = z.object({ name: z.string().trim().min(1).max(200), ...optionalProfile }).strict();
const patchInput = createInput.partial().refine(value => Object.keys(value).length > 0);
type EditableCustomer = Omit<CustomerInput, 'id' | 'organization_id'>;

export const SEARCH_DEFAULT_LIMIT = 50;
export const SEARCH_MAX_LIMIT = 200;
const SEARCH_MAX_OFFSET = 100_000;
const searchQuery = z.object({
  q: z.string().trim().max(100).default(''),
  status: z.enum([...customerStatuses, 'all']).default('active'),
  sort: z.enum(customerSorts).default('name'),
  dir: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(SEARCH_MAX_LIMIT).default(SEARCH_DEFAULT_LIMIT),
  cursor: z.string().max(64).optional(),
});

/** 커서는 다음 시작 위치(offset)를 감싼 불투명 값이다. 형식이 틀리면 decodeCursor가 undefined를 돌려준다. */
export function encodeCursor(offset: number): string { return Buffer.from(`o:${offset}`).toString('base64url'); }
export function decodeCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return 0;
  const match = /^o:(\d{1,6})$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  const offset = match ? Number(match[1]) : Number.NaN;
  return Number.isInteger(offset) && offset <= SEARCH_MAX_OFFSET ? offset : undefined;
}
const tagName = z.string().trim().min(1).max(50);
const tagRename = z.object({ from: tagName, to: tagName }).strict();
const tagMerge = z.object({ from: z.array(tagName).min(1).max(30), to: tagName }).strict();
const tagDelete = z.object({ tag: tagName }).strict();
const retentionPolicyInput = z.object({
  expected_version: z.number().int().min(0),
  profile_days: z.number().int().min(1).max(36500).nullable(),
  sensitive_notes_days: z.number().int().min(1).max(36500).nullable(),
  treatment_photos_days: z.number().int().min(1).max(36500).nullable(),
  consent_records_days: z.number().int().min(1).max(36500).nullable(),
  transaction_records_days: z.number().int().min(1).max(36500).nullable(),
  dispute_records_days: z.number().int().min(1).max(36500).nullable(),
  audit_events_days: z.number().int().min(1).max(36500).nullable(),
}).strict();
const retentionActionInput = z.object({ reason: z.string().trim().min(1).max(300) }).strict();
const relationshipEndInput = retentionActionInput.extend({ ended_at: z.iso.datetime({ offset: true }).nullable() }).strict();
const mergeInput = z.object({
  secondary_id: z.uuid(), operation_id: z.uuid(),
  resolved: z.object({
    name: z.string().trim().min(1).max(200), email: nullableText(255), phone: nullableText(50), birth_date: nullableText(10), skin_type: nullableText(100),
    allergies: z.string().max(1_000), notes: z.string().max(5_000), tags: z.array(tagName).max(30), concerns: z.array(z.string().trim().min(1).max(100)).max(30),
    last_visit_date: nullableText(10), next_visit_date: nullableText(10),
  }).partial().strict().optional(),
}).strict();

export function registerCustomerRoutes(app: FastifyInstance, organizations: Pick<{ requireAccess(token: string, id: string, feature: string, write?: boolean): Promise<string> }, 'requireAccess'> | undefined, customers?: CustomerGateway, audit?: AuditRecorder): void {
  function service(request: FastifyRequest) {
    const token = bearerToken(request);
    if (!organizations || !customers) throw new ApiFailure(503, 'Customer service unavailable');
    const params = z.object({ organizationId: z.uuid() }).safeParse(request.params);
    if (!params.success) throw new ApiFailure(422, 'Invalid organization ID');
    return { token, organizationId: params.data.organizationId, organizations, customers };
  }
  app.get('/api/v1/organizations/:organizationId/customers', async request => {
    const current = service(request);
    await current.organizations.requireAccess(current.token, current.organizationId, 'crm.basic');
    return current.customers.list(current.token, current.organizationId);
  });
  app.post('/api/v1/organizations/:organizationId/customers/visit-facts',async request=>{
    const current=service(request);
    const parsed=z.object({customer_ids:z.array(z.uuid()).max(200).refine(ids=>new Set(ids).size===ids.length)}).strict().safeParse(request.body);
    if(!parsed.success)throw new ApiFailure(422,'Invalid customer batch');
    await current.organizations.requireAccess(current.token,current.organizationId,'crm.basic');
    if(!current.customers.visitFacts)throw new ApiFailure(503,'Customer visit facts unavailable');
    return current.customers.visitFacts(current.token,current.organizationId,parsed.data.customer_ids);
  });
  app.get('/api/v1/organizations/:organizationId/customer-retention-policy', async request => {
    const current = service(request);
    await current.organizations.requireAccess(current.token, current.organizationId, 'crm.basic');
    if (!current.customers.getRetentionPolicy) throw new ApiFailure(503, 'Customer retention policy unavailable');
    return { policy: await current.customers.getRetentionPolicy(current.token, current.organizationId), purge_enabled: false,
      reason: '관련 예약·거래·동의·사진·저장소의 분리 및 파기 검증이 끝나지 않았습니다.' };
  });
  app.put('/api/v1/organizations/:organizationId/customer-retention-policy', async request => {
    const current = service(request);
    const body = retentionPolicyInput.safeParse(request.body);
    if (!body.success) throw new ApiFailure(422, 'Invalid customer retention policy');
    if (!current.customers.saveRetentionPolicy) throw new ApiFailure(503, 'Customer retention policy unavailable');
    await current.organizations.requireAccess(current.token, current.organizationId, 'crm.basic', true);
    const { expected_version, ...policy } = body.data;
    const saved = await current.customers.saveRetentionPolicy(current.token, current.organizationId, policy, expected_version);
    await audit?.record(current.token, { organizationId: current.organizationId, action: 'customer.retention_policy_update', targetType: 'customer_retention_policy', requestId: request.id, ip: request.ip,
      metadata: { version: saved.version, configured_categories: Object.values(policy).filter(value => value !== null).length } });
    return saved;
  });
  app.get('/api/v1/organizations/:organizationId/customers/:customerId/retention-status', async request => {
    const current = service(request);
    const params = z.object({ customerId: z.uuid() }).safeParse(request.params);
    if (!params.success || !current.customers.retentionStatus) throw new ApiFailure(422, 'Invalid customer retention request');
    await current.organizations.requireAccess(current.token, current.organizationId, 'crm.basic');
    return current.customers.retentionStatus(current.token, current.organizationId, params.data.customerId);
  });
  app.put('/api/v1/organizations/:organizationId/customers/:customerId/relationship-end', async request => {
    const current = service(request);
    const params = z.object({ customerId: z.uuid() }).safeParse(request.params);
    const body = relationshipEndInput.safeParse(request.body);
    if (!params.success || !body.success || !current.customers.setRelationshipEnd) throw new ApiFailure(422, 'Invalid customer relationship status');
    await current.organizations.requireAccess(current.token, current.organizationId, 'crm.basic', true);
    const endedAt = await current.customers.setRelationshipEnd(current.token, current.organizationId, params.data.customerId, body.data.ended_at, body.data.reason);
    await audit?.record(current.token, { organizationId: current.organizationId, action: endedAt ? 'customer.relationship_end' : 'customer.relationship_reopen', targetType: 'customer', targetId: params.data.customerId, requestId: request.id, ip: request.ip, metadata: {} });
    return { relationship_ended_at: endedAt };
  });
  app.put('/api/v1/organizations/:organizationId/customers/:customerId/legal-hold', async request => {
    const current = service(request);
    const params = z.object({ customerId: z.uuid() }).safeParse(request.params);
    const body = z.object({ active: z.boolean(), reason: z.string().trim().min(1).max(300) }).strict().safeParse(request.body);
    if (!params.success || !body.success || !current.customers.setLegalHold) throw new ApiFailure(422, 'Invalid customer legal hold');
    await current.organizations.requireAccess(current.token, current.organizationId, 'crm.basic', true);
    await current.customers.setLegalHold(current.token, current.organizationId, params.data.customerId, body.data.active, body.data.reason);
    await audit?.record(current.token, { organizationId: current.organizationId, action: body.data.active ? 'customer.legal_hold_create' : 'customer.legal_hold_release', targetType: 'customer', targetId: params.data.customerId, requestId: request.id, ip: request.ip, metadata: {} });
    return { active: body.data.active };
  });
  /** 서버 검색·페이지. 응답 `{items, total, next_cursor}`. 기존 목록 경로는 그대로 둔다. */
  app.get('/api/v1/organizations/:organizationId/customers/search', async request => {
    const current = service(request);
    const parsed = searchQuery.safeParse(request.query);
    const offset = parsed.success ? decodeCursor(parsed.data.cursor) : undefined;
    if (!parsed.success || offset === undefined) throw new ApiFailure(422, 'Invalid customer search');
    if (!current.customers.search) throw new ApiFailure(503, 'Customer service unavailable');
    await current.organizations.requireAccess(current.token, current.organizationId, 'crm.basic');
    const query: CustomerSearchQuery = {
      q: parsed.data.q, status: parsed.data.status, sort: parsed.data.sort, limit: parsed.data.limit, offset,
      direction: parsed.data.dir ?? (parsed.data.sort === 'name' ? 'asc' : 'desc'),
    };
    const { items, total } = await current.customers.search(current.token, current.organizationId, query);
    const next = offset + items.length;
    return { items, total, next_cursor: items.length > 0 && next < total ? encodeCursor(next) : null };
  });
  /** 같은 연락처(숫자만)·이메일을 가진 보관되지 않은 고객 후보 그룹(서버 전체 기준). */
  app.get('/api/v1/organizations/:organizationId/customers/duplicates', async request => {
    const current = service(request);
    if (!current.customers.duplicateGroups) throw new ApiFailure(503, 'Customer service unavailable');
    await current.organizations.requireAccess(current.token, current.organizationId, 'crm.basic');
    return current.customers.duplicateGroups(current.token, current.organizationId);
  });
  /** 경로의 고객이 대표 고객이다. 보조 고객의 연결 데이터를 대표로 옮기고 보조 고객은 보관한다. */
  app.post('/api/v1/organizations/:organizationId/customers/:customerId/merge', async request => {
    const current = service(request);
    const params = z.object({ customerId: z.uuid() }).safeParse(request.params);
    const body = mergeInput.safeParse(request.body);
    if (!params.success || !body.success || body.data.secondary_id === params.data.customerId) throw new ApiFailure(422, 'Invalid customer merge');
    if (!current.customers.merge) throw new ApiFailure(503, 'Customer service unavailable');
    await current.organizations.requireAccess(current.token, current.organizationId, 'crm.basic', true);
    const result = await current.customers.merge(current.token, current.organizationId, params.data.customerId, {
      secondaryId: body.data.secondary_id, operationId: body.data.operation_id, resolved: body.data.resolved,
    });
    await audit?.record(current.token, {
      organizationId: current.organizationId, action: 'customer.merge', targetType: 'customer', targetId: params.data.customerId, requestId: request.id, ip: request.ip,
      metadata: { secondary_id: body.data.secondary_id, moved_total: Object.values(result.moved).reduce((sum, count) => sum + count, 0) },
    });
    return result;
  });
  app.get('/api/v1/organizations/:organizationId/customer-tags', async request => {
    const current = service(request);
    if (!current.customers.listTags) throw new ApiFailure(503, 'Customer service unavailable');
    await current.organizations.requireAccess(current.token, current.organizationId, 'crm.basic');
    return current.customers.listTags(current.token, current.organizationId);
  });
  app.post('/api/v1/organizations/:organizationId/customer-tags/rename', async request => {
    const current = service(request);
    const body = tagRename.safeParse(request.body);
    if (!body.success) throw new ApiFailure(422, 'Invalid customer tag');
    if (!current.customers.renameTag) throw new ApiFailure(503, 'Customer service unavailable');
    await current.organizations.requireAccess(current.token, current.organizationId, 'crm.basic', true);
    const result = await current.customers.renameTag(current.token, current.organizationId, body.data.from, body.data.to);
    await audit?.record(current.token, { organizationId: current.organizationId, action: 'customer.tag_rename', targetType: 'customer_tag', requestId: request.id, ip: request.ip, metadata: { updated: result.updated } });
    return result;
  });
  app.post('/api/v1/organizations/:organizationId/customer-tags/merge', async request => {
    const current = service(request);
    const body = tagMerge.safeParse(request.body);
    if (!body.success) throw new ApiFailure(422, 'Invalid customer tag');
    if (!current.customers.mergeTags) throw new ApiFailure(503, 'Customer service unavailable');
    await current.organizations.requireAccess(current.token, current.organizationId, 'crm.basic', true);
    const result = await current.customers.mergeTags(current.token, current.organizationId, body.data.from, body.data.to);
    await audit?.record(current.token, { organizationId: current.organizationId, action: 'customer.tag_merge', targetType: 'customer_tag', requestId: request.id, ip: request.ip, metadata: { updated: result.updated, merged_tags: body.data.from.length } });
    return result;
  });
  app.post('/api/v1/organizations/:organizationId/customer-tags/delete', async request => {
    const current = service(request);
    const body = tagDelete.safeParse(request.body);
    if (!body.success) throw new ApiFailure(422, 'Invalid customer tag');
    if (!current.customers.deleteTag) throw new ApiFailure(503, 'Customer service unavailable');
    await current.organizations.requireAccess(current.token, current.organizationId, 'crm.basic', true);
    const result = await current.customers.deleteTag(current.token, current.organizationId, body.data.tag);
    await audit?.record(current.token, { organizationId: current.organizationId, action: 'customer.tag_delete', targetType: 'customer_tag', requestId: request.id, ip: request.ip, metadata: { updated: result.updated } });
    return result;
  });
  app.post('/api/v1/organizations/:organizationId/customers', async request => {
    const current = service(request);
    const input = createInput.safeParse(request.body);
    if (!input.success) throw new ApiFailure(422, 'Invalid customer input');
    await current.organizations.requireAccess(current.token, current.organizationId, 'crm.basic', true);
    const value: EditableCustomer = { email: null, phone: null, notes: '', birth_date: null, skin_type: null, concerns: [], allergies: '', last_visit_date: null, next_visit_date: null, tags: [], status: 'active', ...input.data };
    return current.customers.create(current.token, current.organizationId, value);
  });
  app.patch('/api/v1/organizations/:organizationId/customers/:customerId', async request => {
    const current = service(request);
    const params = z.object({ customerId: z.uuid() }).safeParse(request.params);
    if (!params.success) throw new ApiFailure(422, 'Invalid customer ID');
    const patch = patchInput.safeParse(request.body);
    if (!patch.success) throw new ApiFailure(422, 'Invalid customer input');
    await current.organizations.requireAccess(current.token, current.organizationId, 'crm.basic', true);
    const saved = await current.customers.update(current.token, current.organizationId, params.data.customerId, patch.data);
    if (!saved) throw new ApiFailure(404, 'Customer not found');
    return saved;
  });
  app.delete('/api/v1/organizations/:organizationId/customers/:customerId', async request => {
    const current = service(request);
    const params = z.object({ customerId: z.uuid() }).safeParse(request.params);
    if (!params.success) throw new ApiFailure(422, 'Invalid customer ID');
    await current.organizations.requireAccess(current.token, current.organizationId, 'crm.basic', true);
    // Policies and holds are now configurable; deletion stays blocked until linked records, Storage and backups have a verified purge path.
    throw new ApiFailure(409, 'Customer erasure is disabled until linked records, storage objects and backups have a verified retention and purge workflow');
  });
}
