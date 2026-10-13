-- 043: 서명 증빙 해시 보관(DOC-10)과 시술 사진 전/후 구분(TRT-10).
-- 멱등: 같은 파일을 다시 실행해도 안전하다. 기존 마이그레이션·기존 행은 수정하지 않는다.
begin;

-- 1) 서명·교부·철회 이벤트의 증빙 해시.
--    treatment_document_events 는 append-only(020)라 컬럼을 채울 수 없으므로, 이벤트당 한 줄만 쌓는 별도 append-only 표에 둔다.
--    해시는 API 서버(Node)가 이벤트 행(서버 시각·서명 데이터·기록자 ID·발행본 내용 해시)으로 계산해 넣는다.
--    증빙이 없던 옛 이벤트는 행이 없는 상태(null)로 남는다.
create table if not exists public.treatment_document_event_proofs (
    event_id uuid primary key references public.treatment_document_events(id) on delete restrict,
    organization_id uuid not null references public.organizations(id) on delete restrict,
    document_id uuid not null,
    algorithm text not null check (algorithm in ('sha256-canonical-json-v1')),
    evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
    computed_at timestamptz not null default clock_timestamp(),
    created_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
    constraint event_proofs_document_scope foreign key (document_id, organization_id)
        references public.issued_treatment_documents(id, organization_id) on delete restrict
);
create index if not exists treatment_document_event_proofs_document
    on public.treatment_document_event_proofs (organization_id, document_id);
create index if not exists treatment_document_event_proofs_created_by
    on public.treatment_document_event_proofs (created_by);

alter table public.treatment_document_event_proofs enable row level security;

drop policy if exists event_proofs_select_member on public.treatment_document_event_proofs;
create policy event_proofs_select_member on public.treatment_document_event_proofs
    for select to authenticated
    using ((select private.has_organization_role(organization_id, array['owner', 'admin', 'member']::text[])));

-- 증빙은 이벤트를 기록할 수 있는 owner/admin 만 남기며, 대상 이벤트와 같은 조직·문서여야 한다.
drop policy if exists event_proofs_insert_manager on public.treatment_document_event_proofs;
create policy event_proofs_insert_manager on public.treatment_document_event_proofs
    for insert to authenticated
    with check (
        created_by = (select auth.uid())
        and (select private.has_organization_role(organization_id, array['owner', 'admin']::text[]))
        and exists (
            select 1 from public.treatment_document_events event
            where event.id = treatment_document_event_proofs.event_id
              and event.organization_id = treatment_document_event_proofs.organization_id
              and event.document_id = treatment_document_event_proofs.document_id
        )
    );

revoke all on public.treatment_document_event_proofs from public, anon, authenticated;
grant select, insert on public.treatment_document_event_proofs to authenticated;

-- 수정·삭제·비우기 금지(020 의 거부 함수 재사용).
drop trigger if exists event_proofs_immutable on public.treatment_document_event_proofs;
create trigger event_proofs_immutable
    before update or delete or truncate on public.treatment_document_event_proofs
    for each statement execute function private.reject_document_event_mutation();

-- 2) 시술 사진의 전/후 구분. 기존 행은 null(미분류)로 남고 화면에서는 '기타'로 취급한다.
alter table public.treatment_photos add column if not exists phase text;

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'treatment_photos_phase_check' and conrelid = 'public.treatment_photos'::regclass
    ) then
        alter table public.treatment_photos
            add constraint treatment_photos_phase_check check (phase is null or phase in ('before', 'after', 'other'));
    end if;
end
$$;

create index if not exists idx_treatment_photos_phase
    on public.treatment_photos (organization_id, treatment_id, phase);

commit;
