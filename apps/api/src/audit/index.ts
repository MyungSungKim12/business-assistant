import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config.js';
import { createAuditGateway, registerAuditRoutes, type AuditAccess } from './routes.js';

export { createAuditRecorder, sanitizeMetadata, type AuditEvent, type AuditRecorder } from './recorder.js';
export { registerAuditHooks } from './hooks.js';
export { createAuditGateway, registerAuditRoutes, auditQuery, encodeCursor, decodeCursor, type AuditAccess } from './routes.js';

/**
 * 감사 로그 조회 라우트 등록(owner/admin 전용). 기록 훅(registerAuditHooks)과 fail-closed 경로(고객 영구 삭제)는
 * app.ts 가 같은 기록기 인스턴스로 연결한다.
 */
export function registerAuditModule(app: FastifyInstance, organizations: AuditAccess | undefined, config: ServerConfig, fetcher?: typeof fetch): void {
  registerAuditRoutes(app, organizations, createAuditGateway(config, fetcher));
}
