import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from '../../config.js';
import { ApiFailure } from '../../errors.js';
import { bearerToken } from '../../routes/organizations.js';
import { assertOrganization, createRest } from '../../supabase/rest.js';
import { withMessages, withPgErrorCodes, type PgErrorCodes } from '../treatments/pg-errors.js';
import { formatFixed, toCents } from './money.js';
import { withMonthClosedErrors } from './monthClosed.js';
import type { OrgAccess } from './routes.js';

/** FIN-11 반복 지출(052). 쓰기는 owner/admin(DB가 강제). 한 달치 등록은 RPC가 중복 없이 처리한다. */
const messages = {
  403: 'Recurring expense write not allowed', 404: 'Recurring expense not found', 409: 'Recurring expense changed or name already used',
  422: 'Invalid recurring expense', 503: 'Finance service unavailable',
} as const;
const unavailable = messages[503];
const codes: PgErrorCodes = { conflict: ['P0001', '23505'], notFound: ['P0002'], denied: ['42501'], invalid: ['22023', '23514', '22P02'] };

const id = z.uuid();
const amountInput = z.union([z.string(), z.number()]).transform((value) => (typeof value === 'number' ? String(value) : value.trim()))
  .refine((text) => /^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(text) && toCents(text) > 0n && toCents(text) < 1_000_000_000_000n * 100n);
const fields = {
  name: z.string().trim().min(1).max(120),
  amount: amountInput,
  category: z.string().trim().min(1).max(200),
  counterparty: z.string().max(5_000),
  memo: z.string().max(5_000),
  day_of_month: z.number().int().min(1).max(31),
  is_active: z.boolean(),
};
export const recurringCreate = z.strictObject({
  name: fields.name, amount: fields.amount, category: fields.category, counterparty: fields.counterparty.default(''), memo: fields.memo.default(''),
  day_of_month: fields.day_of_month, is_active: fields.is_active.default(true),
});
/** 수정은 보낸 필드만 바꾼다(기본값으로 덮어쓰지 않도록 생성 스키마와 분리). expected_version 필수. */
export const recurringPatch = z.strictObject({
  name: fields.name.optional(), amount: fields.amount.optional(), category: fields.category.optional(), counterparty: fields.counterparty.optional(),
  memo: fields.memo.optional(), day_of_month: fields.day_of_month.optional(), is_active: fields.is_active.optional(), expected_version: z.number().int().min(1),
});
const monthRequest = z.strictObject({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])(-01)?$/) });
const runsQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])(-01)?$/) });

const money = z.union([z.string(), z.number()]).transform((value, ctx) => {
  try { return formatFixed(toCents(value)); } catch { ctx.issues.push({ code: 'custom', message: 'Invalid amount', input: value }); return z.NEVER; }
});
const recurringRow = z.object({
  id, organization_id: id, name: z.string(), amount: money, category: z.string(), counterparty: z.string(), memo: z.string(),
  day_of_month: z.number().int(), is_active: z.boolean(), version: z.number().int(), updated_at: z.string(),
});
const runRow = z.object({ recurring_id: id, organization_id: id, month: z.string(), transaction_id: id.nullable() });
const generateResult = z.object({ month: z.string(), created: z.number().int(), skipped: z.number().int(), transaction_ids: z.array(id) });
export type RecurringExpense = z.infer<typeof recurringRow>;
const select = 'id,organization_id,name,amount,category,counterparty,memo,day_of_month,is_active,version,updated_at';

const firstOfMonth = (value: string) => `${value.slice(0, 7)}-01`;

