import Fastify, { type FastifyInstance } from 'fastify';
import type { ServerConfig } from '../../config.js';
import { ApiFailure } from '../../errors.js';

/** 모듈 테스트 공용 도구(런타임 코드에서는 쓰지 않는다). app.ts와 같은 오류 응답 형식을 쓴다. */
export const testConfig: ServerConfig = { APP_SUPABASE_URL: 'https://example.supabase.co', APP_SUPABASE_PUBLISHABLE_KEY: 'public-key', APP_FILE_BUCKET: 'business-files', APP_API_PORT: 8000 };
export const ORG = 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
export const OTHER_ORG = 'f9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
export const OP = '0a9c39fd-8e8c-4df8-a623-1f23a3a936bd';
export const auth = { authorization: 'Bearer user-token' };

export function buildApp(register: (app: FastifyInstance) => void): FastifyInstance {
  const app = Fastify();
  app.setErrorHandler((error, request, reply) => {
    const status = error instanceof ApiFailure ? error.status : 500;
    return reply.code(status).send({ detail: error instanceof ApiFailure ? error.detail : 'Internal server error', requestId: request.id });
  });
  register(app);
  return app;
}

export type Role = 'owner' | 'admin' | 'member' | 'outsider';
export type AccessCall = { feature: string; write: boolean };
/** Node OrganizationGateway.requireAccess와 같은 규칙(멤버십, 쓰기=owner/admin, 기능 키)을 흉내 낸다. */
export function fakeOrganizations(role: Role, features: string[]) {
  const calls: AccessCall[] = [];
  return {
    calls,
    async requireAccess(_token: string, _id: string, feature: string, write = false) {
      calls.push({ feature, write });
      if (role === 'outsider') throw new ApiFailure(403, 'Organization membership required');
      if (write && role === 'member') throw new ApiFailure(403, 'Organization management permission required');
      if (!features.includes(feature)) throw new ApiFailure(403, 'Feature not available');
      return role;
    },
  };
}

export type FakeCall = { url: URL; method: string; headers: Record<string, string>; body: unknown };
export type FakeReply = { status?: number; body: unknown };
/** 호출을 기록하고 handler가 정한 응답을 돌려주는 가짜 fetch. handler가 배열 없이 단일 응답을 돌려주면 모든 호출에 같은 응답. */
export function fakeFetch(handler: (call: FakeCall) => FakeReply) {
  const calls: FakeCall[] = [];
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const call: FakeCall = { url: new URL(String(input)), method: init?.method ?? 'GET', headers: { ...(init?.headers as Record<string, string>) }, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const reply = handler(call);
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetcher, calls };
}
