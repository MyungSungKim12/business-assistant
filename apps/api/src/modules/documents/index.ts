import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../../config.js';
import { createDocumentGateway } from './gateway.js';
import { registerDocumentRoutes, type OrgAccess } from './routes.js';

export type { DocumentGateway } from './gateway.js';
export type { OrgAccess } from './routes.js';

/** 문서·동의서·템플릿·시술문서·파일 라우트를 등록하는 단일 진입점. */
export function registerDocumentModule(app: FastifyInstance, organizations: OrgAccess | undefined, config: ServerConfig, fetcher?: typeof fetch): void {
  registerDocumentRoutes(app, organizations, createDocumentGateway(config, fetcher));
}