export function createRecurringGateway(config: ServerConfig, fetcher: typeof fetch = fetch) {
  const rest = createRest(config, withPgErrorCodes(withMonthClosedErrors(fetcher), codes), unavailable);
  // 월 마감 안내(오류 코드가 붙은 409)는 그대로 전달하고, 나머지는 이 모듈의 문구로 바꾼다.
  const guard = async <T>(work: () => Promise<T>): Promise<T> => {
    try { return await work(); } catch (error) {
      if (error instanceof ApiFailure && error.extra && 'code' in error.extra) throw error;
      return withMessages<T>(async () => { throw error; }, messages);
    }
  };
  const exists = async (token: string, organizationId: string, recurringId: string) =>
    (await rest.select(token, 'finance_recurring_expenses', { select: 'id', organization_id: `eq.${organizationId}`, id: `eq.${recurringId}` }, z.object({ id }))).length > 0;
  return {
    list: (token: string, organizationId: string) => guard(async () => assertOrganization(
      await rest.select(token, 'finance_recurring_expenses', { select, organization_id: `eq.${organizationId}`, order: 'name.asc', limit: '500' }, recurringRow), organizationId, unavailable)),
    create: (token: string, organizationId: string, input: z.infer<typeof recurringCreate>) => guard(async () => {
      const row = await rest.insert(token, 'finance_recurring_expenses', { organization_id: organizationId, ...input }, recurringRow, { select });
      assertOrganization([row], organizationId, unavailable);
      return row;
    }),
    update: (token: string, organizationId: string, recurringId: string, input: z.infer<typeof recurringPatch>) => guard(async () => {
      const { expected_version, ...patch } = input;
      const row = await rest.update(token, 'finance_recurring_expenses',
        { select, organization_id: `eq.${organizationId}`, id: `eq.${recurringId}`, version: `eq.${expected_version}` }, patch, recurringRow);
      if (row) { assertOrganization([row], organizationId, unavailable); return row; }
      if (!await exists(token, organizationId, recurringId)) throw new ApiFailure(404, messages[404]);
      throw new ApiFailure(409, messages[409]);
    }),
    remove: (token: string, organizationId: string, recurringId: string) => guard(async () => {
      if (!await exists(token, organizationId, recurringId)) throw new ApiFailure(404, messages[404]);
      await rest.remove(token, 'finance_recurring_expenses', { organization_id: `eq.${organizationId}`, id: `eq.${recurringId}` });
      if (await exists(token, organizationId, recurringId)) throw new ApiFailure(403, messages[403]);
    }),
    /** 그 달에 이미 등록된 반복 지출(어느 항목이 등록됐는지 화면에 표시하는 용도). */
    runs: (token: string, organizationId: string, month: string) => guard(async () => assertOrganization(
      await rest.select(token, 'finance_recurring_runs', { select: 'recurring_id,organization_id,month,transaction_id', organization_id: `eq.${organizationId}`, month: `eq.${firstOfMonth(month)}`, limit: '500' }, runRow), organizationId, unavailable)),
    generate: (token: string, organizationId: string, month: string) => guard(() => rest.rpc(token, 'generate_finance_recurring_expenses', { p_organization_id: organizationId, p_month: firstOfMonth(month) }, generateResult)),
  };
}
export type RecurringGateway = ReturnType<typeof createRecurringGateway>;

const base = '/api/v1/organizations/:organizationId/finance-recurring-expenses';
const orgParams = z.object({ organizationId: id });
const itemParams = orgParams.extend({ recurringId: id });
const FINANCE = 'finance.basic';

export function registerRecurringRoutes(app: FastifyInstance, organizations: OrgAccess | undefined, gateway: RecurringGateway): void {
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
    await org.requireAccess(token, params.organizationId, FINANCE);
    return gateway.list(token, params.organizationId);
  });
  app.get(`${base}/runs`, async (request) => {
    const { token, organizations: org } = access(request);
    const params = parse(orgParams, request.params);
    const query = parse(runsQuery, request.query);
    await org.requireAccess(token, params.organizationId, FINANCE);
    return gateway.runs(token, params.organizationId, query.month);
  });
  app.post(`${base}/generate`, async (request) => {
    const { token, organizations: org } = access(request);
    const params = parse(orgParams, request.params);
    const input = parse(monthRequest, request.body);
    await org.requireAccess(token, params.organizationId, FINANCE, true);
    return gateway.generate(token, params.organizationId, input.month);
  });
  app.post(base, async (request, reply) => {
    const { token, organizations: org } = access(request);
    const params = parse(orgParams, request.params);
    const input = parse(recurringCreate, request.body);
    await org.requireAccess(token, params.organizationId, FINANCE, true);
    reply.code(201);
    return gateway.create(token, params.organizationId, input);
  });
  app.patch(`${base}/:recurringId`, async (request) => {
    const { token, organizations: org } = access(request);
    const params = parse(itemParams, request.params);
    const input = parse(recurringPatch, request.body);
    await org.requireAccess(token, params.organizationId, FINANCE, true);
    return gateway.update(token, params.organizationId, params.recurringId, input);
  });
  app.delete(`${base}/:recurringId`, async (request, reply) => {
    const { token, organizations: org } = access(request);
    const params = parse(itemParams, request.params);
    await org.requireAccess(token, params.organizationId, FINANCE, true);
    await gateway.remove(token, params.organizationId, params.recurringId);
    return reply.code(204).send();
  });
}
