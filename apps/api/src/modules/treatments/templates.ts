import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from '../../config.js';
import { ApiFailure } from '../../errors.js';
import { bearerToken } from '../../routes/organizations.js';
import { assertOrganization, createRest } from '../../supabase/rest.js';
import { withMessages, withPgErrorCodes, type PgErrorCodes } from './pg-errors.js';
import type { OrgAccess } from './routes.js';

/** TRT-12 시술 프로토콜 템플릿(051). 불러올 때 값을 복사할 뿐 시술 기록과 연결되지 않는다. 쓰기는 owner/admin(RLS가 강제). */
const messages = {
  403: 'Template write not allowed', 404: 'Template not found', 409: 'Template changed or name already used',
  422: 'Invalid template values', 503: 'Template service unavailable',
} as const;
const unavailable = messages[503];
// 같은 이름(23505)과 오래된 버전은 모두 409로 알린다.
const templateErrorCodes: PgErrorCodes = { conflict: ['P0001', '23505'], notFound: ['P0002'], denied: ['42501'], invalid: ['22023', '23514', '22P02'] };

const id = z.uuid();
const fields = {
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().max(100),
  treatment_name: z.string().trim().max(200),
  notes: z.string().max(10_000),
  consultation_goal: z.string().max(2_000),
  consultation_plan: z.string().max(5_000),
};
/** 생성: 이름만 필수이고 나머지는 빈 값이 기본이다. */
export const templateCreate = z.strictObject({
  name: fields.name, category: fields.category.default(''), treatment_name: fields.treatment_name.default(''),
  notes: fields.notes.default(''), consultation_goal: fields.consultation_goal.default(''), consultation_plan: fields.consultation_plan.default(''),
});
/** 수정: 보낸 필드만 바꾼다(기본값을 채우면 안 쓴 칸이 지워지므로 생성 스키마와 분리). expected_version은 필수다. */
export const templatePatch = z.strictObject({
  name: fields.name.optional(), category: fields.category.optional(), treatment_name: fields.treatment_name.optional(),
  notes: fields.notes.optional(), consultation_goal: fields.consultation_goal.optional(), consultation_plan: fields.consultation_plan.optional(),
  expected_version: z.number().int().min(1),
});

const templateRow = z.object({
  id, organization_id: id, name: z.string(), category: z.string(), treatment_name: z.string(), notes: z.string(),
  consultation_goal: z.string(), consultation_plan: z.string(), version: z.number().int(), updated_at: z.string(),
});
export type TreatmentTemplate = z.infer<typeof templateRow>;
const select = 'id,organization_id,name,category,treatment_name,notes,consultation_goal,consultation_plan,version,updated_at';

export function createTemplateGateway(config: ServerConfig, fetcher: typeof fetch = fetch) {
  const rest = createRest(config, withPgErrorCodes(fetcher, templateErrorCodes), unavailable);
  const guard = <T>(work: () => Promise<T>) => withMessages(work, messages);
  const exists = async (token: string, organizationId: string, templateId: string) =>
    (await rest.select(token, 'treatment_protocol_templates', { select: 'id', organization_id: `eq.${organizationId}`, id: `eq.${templateId}` }, z.object({ id }))).length > 0;
  return {
    list: (token: string, organizationId: string) => guard(async () => assertOrganization(
      await rest.select(token, 'treatment_protocol_templates', { select, organization_id: `eq.${organizationId}`, order: 'name.asc', limit: '500' }, templateRow), organizationId, unavailable)),
    create: (token: string, organizationId: string, input: z.infer<typeof templateCreate>) => guard(async () => {
      const row = await rest.insert(token, 'treatment_protocol_templates', { organization_id: organizationId, ...input }, templateRow, { select });
      assertOrganization([row], organizationId, unavailable);
      return row;
    }),
    /** 낙관적 잠금: version 조건이 맞는 행만 고친다. 안 맞으면 없는 템플릿(404)인지 오래된 버전(409)인지 가른다. */
    update: (token: string, organizationId: string, templateId: string, input: z.infer<typeof templatePatch>) => guard(async () => {
      const { expected_version, ...patch } = input;
      const row = await rest.update(token, 'treatment_protocol_templates',
        { select, organization_id: `eq.${organizationId}`, id: `eq.${templateId}`, version: `eq.${expected_version}` }, patch, templateRow);
      if (row) { assertOrganization([row], organizationId, unavailable); return row; }
      if (!await exists(token, organizationId, templateId)) throw new ApiFailure(404, messages[404]);
      throw new ApiFailure(409, messages[409]);
    }),
    /** 지운 뒤에도 행이 남아 있으면 RLS가 막은 것(권한 없음)이다. */
    remove: (token: string, organizationId: string, templateId: string) => guard(async () => {
      if (!await exists(token, organizationId, templateId)) throw new ApiFailure(404, messages[404]);
      await rest.remove(token, 'treatment_protocol_templates', { organization_id: `eq.${organizationId}`, id: `eq.${templateId}` });
      if (await exists(token, organizationId, templateId)) throw new ApiFailure(403, messages[403]);
    }),
  };
}
export type TemplateGateway = ReturnType<typeof createTemplateGateway>;

const base = '/api/v1/organizations/:organizationId/treatment-templates';
const orgParams = z.object({ organizationId: id });
const itemParams = orgParams.extend({ templateId: id });

export function registerTemplateRoutes(app: FastifyInstance, organizations: OrgAccess | undefined, gateway: TemplateGateway): void {
  function access(request: FastifyRequest) {
    const token = bearerToken(request);
    if (!organizations) throw new ApiFailure(503, unavailable);
    return { token, organizations };
  }
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const result = schema.safeParse(value);
    if (!result.success) throw new ApiFailure(422, messages[422]);
    return result.data;
  };

  app.get(base, async (request) => {
    const { token, organizations: org } = access(request);
    const params = parse(orgParams, request.params);
    await org.requireAccess(token, params.organizationId, 'crm.basic');
    return gateway.list(token, params.organizationId);
  });
  app.post(base, async (request, reply) => {
    const { token, organizations: org } = access(request);
    const params = parse(orgParams, request.params);
    const input = parse(templateCreate, request.body);
    await org.requireAccess(token, params.organizationId, 'crm.basic', true);
    reply.code(201);
    return gateway.create(token, params.organizationId, input);
  });
  app.patch(`${base}/:templateId`, async (request) => {
    const { token, organizations: org } = access(request);
    const params = parse(itemParams, request.params);
    const input = parse(templatePatch, request.body);
    await org.requireAccess(token, params.organizationId, 'crm.basic', true);
    return gateway.update(token, params.organizationId, params.templateId, input);
  });
  app.delete(`${base}/:templateId`, async (request, reply) => {
    const { token, organizations: org } = access(request);
    const params = parse(itemParams, request.params);
    await org.requireAccess(token, params.organizationId, 'crm.basic', true);
    await gateway.remove(token, params.organizationId, params.templateId);
    return reply.code(204).send();
  });
}
