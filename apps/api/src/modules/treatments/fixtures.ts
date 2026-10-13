import Fastify from 'fastify';
import { ApiFailure } from '../../errors.js';
import { registerTreatmentModule } from './index.js';

export const organizationId = 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
export const otherOrganizationId = 'b9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
export const customerId = 'c9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
export const treatmentId = 'd9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
export const operationId = 'e9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
export const actorId = 'f9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
export const documentId = '19cc39fd-8e8c-4df8-a623-1f23a3a936bd';
export const config = { APP_SUPABASE_URL: 'https://example.supabase.co', APP_SUPABASE_PUBLISHABLE_KEY: 'public', APP_FILE_BUCKET: 'business-files', APP_API_PORT: 8000 };
export const allFeatures = ['crm.basic', 'finance.basic', 'document.template'];
export const headers = { authorization: 'Bearer access' };

export const treatmentRowJson = {
  id: treatmentId, organization_id: organizationId, customer_id: customerId, treatment_date: '2026-09-18', treatment_name: '수분 관리', category: '피부',
  practitioner: '김담당', notes: '보습 위주', amount: 15000.5, next_visit_date: '2026-10-01', status: 'draft', version: 1, started_at: null, ended_at: null,
  consultation_goal: '', consultation_plan: '', cautions_snapshot: {}, cautions_acknowledged_by: null, cautions_acknowledged_at: null,
};
export const treatmentValues = { treatment_date: '2026-09-18', treatment_name: '수분 관리', category: '피부', practitioner: '김담당', notes: '보습 위주', amount: '15000.50', next_visit_date: '2026-10-01' };

export type Call = { method: string; url: URL; body: unknown; headers: Record<string, string> };
export type Provider = (call: Call) => { status?: number; body?: unknown; raw?: string };

export function json(body: unknown, status = 200): ReturnType<Provider> { return { status, body }; }

/** 가짜 조직 권한(requireAccess)과 Supabase 응답을 붙인 Fastify 인스턴스를 만든다. */
export function build(options: { role?: string | null; features?: string[]; provider?: Provider; withOrganizations?: boolean } = {}) {
  const { role = 'owner', features = allFeatures, provider = () => json([]), withOrganizations = true } = options;
  const calls: Call[] = [];
  const access: { feature: string; write: boolean }[] = [];
  const organizations = {
    async requireAccess(_token: string, _id: string, feature: string, write = false) {
      access.push({ feature, write });
      if (!role) throw new ApiFailure(403, 'Access denied');
      if (write && role !== 'owner' && role !== 'admin') throw new ApiFailure(403, 'Organization management permission required');
      if (!features.includes(feature)) throw new ApiFailure(403, 'Feature not available');
      return role;
    },
  };
  const fetcher = (async (input: URL | string, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET', url: new URL(String(input)), body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
    };
    calls.push(call);
    const result = provider(call);
    const text = result.raw ?? (result.body === undefined ? '' : JSON.stringify(result.body));
    return new Response(text, { status: result.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof ApiFailure ? error.status : 500).send({ detail: error instanceof ApiFailure ? error.detail : 'Internal server error' }));
  registerTreatmentModule(app, withOrganizations ? organizations : undefined, config, fetcher);
  return { app, calls, access };
}
