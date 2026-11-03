-- DOC-012: 고객 모바일 발급본 서명 링크. 토큰은 해시만 저장하며 공개 응답은 발급본 최소 정보만 반환한다.
begin;

create table public.treatment_document_signature_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete restrict,
  treatment_id uuid not null references public.treatment_records(id) on delete restrict,
  document_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (document_id, organization_id) references public.issued_treatment_documents(id, organization_id) on delete restrict,
  check (expires_at > created_at)
);
create index treatment_document_signature_links_scope on public.treatment_document_signature_links(organization_id,document_id,created_at desc);
alter table public.treatment_document_signature_links enable row level security;
revoke all on public.treatment_document_signature_links from public, anon, authenticated;

alter table public.treatment_document_events alter column actor_id drop not null;
alter table public.treatment_document_events add column signer_channel text not null default 'staff' check (signer_channel in ('staff','customer_link'));
alter table public.treatment_document_event_proofs alter column created_by drop not null;
alter table public.treatment_document_event_proofs drop constraint if exists treatment_document_event_proofs_algorithm_check;
alter table public.treatment_document_event_proofs add constraint treatment_document_event_proofs_algorithm_check
 check (algorithm in ('sha256-canonical-json-v1','sha256-pg-jsonb-v1'));

create function public.create_customer_document_signature_link(
 p_organization_id uuid,p_customer_id uuid,p_treatment_id uuid,p_document_id uuid,p_token_hash text,p_expires_at timestamptz
) returns table(id uuid,expires_at timestamptz) language plpgsql security definer set search_path='' as $$
declare doc public.issued_treatment_documents%rowtype; created_id uuid;
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then raise exception 'Document manager required' using errcode='42501'; end if;
 if p_token_hash !~ '^[0-9a-f]{64}$' or p_expires_at<=clock_timestamp() or p_expires_at>clock_timestamp()+interval '30 days' then raise exception 'Invalid signature link' using errcode='22023'; end if;
 select d.* into doc from public.issued_treatment_documents d where d.id=p_document_id and d.organization_id=p_organization_id and d.customer_id=p_customer_id and d.treatment_id=p_treatment_id for update;
 if not found then raise exception 'Issued document not found' using errcode='P0002'; end if;
 if exists(select 1 from public.treatment_document_events where document_id=p_document_id and action in ('sign','revoke')) then raise exception 'Document is already signed or revoked' using errcode='22023'; end if;
 update public.treatment_document_signature_links set revoked_at=clock_timestamp() where document_id=p_document_id and consumed_at is null and revoked_at is null;
 insert into public.treatment_document_signature_links(organization_id,customer_id,treatment_id,document_id,token_hash,expires_at,created_by)
 values(p_organization_id,p_customer_id,p_treatment_id,p_document_id,p_token_hash,p_expires_at,auth.uid()) returning treatment_document_signature_links.id into created_id;
 return query select created_id,p_expires_at;
end; $$;
revoke all on function public.create_customer_document_signature_link(uuid,uuid,uuid,uuid,text,timestamptz) from public,anon;
grant execute on function public.create_customer_document_signature_link(uuid,uuid,uuid,uuid,text,timestamptz) to authenticated;

