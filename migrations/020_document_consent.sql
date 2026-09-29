begin;

alter table public.issued_treatment_documents add constraint issued_documents_id_org_unique unique(id,organization_id);
create table public.treatment_document_events (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete restrict,
 document_id uuid not null,
 revision integer not null check(revision>0),
 action text not null check(action in ('sign','deliver','revoke')),
 values jsonb not null check(jsonb_typeof(values)='object'),
 actor_id uuid not null references auth.users(id) on delete restrict,
 occurred_at timestamptz not null default clock_timestamp(),
 content_hash text not null check(content_hash ~ '^[0-9a-f]{64}$'),
 operation_id uuid not null,
 request_fingerprint jsonb not null,
 unique(document_id,revision),
 unique(organization_id,operation_id),
 foreign key(document_id,organization_id) references public.issued_treatment_documents(id,organization_id) on delete restrict
);
create index treatment_document_events_actor on public.treatment_document_events(actor_id);
alter table public.treatment_document_events enable row level security;
create policy document_events_member on public.treatment_document_events for select to authenticated
 using ((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
revoke all on public.treatment_document_events from public,anon,authenticated;
grant select on public.treatment_document_events to authenticated;

create function private.reject_document_event_mutation() returns trigger language plpgsql set search_path='' as $$
begin
 raise exception 'Document evidence is append-only' using errcode='42501';
end;
$$;
revoke all on function private.reject_document_event_mutation() from public,anon,authenticated;
create trigger document_events_immutable before update or delete or truncate on public.treatment_document_events
 for each statement execute function private.reject_document_event_mutation();

create function private.record_treatment_document_event(
 p_organization_id uuid,p_customer_id uuid,p_treatment_id uuid,p_document_id uuid,
 p_expected_revision integer,p_operation_id uuid,p_action text,p_values jsonb
) returns setof public.treatment_document_events language plpgsql security definer set search_path='' as $$
declare
 doc public.issued_treatment_documents%rowtype;
 receipt public.treatment_document_events%rowtype;
 fingerprint jsonb;
 current_revision integer;
 signed boolean;
 revoked boolean;
 stroke jsonb;
 point jsonb;
 first_point jsonb;
 distinct_point boolean=false;
 total_points integer=0;
 keys text[];
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then
  raise exception 'Document evidence requires organization manager' using errcode='42501';
 end if;
 if p_customer_id is null or p_treatment_id is null or p_document_id is null or p_operation_id is null
  or p_expected_revision is null or p_expected_revision<0 then
  raise exception 'Invalid event request' using errcode='22023';
 end if;
 -- All calls acquire operation lock before document row lock. The operation lock
 -- serializes reuse across documents, while the row lock serializes revisions.
 perform pg_advisory_xact_lock(hashtextextended('document-consent:'||p_organization_id::text||p_operation_id::text,0));
 select * into doc from public.issued_treatment_documents where id=p_document_id and organization_id=p_organization_id
  and customer_id=p_customer_id and treatment_id=p_treatment_id for update;
 if not found then raise exception 'Issued document not found' using errcode='P0002'; end if;
 fingerprint=jsonb_build_object('organization_id',p_organization_id,'customer_id',p_customer_id,'treatment_id',p_treatment_id,
  'document_id',p_document_id,'expected_revision',p_expected_revision,'actor_id',auth.uid(),'action',p_action,'values',p_values);
 select * into receipt from public.treatment_document_events where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if receipt.request_fingerprint<>fingerprint then raise exception 'Operation ID already used for different request' using errcode='P0001'; end if;
  return next receipt; return;
 end if;
 select coalesce(max(revision),0),coalesce(bool_or(action='sign'),false),coalesce(bool_or(action='revoke'),false)
  into current_revision,signed,revoked from public.treatment_document_events where document_id=doc.id;
 if p_expected_revision<>current_revision then raise exception 'Document evidence changed; reload' using errcode='P0001'; end if;
 if revoked then raise exception 'Document consent was revoked' using errcode='22023'; end if;
 if p_action is null or p_action not in ('sign','deliver','revoke') or jsonb_typeof(p_values) is distinct from 'object' then
  raise exception 'Invalid event values' using errcode='22023';
 end if;
 if p_values->'confirmed' is distinct from 'true'::jsonb then raise exception 'Explicit confirmation required' using errcode='22023'; end if;
 select array_agg(key order by key) into keys from jsonb_object_keys(p_values) as key;
 if p_action='sign' then
  if signed then raise exception 'Document already signed' using errcode='22023'; end if;
  if keys is distinct from array['confirmed','signer_name','strokes']::text[]
   or jsonb_typeof(p_values->'signer_name') is distinct from 'string'
   or length(p_values->>'signer_name') not between 1 and 100 or (p_values->>'signer_name') !~ '\S'
   or jsonb_typeof(p_values->'strokes') is distinct from 'array' then
   raise exception 'Invalid signature' using errcode='22023';
  end if;
  if jsonb_array_length(p_values->'strokes') not between 1 and 50 then raise exception 'Invalid stroke count' using errcode='22023'; end if;
  for stroke in select value from jsonb_array_elements(p_values->'strokes') loop
   if jsonb_typeof(stroke)<>'array' then raise exception 'Invalid stroke' using errcode='22023'; end if;
   if jsonb_array_length(stroke) not between 1 and 500 then raise exception 'Invalid point count' using errcode='22023'; end if;
   total_points=total_points+jsonb_array_length(stroke);
   if total_points>5000 then raise exception 'Too many signature points' using errcode='22023'; end if;
   for point in select value from jsonb_array_elements(stroke) loop
    if jsonb_typeof(point)<>'array' then raise exception 'Invalid point' using errcode='22023'; end if;
    if jsonb_array_length(point)<>2 or jsonb_typeof(point->0) is distinct from 'number' or jsonb_typeof(point->1) is distinct from 'number' then
     raise exception 'Point must contain two numbers' using errcode='22023';
    end if;
    if (point->>0)::numeric not between 0 and 1 or (point->>1)::numeric not between 0 and 1 then
     raise exception 'Point outside normalized bounds' using errcode='22023';
    end if;
    if first_point is null then first_point=point;
    elsif point<>first_point then distinct_point=true;
    end if;
   end loop;
  end loop;
  if not distinct_point then raise exception 'Two distinct signature coordinates required' using errcode='22023'; end if;
 elsif p_action='deliver' then
  if not signed then raise exception 'Signature required before delivery' using errcode='22023'; end if;
  if keys is distinct from array['confirmed','method','note','recipient','reference']::text[]
   or jsonb_typeof(p_values->'method') is distinct from 'string' or p_values->>'method' not in ('paper','email','sms','other')
   or jsonb_typeof(p_values->'recipient') is distinct from 'string' or length(p_values->>'recipient') not between 1 and 200 or (p_values->>'recipient') !~ '\S'
   or jsonb_typeof(p_values->'reference') is distinct from 'string' or length(p_values->>'reference')>500
   or jsonb_typeof(p_values->'note') is distinct from 'string' or length(p_values->>'note')>2000 then
   raise exception 'Invalid delivery evidence' using errcode='22023';
  end if;
 else
  if not signed then raise exception 'Signature required before revocation' using errcode='22023'; end if;
  if keys is distinct from array['confirmed','reason']::text[] or jsonb_typeof(p_values->'reason') is distinct from 'string'
   or length(p_values->>'reason') not between 1 and 2000 or (p_values->>'reason') !~ '\S' then
   raise exception 'Invalid revocation reason' using errcode='22023';
  end if;
 end if;
 insert into public.treatment_document_events(organization_id,document_id,revision,action,values,actor_id,content_hash,operation_id,request_fingerprint)
 values(p_organization_id,doc.id,current_revision+1,p_action,p_values,auth.uid(),
  encode(sha256(convert_to(jsonb_build_object('content',doc.content,'title',doc.title,'template_version',doc.template_version)::text,'UTF8')),'hex'),
  p_operation_id,fingerprint) returning * into receipt;
 return next receipt;
end;
$$;
revoke all on function private.record_treatment_document_event(uuid,uuid,uuid,uuid,integer,uuid,text,jsonb) from public,anon;
grant execute on function private.record_treatment_document_event(uuid,uuid,uuid,uuid,integer,uuid,text,jsonb) to authenticated;
create function public.record_treatment_document_event(
 p_organization_id uuid,p_customer_id uuid,p_treatment_id uuid,p_document_id uuid,
 p_expected_revision integer,p_operation_id uuid,p_action text,p_values jsonb
) returns setof public.treatment_document_events language sql security invoker set search_path='' as $$
 select * from private.record_treatment_document_event(p_organization_id,p_customer_id,p_treatment_id,p_document_id,p_expected_revision,p_operation_id,p_action,p_values);
$$;
revoke all on function public.record_treatment_document_event(uuid,uuid,uuid,uuid,integer,uuid,text,jsonb) from public,anon;
grant execute on function public.record_treatment_document_event(uuid,uuid,uuid,uuid,integer,uuid,text,jsonb) to authenticated;
commit;
