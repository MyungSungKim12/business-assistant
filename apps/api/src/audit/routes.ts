import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { ApiFailure } from '../errors.js';
import { bearerToken } from '../routes/organizations.js';
import { assertOrganization, createRest, type Rest } from '../supabase/rest.js';

const UNAVAILABLE = 'Audit service unavailable';
const ACTION_FORMAT = /^[a-z][a-z0-9_]{1,40}(\.[a-z][a-z0-9_]{1,40}){1,2}$/;

const auditRow = z.object({
  id: z.uuid(), organization_id: z.uuid().nullable(), actor_id: z.uuid().nullable(), action: z.string(), target_type: z.string(), target_id: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()), request_id: z.string().nullable(), ip: z.string().nullable(), source: z.string(), created_at: z.iso.datetime({ offset: true }),
});
export type AuditRow = z.infer<typeof auditRow>;

const instant = z.string().refine((value) => !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}/.test(value), 'invalid date');
export const auditQuery = z.object({
  from: instant.optional(), to: instant.optional(), action: z.string().regex(ACTION_FORMAT).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(200).optional(),
}).strict().refine((value) => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to), 'from must not be after to');

/** 커서는 마지막 행의 (created_at, id) 이다. 서명 없이도 RLS 가 조직 범위를 지키므로 위조해도 다른 조직 자료는 보이지 않는다. */
export function encodeCursor(row: Pick<AuditRow, 'created_at' | 'id'>): string {
  return Buffer.from(JSON.stringify([row.created_at, row.id])).toString('base64url');
}
export function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const parsed = z.tuple([z.iso.datetime({ offset: true }), z.uuid()]).parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    return { createdAt: parsed[0], id: parsed[1] };
  } catch { throw new ApiFailure(422, 'Invalid cursor'); }
}

export function createAuditGateway(config: ServerConfig, fetcher: typeof fetch = fetch, rest: Rest = createRest(config, fetcher, UNAVAILABLE)) {
  return {
    async list(token: string, organizationId: string, filter: z.infer<typeof auditQuery>) {
      const conditions: string[] = [];
      if (filter.from) conditions.push(`created_at.gte.${new Date(filter.from).toISOString()}`);
      if (filter.to) conditions.push(`created_at.lte.${new Date(filter.to).toISOString()}`);
      if (filter.cursor) {
        const { createdAt, id } = decodeCursor(filter.cursor);
        conditions.push(`or(created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${id}))`);
      }
      const query: Record<string, string> = {
        select: 'id,organization_id,actor_id,action,target_type,target_id,metadata,request_id,ip,source,created_at',
        organization_id: `eq.${organizationId}`, order: 'created_at.desc,id.desc', limit: String(filter.limit + 1),
      };
      if (filter.action) query.action = `eq.${filter.action}`;
      if (conditions.length) query.and = `(${conditions.join(',')})`;
      const rows = assertOrganization(await rest.select(token, 'audit_events', query, auditRow), organizationId, UNAVAILABLE);
      const page = rows.slice(0, filter.limit);
      return { items: page, next_cursor: rows.length > filter.limit ? encodeCursor(page[page.length - 1]) : null };
    },
  };
}
export type AuditGateway = ReturnType<typeof createAuditGateway>;
/** 감사 로그 조회는 조직 owner/admin 만 가능하다. OrganizationGateway.members 가 그 규칙(아니면 403)을 이미 구현한다. */
export type AuditAccess = { members(token: string, organizationId: string): Promise<unknown> };

export function registerAuditRoutes(app: FastifyInstance, organizations: AuditAccess | undefined, gateway: AuditGateway): void {
  app.get('/api/v1/organizations/:organizationId/audit-events', async (request) => {
    const token = bearerToken(request);
    if (!organizations) throw new ApiFailure(503, UNAVAILABLE);
    const params = z.object({ organizationId: z.uuid() }).safeParse(request.params);
    if (!params.success) throw new ApiFailure(422, 'Invalid organization ID');
    const filter = auditQuery.safeParse(request.query);
    if (!filter.success) throw new ApiFailure(422, 'Invalid audit filter');
    await organizations.members(token, params.data.organizationId);
    return gateway.list(token, params.data.organizationId, filter.data);
  });
}
