import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { ApiFailure } from '../errors.js';
import { createRest } from '../supabase/rest.js';

export type AuditEvent = {
  organizationId: string | null;
  /** `영역.행위` 형식의 소문자 코드(예: customer.delete, sale.refund). DB 도 같은 형식을 검사한다. */
  action: string;
  targetType: string;
  targetId?: string | null;
  /** 개인정보를 뺀 식별자·금액 정도만 넣는다. sanitizeMetadata 가 한 번 더 걸러 낸다. */
  metadata?: Record<string, unknown>;
  requestId?: string;
  ip?: string;
};

type Logger = { warn(object: unknown, message?: string): void };

const UNAVAILABLE = 'Audit log unavailable';
const MAX_KEYS = 20;
const MAX_STRING = 200;
// 이름·연락처·메모·사유 같은 자유 입력과 인증 값은 감사 로그에 넣지 않는다.
const BLOCKED_KEY = /name|phone|email|address|memo|note|reason|comment|content|password|token|secret|signature|stroke|recipient|birth/i;

/** 메타데이터를 숫자·불리언·짧은 문자열 스칼라만 남기도록 줄인다(최대 20개 키). */
export function sanitizeMetadata(metadata: Record<string, unknown> | undefined): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (Object.keys(result).length >= MAX_KEYS) break;
    if (BLOCKED_KEY.test(key) || value === undefined) continue;
    if (value === null || typeof value === 'boolean') result[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else if (typeof value === 'string') result[key] = value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
  }
  return result;
}

export type AuditRecorder = {
  /** 감사 기록 실패를 로그만 남기고 삼킨다(본 작업을 막지 않는다). */
  record(token: string, event: AuditEvent): Promise<void>;
  /** 기록에 실패하면 오류를 던진다. 고객 영구 삭제처럼 되돌릴 수 없는 작업은 작업 전에 이것을 호출한다(fail-closed). */
  recordRequired(token: string, event: AuditEvent): Promise<void>;
};

/** 사용자 토큰으로 보안 정의 RPC `record_audit_event` 를 호출한다(일반 API 에는 서비스 키가 없다). */
export function createAuditRecorder(config: ServerConfig, fetcher: typeof fetch = fetch, logger?: Logger): AuditRecorder {
  const rest = createRest(config, fetcher, UNAVAILABLE);
  async function write(token: string, event: AuditEvent): Promise<void> {
    await rest.rpc(token, 'record_audit_event', {
      p_organization_id: event.organizationId,
      p_action: event.action,
      p_target_type: event.targetType,
      p_target_id: event.targetId ?? null,
      p_metadata: sanitizeMetadata(event.metadata),
      p_request_id: event.requestId ?? null,
      p_ip: event.ip ?? null,
    }, z.uuid());
  }
  const statusOf = (error: unknown) => (error instanceof ApiFailure ? error.status : undefined);
  return {
    async record(token, event) {
      try { await write(token, event); } catch (error) {
        logger?.warn({ action: event.action, status: statusOf(error), requestId: event.requestId }, 'audit event was not recorded');
      }
    },
    async recordRequired(token, event) {
      try { await write(token, event); } catch (error) {
        logger?.warn({ action: event.action, status: statusOf(error), requestId: event.requestId }, 'audit event was not recorded; operation refused');
        if (error instanceof ApiFailure && (error.status === 401 || error.status === 403)) throw error;
        throw new ApiFailure(503, UNAVAILABLE);
      }
    },
  };
}
