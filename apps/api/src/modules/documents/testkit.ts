import Fastify, { type FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import type { ServerConfig } from '../../config.js';
import { ApiFailure } from '../../errors.js';
import { registerDocumentModule } from './index.js';

export const ORG = 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
export const CUSTOMER = 'c9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
export const TREATMENT = 'd9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
export const TEMPLATE = 'e9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
export const DOCUMENT = 'f9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
export const USER = '19cc39fd-8e8c-4df8-a623-1f23a3a936bd';
export const OPERATION = '29cc39fd-8e8c-4df8-a623-1f23a3a936bd';
export const FILE = '39cc39fd-8e8c-4df8-a623-1f23a3a936bd';
export const config: ServerConfig = { APP_SUPABASE_URL: 'https://project.supabase.co', APP_SUPABASE_PUBLISHABLE_KEY: 'publishable', APP_FILE_BUCKET: 'business-files', APP_API_PORT: 8000 };
export const auth = { authorization: 'Bearer user-token' };
export const orgPath = (rest: string) => `/api/v1/organizations/${ORG}/${rest}`;
export const treatmentPath = (rest = 'documents') => `/api/v1/organizations/${ORG}/customers/${CUSTOMER}/treatments/${TREATMENT}/${rest}`;

export type Call = { method: string; url: URL; headers: Record<string, string>; body: unknown };
export type Reply = { status?: number; body?: unknown };
export type Responder = (call: Call) => Reply | undefined;

export function build(options: { role?: 'owner' | 'admin' | 'member'; features?: string[]; respond?: Responder } = {}) {
  const role = options.role ?? 'owner';
  const features = options.features ?? ['crm.basic', 'document.template', 'files.basic'];
  const calls: Call[] = [];
  const access: { feature: string; write: boolean }[] = [];
  const organizations = {
    async requireAccess(token: string, id: string, feature: string, write = false) {
      if (token === 'outsider') throw new ApiFailure(403, 'Organization membership required');
      if (id !== ORG) throw new ApiFailure(403, 'Organization membership required');
      access.push({ feature, write });
      if (write && role === 'member') throw new ApiFailure(403, 'Organization management permission required');
      if (!features.includes(feature)) throw new ApiFailure(403, 'Feature not available');
      return role;
    },
  };
  const fetcher = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? 'GET', url, headers: { ...(init?.headers as Record<string, string>) }, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const reply = options.respond?.(call) ?? { status: 200, body: [] };
    return new Response(JSON.stringify(reply.body ?? null), { status: reply.status ?? 200 });
  }) as typeof fetch;
  const app: FastifyInstance = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof ApiFailure ? error.status : 500;
    return reply.code(status).send({ detail: error instanceof ApiFailure ? error.detail : 'Internal server error' });
  });
  registerDocumentModule(app, organizations, config, fetcher);
  return { app, calls, access };
}

export const template = { id: TEMPLATE, organization_id: ORG, created_by: USER, name: 'Consent', description: 'd', content: 'Hello {{customer.name}}', is_archived: false, created_at: '2030-01-01T00:00:00+00:00', updated_at: '2030-01-01T00:00:00+00:00', status: 'published', version: 2, revision: 3 };
export const document = { id: DOCUMENT, organization_id: ORG, template_id: TEMPLATE, created_by: USER, title: 'Doc', content: 'Body', status: 'draft', created_at: '2030-01-01T00:00:00+00:00', updated_at: '2030-01-01T00:00:00+00:00' };
export const issued = { id: DOCUMENT, organization_id: ORG, customer_id: CUSTOMER, treatment_id: TREATMENT, template_id: TEMPLATE, template_version: 2, title: 'Consent', content: 'Hello Kim', source_snapshot: { customer: { name: 'Kim' } }, issued_by: USER, issued_at: '2030-01-01T00:00:00Z', operation_id: OPERATION, request_fingerprint: 'private' };
export const preview = { template_id: TEMPLATE, template_version: 2, title: 'Consent', content: 'Hello Kim', source_snapshot: { customer: { name: 'Kim' } }, missing_fields: [] };
export const sign = { signer_name: 'Customer A', strokes: [[[0, 0], [1, 1]]], confirmed: true };
export const deliver = { method: 'paper', recipient: 'Customer A', reference: '', note: '', confirmed: true };
export const revoke = { reason: 'Withdraw consent', confirmed: true };
export const event = { id: OPERATION, organization_id: ORG, document_id: DOCUMENT, revision: 1, action: 'sign', values: sign, actor_id: USER, occurred_at: '2030-01-01T00:00:00Z', content_hash: 'a'.repeat(64), operation_id: OPERATION, request_fingerprint: 'private' };
export const fileRow = { id: FILE, organization_id: ORG, uploaded_by: USER, storage_path: `${ORG}/${FILE}-report.pdf`, original_name: 'report.pdf', content_type: 'application/pdf', size_bytes: 10, is_archived: false, created_at: '2030-01-01T00:00:00Z', updated_at: '2030-01-01T00:00:00Z' };

export function expectNoLeak(text: string) { expect(text).not.toMatch(/private|storage_path|request_fingerprint|operation_id/); }
