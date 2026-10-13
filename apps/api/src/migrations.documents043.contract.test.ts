// 043_document_evidence_photo_phase.sql 계약 테스트: 멱등성, RLS, append-only, 권한 회수, 하위 호환(nullable).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(import.meta.dirname, '../../../migrations/043_document_evidence_photo_phase.sql'), 'utf-8').replace(/\r\n?/g, '\n').toLowerCase();
const has = (needle: string) => expect(sql.includes(needle), needle).toBe(true);

describe('043_document_evidence_photo_phase.sql', () => {
  it('하나의 트랜잭션이고 다시 실행해도 안전하다', () => {
    expect(sql.match(/^begin;$/gm)).toHaveLength(1);
    expect(sql.match(/^commit;$/gm)).toHaveLength(1);
    has('create table if not exists public.treatment_document_event_proofs');
    has('add column if not exists phase text');
    has('create index if not exists idx_treatment_photos_phase');
    has('drop policy if exists event_proofs_select_member');
    has('drop policy if exists event_proofs_insert_manager');
    has('drop trigger if exists event_proofs_immutable');
    expect(sql).not.toMatch(/\bdrop table\b|\bdrop column\b|\btruncate table\b/);
  });

  it('증빙 표는 이벤트당 한 줄(PK=event_id)이고 해시 형식·알고리즘을 제한한다', () => {
    has('event_id uuid primary key references public.treatment_document_events(id)');
    has("check (evidence_hash ~ '^[0-9a-f]{64}$')");
    has("check (algorithm in ('sha256-canonical-json-v1'))");
    has('references public.issued_treatment_documents(id, organization_id)');
  });

  it('RLS: 조회는 멤버, 기록은 owner/admin 이고 대상 이벤트와 같은 조직·문서여야 한다', () => {
    has('alter table public.treatment_document_event_proofs enable row level security');
    has("array['owner', 'admin', 'member']::text[]");
    has("array['owner', 'admin']::text[]");
    has('created_by = (select auth.uid())');
    has('event.organization_id = treatment_document_event_proofs.organization_id');
    has('event.document_id = treatment_document_event_proofs.document_id');
    expect(sql).not.toMatch(/for (update|delete|all)\b/);
  });

  it('권한은 select/insert 만 주고 anon 은 전부 회수하며 수정·삭제·비우기는 트리거로 막는다', () => {
    has('revoke all on public.treatment_document_event_proofs from public, anon, authenticated');
    has('grant select, insert on public.treatment_document_event_proofs to authenticated');
    expect(sql).not.toMatch(/grant [^;]*\b(update|delete|truncate)\b[^;]* on public\.treatment_document_event_proofs/);
    has('before update or delete or truncate on public.treatment_document_event_proofs');
    has('private.reject_document_event_mutation()');
  });

  it('이 마이그레이션은 보안 정의 함수를 만들지 않으므로 search_path 고정 대상이 없다', () => {
    expect(sql).not.toContain('security definer');
    expect(sql).not.toMatch(/create (or replace )?function/);
  });

  it('시술 사진 phase 는 nullable 이고 before/after/other 만 허용한다(기존 행은 null)', () => {
    has('add column if not exists phase text;');
    expect(sql).not.toMatch(/phase text not null/);
    has("check (phase is null or phase in ('before', 'after', 'other'))");
    has("conname = 'treatment_photos_phase_check'");
  });
});
