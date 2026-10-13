import { createHash } from 'node:crypto';
import { z } from 'zod';

/** 서명·교부·철회 증빙 해시 규칙의 이름. 규칙을 바꾸면 새 이름(v2)을 쓰고 이전 증빙은 이전 이름으로 검증한다. */
export const EVIDENCE_ALGORITHM = 'sha256-canonical-json-v1';

/** 증빙 해시에 들어가는 값. 모두 DB가 돌려준 이벤트 행에서 가져오므로 기록 시점과 검증 시점이 같은 입력을 쓴다. */
export type EvidenceInput = {
  organization_id: string;
  document_id: string;
  event_id: string;
  revision: number;
  action: string;
  /** 발행본 내용(제목·본문·서식 버전)의 SHA-256. DB 함수가 이벤트 기록 때 계산해 둔 값. */
  content_hash: string;
  /** 서명 획 데이터·교부·철회 값 전체. */
  values: Record<string, unknown>;
  /** 서명자(기록자) 계정 ID. */
  actor_id: string;
  /** DB 서버가 정한 기록 시각(클라이언트가 보낸 값이 아니다). */
  occurred_at: string;
};

export type StoredEvidence = { algorithm: string; hash: string };
export type EvidenceStatus = 'match' | 'mismatch' | 'no_proof' | 'unknown_algorithm';
export type EvidenceVerification = {
  event_id: string;
  revision: number;
  status: EvidenceStatus;
  algorithm: string | null;
  stored_hash: string | null;
  computed_hash: string | null;
  occurred_at: string;
};

/** 키를 정렬하고 공백 없이 직렬화한다. 같은 값이면 어느 환경에서도 같은 문자열이 된다. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export function computeEvidenceHash(input: EvidenceInput): string {
  const payload = {
    algorithm: EVIDENCE_ALGORITHM,
    organization_id: input.organization_id,
    document_id: input.document_id,
    event_id: input.event_id,
    revision: input.revision,
    action: input.action,
    content_hash: input.content_hash,
    values: input.values,
    actor_id: input.actor_id,
    occurred_at: input.occurred_at,
  };
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

export function evidenceInputOf(event: EvidenceInput): EvidenceInput {
  const { organization_id, document_id, event_id, revision, action, content_hash, values, actor_id, occurred_at } = event;
  return { organization_id, document_id, event_id, revision, action, content_hash, values, actor_id, occurred_at };
}

/** 저장된 증빙과 지금 이벤트 행으로 다시 계산한 값을 비교한다. 증빙이 없던 옛 이벤트는 no_proof. */
export function verifyEvidence(input: EvidenceInput, stored: StoredEvidence | null): EvidenceVerification {
  const base = { event_id: input.event_id, revision: input.revision, occurred_at: input.occurred_at };
  if (!stored) return { ...base, status: 'no_proof', algorithm: null, stored_hash: null, computed_hash: null };
  if (stored.algorithm !== EVIDENCE_ALGORITHM) {
    return { ...base, status: 'unknown_algorithm', algorithm: stored.algorithm, stored_hash: stored.hash, computed_hash: null };
  }
  const computed = computeEvidenceHash(input);
  return { ...base, status: computed === stored.hash ? 'match' : 'mismatch', algorithm: stored.algorithm, stored_hash: stored.hash, computed_hash: computed };
}

/** PostgREST 임베드(`proof:...`)는 단일 객체 또는 배열로 올 수 있어 둘 다 받는다. */
export const proofColumnSchema = z.object({ algorithm: z.string(), evidence_hash: z.string().regex(/^[0-9a-f]{64}$/) });
export const embeddedProofSchema = z.union([proofColumnSchema, z.array(proofColumnSchema)]).nullable().optional();

export function storedEvidenceOf(embedded: z.infer<typeof embeddedProofSchema>): StoredEvidence | null {
  const proof = Array.isArray(embedded) ? embedded[0] : embedded;
  return proof ? { algorithm: proof.algorithm, hash: proof.evidence_hash } : null;
}