create function public.revoke_customer_document_signature_link(p_organization_id uuid,p_link_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then raise exception 'Document manager required' using errcode='42501'; end if;
 update public.treatment_document_signature_links set revoked_at=clock_timestamp()
 where id=p_link_id and organization_id=p_organization_id and consumed_at is null and revoked_at is null;
 return found;
end; $$;
revoke all on function public.revoke_customer_document_signature_link(uuid,uuid) from public,anon;
grant execute on function public.revoke_customer_document_signature_link(uuid,uuid) to authenticated;

create function public.preview_customer_document_signature(p_token_hash text)
returns table(title text,content text,template_version integer,expires_at timestamptz)
language sql security definer set search_path='' as $$
 select d.title,d.content,d.template_version,l.expires_at
 from public.treatment_document_signature_links l join public.issued_treatment_documents d on d.id=l.document_id and d.organization_id=l.organization_id
 where l.token_hash=p_token_hash and l.expires_at>clock_timestamp() and l.consumed_at is null and l.revoked_at is null
 and not exists(select 1 from public.treatment_document_events e where e.document_id=d.id and e.action in ('sign','revoke'));
$$;
revoke all on function public.preview_customer_document_signature(text) from public,authenticated;
grant execute on function public.preview_customer_document_signature(text) to anon;

create function public.submit_customer_document_signature(p_token_hash text,p_operation_id uuid,p_signer_name text,p_strokes jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare l public.treatment_document_signature_links%rowtype; d public.issued_treatment_documents%rowtype; revision_now integer; event_row public.treatment_document_events%rowtype; values_json jsonb; stroke jsonb; point jsonb; total_points integer:=0; first_point jsonb; distinct_point boolean:=false;
begin
 if p_operation_id is null or p_signer_name is null or length(btrim(p_signer_name)) not between 1 and 100 or jsonb_typeof(p_strokes) is distinct from 'array' then raise exception 'Invalid signature' using errcode='22023'; end if;
 select * into l from public.treatment_document_signature_links where token_hash=p_token_hash for update;
 if not found then raise exception 'Signature link unavailable' using errcode='P0002'; end if;
 if l.consumed_at is not null then
   select * into event_row from public.treatment_document_events e where e.organization_id=l.organization_id and e.operation_id=p_operation_id;
   if found and event_row.document_id=l.document_id and event_row.signer_channel='customer_link'
     and event_row.values=jsonb_build_object('confirmed',true,'signer_name',btrim(p_signer_name),'strokes',p_strokes) then return true; end if;
   raise exception 'Signature link unavailable' using errcode='P0002';
 end if;
 if l.expires_at<=clock_timestamp() or l.revoked_at is not null then raise exception 'Signature link unavailable' using errcode='P0002'; end if;
 select * into d from public.issued_treatment_documents where id=l.document_id and organization_id=l.organization_id and customer_id=l.customer_id and treatment_id=l.treatment_id for update;
 if not found then raise exception 'Issued document not found' using errcode='P0002'; end if;
 if jsonb_array_length(p_strokes) not between 1 and 50 then raise exception 'Invalid signature' using errcode='22023'; end if;
 for stroke in select value from jsonb_array_elements(p_strokes) loop
   if jsonb_typeof(stroke)<>'array' or jsonb_array_length(stroke) not between 1 and 500 then raise exception 'Invalid signature stroke' using errcode='22023'; end if;
   total_points:=total_points+jsonb_array_length(stroke); if total_points>5000 then raise exception 'Signature too large' using errcode='22023'; end if;
   for point in select value from jsonb_array_elements(stroke) loop
     if jsonb_typeof(point)<>'array' or jsonb_array_length(point)<>2 or jsonb_typeof(point->0)<>'number' or jsonb_typeof(point->1)<>'number'
       or (point->>0)::numeric not between 0 and 1 or (point->>1)::numeric not between 0 and 1 then raise exception 'Invalid signature point' using errcode='22023'; end if;
     if first_point is null then first_point:=point; elsif point<>first_point then distinct_point:=true; end if;
   end loop;
 end loop;
 if not distinct_point then raise exception 'Signature must contain distinct points' using errcode='22023'; end if;
 select coalesce(max(revision),0) into revision_now from public.treatment_document_events where document_id=d.id;
 if exists(select 1 from public.treatment_document_events where document_id=d.id and action in ('sign','revoke')) then raise exception 'Document already signed or revoked' using errcode='22023'; end if;
 values_json:=jsonb_build_object('confirmed',true,'signer_name',btrim(p_signer_name),'strokes',p_strokes);
 insert into public.treatment_document_events(organization_id,document_id,revision,action,values,actor_id,signer_channel,content_hash,operation_id,request_fingerprint)
 values(l.organization_id,d.id,revision_now+1,'sign',values_json,null,'customer_link',encode(sha256(convert_to(jsonb_build_object('content',d.content,'title',d.title,'template_version',d.template_version)::text,'UTF8')),'hex'),p_operation_id,
 jsonb_build_object('link_id',l.id,'document_id',d.id,'operation_id',p_operation_id,'action','sign','values',values_json)) returning * into event_row;
 insert into public.treatment_document_event_proofs(event_id,organization_id,document_id,algorithm,evidence_hash,created_by)
 values(event_row.id,event_row.organization_id,event_row.document_id,'sha256-pg-jsonb-v1',
 encode(sha256(convert_to(jsonb_build_object('algorithm','sha256-pg-jsonb-v1','organization_id',event_row.organization_id,'document_id',event_row.document_id,
 'event_id',event_row.id,'revision',event_row.revision,'action',event_row.action,'content_hash',event_row.content_hash,'values',event_row.values,
 'actor_id',event_row.actor_id,'occurred_at',event_row.occurred_at)::text,'UTF8')),'hex'),null);
 update public.treatment_document_signature_links set consumed_at=clock_timestamp() where id=l.id;
 return true;
end; $$;
revoke all on function public.submit_customer_document_signature(text,uuid,text,jsonb) from public,authenticated;
grant execute on function public.submit_customer_document_signature(text,uuid,text,jsonb) to anon;

create function public.verify_customer_document_signature_evidence(p_organization_id uuid,p_document_id uuid,p_event_id uuid)
returns table(event_id uuid,revision integer,occurred_at timestamptz,status text,algorithm text,stored_hash text,computed_hash text)
language plpgsql security definer set search_path='' as $$
declare e public.treatment_document_events%rowtype; proof public.treatment_document_event_proofs%rowtype; calculated text;
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin','member']::text[]) then raise exception 'Document access required' using errcode='42501'; end if;
 select * into e from public.treatment_document_events where id=p_event_id and organization_id=p_organization_id and document_id=p_document_id;
 if not found then raise exception 'Document event not found' using errcode='P0002'; end if;
 select * into proof from public.treatment_document_event_proofs where treatment_document_event_proofs.event_id=e.id;
 if not found then return query select e.id,e.revision,e.occurred_at,'no_proof'::text,null::text,null::text,null::text; return; end if;
 calculated:=encode(sha256(convert_to(jsonb_build_object('algorithm',proof.algorithm,'organization_id',e.organization_id,'document_id',e.document_id,'event_id',e.id,
 'revision',e.revision,'action',e.action,'content_hash',e.content_hash,'values',e.values,'actor_id',e.actor_id,'occurred_at',e.occurred_at)::text,'UTF8')),'hex');
 return query select e.id,e.revision,e.occurred_at,case when proof.algorithm<>'sha256-pg-jsonb-v1' then 'unknown_algorithm' when calculated=proof.evidence_hash then 'match' else 'mismatch' end::text,
 proof.algorithm,proof.evidence_hash,case when proof.algorithm='sha256-pg-jsonb-v1' then calculated else null end;
end; $$;
revoke all on function public.verify_customer_document_signature_evidence(uuid,uuid,uuid) from public,anon;
grant execute on function public.verify_customer_document_signature_evidence(uuid,uuid,uuid) to authenticated;

commit;
