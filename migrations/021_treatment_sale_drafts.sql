begin;

create table public.treatment_sale_drafts (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete restrict,
 customer_id uuid not null,
 treatment_id uuid not null,
 status text not null default 'draft' check(status='draft'),
 description text not null check(length(description) between 1 and 200 and description ~ '\S'),
 amount numeric(14,2) not null check(amount>=0),
 source_snapshot jsonb not null check(jsonb_typeof(source_snapshot)='object'),
 created_by uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default clock_timestamp(),
 operation_id uuid not null,
 request_fingerprint jsonb not null,
 unique(organization_id,treatment_id),
 unique(organization_id,operation_id),
 foreign key(customer_id,organization_id) references public.customers(id,organization_id) on delete restrict,
 foreign key(treatment_id,customer_id) references public.treatment_records(id,customer_id) on delete restrict
);
create index treatment_sale_drafts_inbox on public.treatment_sale_drafts(organization_id,created_at desc,id);
create index treatment_sale_drafts_customer on public.treatment_sale_drafts(customer_id,organization_id);
create index treatment_sale_drafts_treatment on public.treatment_sale_drafts(treatment_id,customer_id);
create index treatment_sale_drafts_actor on public.treatment_sale_drafts(created_by);
alter table public.treatment_sale_drafts enable row level security;
create policy sale_drafts_member on public.treatment_sale_drafts for select to authenticated
 using ((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
revoke all on public.treatment_sale_drafts from public,anon,authenticated;
grant select on public.treatment_sale_drafts to authenticated;

create function private.reject_sale_draft_mutation() returns trigger language plpgsql set search_path='' as $$
begin
 raise exception 'Sale handoff is immutable' using errcode='42501';
end;
$$;
revoke all on function private.reject_sale_draft_mutation() from public,anon,authenticated;
create trigger sale_drafts_immutable before update or delete or truncate on public.treatment_sale_drafts
 for each statement execute function private.reject_sale_draft_mutation();

create function private.render_treatment_sale_draft(
 p_organization_id uuid,p_customer_id uuid,p_treatment_id uuid,p_values jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 c public.customers%rowtype;
 t public.treatment_records%rowtype;
 d public.issued_treatment_documents%rowtype;
 keys text[];
 amount_text text;
 consent_status text='not_linked';
 revision integer=0;
 signed boolean;
 revoked boolean;
 snapshot jsonb;
 warnings jsonb='[]'::jsonb;
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin','member']::text[]) then
  raise exception 'Organization membership required' using errcode='42501';
 end if;
 if jsonb_typeof(p_values) is distinct from 'object' then raise exception 'Invalid sale values' using errcode='22023'; end if;
 select array_agg(key order by key) into keys from jsonb_object_keys(p_values) as key;
 if keys is distinct from array['amount','consent_document_id','description','exception_reason','partial_reason']::text[]
  or jsonb_typeof(p_values->'description') is distinct from 'string'
  or length(p_values->>'description') not between 1 and 200 or (p_values->>'description') !~ '\S'
  or jsonb_typeof(p_values->'amount') is distinct from 'string'
  or length(p_values->>'amount')>15 or (p_values->>'amount') !~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$'
  or jsonb_typeof(p_values->'exception_reason') is distinct from 'string' or length(p_values->>'exception_reason')>2000
  or jsonb_typeof(p_values->'partial_reason') is distinct from 'string' or length(p_values->>'partial_reason')>2000 then
  raise exception 'Invalid sale values' using errcode='22023';
 end if;
 if p_values->'consent_document_id'<>'null'::jsonb then
  if jsonb_typeof(p_values->'consent_document_id') is distinct from 'string'
   or (p_values->>'consent_document_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
   raise exception 'Invalid consent document ID' using errcode='22023';
  end if;
 end if;
 -- Shared source locks match consultation/issuance order. Consent events lock
 -- the issued document FOR UPDATE, so its revision remains stable until commit.
 select * into t from public.treatment_records where id=p_treatment_id and customer_id=p_customer_id and organization_id=p_organization_id for share;
 if not found then raise exception 'Treatment not found' using errcode='P0002'; end if;
 select * into c from public.customers where id=p_customer_id and organization_id=p_organization_id for share;
 if not found then raise exception 'Customer not found' using errcode='P0002'; end if;
 if t.status not in ('completed','cancelled') then raise exception 'Completed or cancelled treatment required' using errcode='22023'; end if;
 if t.status='cancelled' then
  if (p_values->>'partial_reason') !~ '\S' then raise exception 'Partial treatment reason required' using errcode='22023'; end if;
  warnings=warnings||jsonb_build_array('중단 시술의 실제 제공 내역과 청구 금액을 확인하세요.');
 end if;
 if p_values->'consent_document_id'<>'null'::jsonb then
  select * into d from public.issued_treatment_documents where id=(p_values->>'consent_document_id')::uuid
   and organization_id=p_organization_id and customer_id=p_customer_id and treatment_id=p_treatment_id for share;
  if not found then raise exception 'Issued consent document not found' using errcode='P0002'; end if;
  select coalesce(max(e.revision),0),coalesce(bool_or(action='sign'),false),coalesce(bool_or(action='revoke'),false)
   into revision,signed,revoked from public.treatment_document_events e where document_id=d.id;
  consent_status=case when revoked then 'revoked' when signed then 'signed' else 'unsigned' end;
 end if;
 if consent_status<>'signed' then
  if (p_values->>'exception_reason') !~ '\S' then raise exception 'Consent exception reason required' using errcode='22023'; end if;
  warnings=warnings||jsonb_build_array('유효한 서명 동의가 확인되지 않았습니다. 예외 사유를 기록하며 동의 완료로 간주하지 않습니다.');
 end if;
 amount_text=((p_values->>'amount')::numeric(14,2))::text;
 snapshot=jsonb_build_object('organization_id',p_organization_id,
  'customer',jsonb_build_object('id',c.id,'name',c.name,'phone',c.phone,'updated_at',c.updated_at),
  'treatment',jsonb_build_object('id',t.id,'version',t.version,'status',t.status,'name',t.treatment_name,
   'date',t.treatment_date,'practitioner',t.practitioner,'updated_at',t.updated_at),
  'consent',jsonb_build_object('document_id',d.id,'template_version',d.template_version,'revision',revision,'status',consent_status,
   'content_hash',case when d.id is null then null else encode(sha256(convert_to(jsonb_build_object('content',d.content,'title',d.title,'template_version',d.template_version)::text,'UTF8')),'hex') end),
  'exception_reason',p_values->>'exception_reason','partial_reason',p_values->>'partial_reason');
 return jsonb_build_object('values',p_values,'line',jsonb_build_object('description',p_values->>'description','quantity',1,
  'unit_price',amount_text,'line_total',amount_text,'practitioner',coalesce(t.practitioner,'')),
  'total_amount',amount_text,'source_snapshot',snapshot,'consent_status',consent_status,'warnings',warnings);
end;
$$;
revoke all on function private.render_treatment_sale_draft(uuid,uuid,uuid,jsonb) from public,anon,authenticated;

create function public.preview_treatment_sale_draft(
 p_organization_id uuid,p_customer_id uuid,p_treatment_id uuid,p_values jsonb
) returns jsonb language sql security definer set search_path='' as $$
 select private.render_treatment_sale_draft(p_organization_id,p_customer_id,p_treatment_id,p_values);
$$;
revoke all on function public.preview_treatment_sale_draft(uuid,uuid,uuid,jsonb) from public,anon;
grant execute on function public.preview_treatment_sale_draft(uuid,uuid,uuid,jsonb) to authenticated;

create function public.create_treatment_sale_draft(
 p_organization_id uuid,p_customer_id uuid,p_treatment_id uuid,p_operation_id uuid,p_expected_preview jsonb,p_confirmed boolean
) returns setof public.treatment_sale_drafts language plpgsql security definer set search_path='' as $$
declare
 receipt public.treatment_sale_drafts%rowtype;
 fingerprint jsonb;
 preview jsonb;
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then
  raise exception 'Sale draft creation requires organization manager' using errcode='42501';
 end if;
 if p_customer_id is null or p_treatment_id is null or p_operation_id is null
  or jsonb_typeof(p_expected_preview) is distinct from 'object' or p_confirmed is distinct from true then
  raise exception 'Explicit confirmation and reviewed preview required' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('treatment-sale-draft:'||p_organization_id::text||p_operation_id::text,0));
 fingerprint=jsonb_build_object('organization_id',p_organization_id,'customer_id',p_customer_id,'treatment_id',p_treatment_id,
  'actor_id',auth.uid(),'expected_preview',p_expected_preview,'confirmed',p_confirmed);
 select * into receipt from public.treatment_sale_drafts where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if receipt.request_fingerprint<>fingerprint then raise exception 'Operation ID already used for different request' using errcode='P0001'; end if;
  return next receipt; return;
 end if;
 -- Exclusive treatment lock serializes distinct operations for the same source.
 perform 1 from public.treatment_records where id=p_treatment_id and customer_id=p_customer_id and organization_id=p_organization_id for update;
 if not found then raise exception 'Treatment not found' using errcode='P0002'; end if;
 if exists(select 1 from public.treatment_sale_drafts where organization_id=p_organization_id and treatment_id=p_treatment_id) then
  raise exception 'Treatment already has a sale draft' using errcode='P0001';
 end if;
 preview=private.render_treatment_sale_draft(p_organization_id,p_customer_id,p_treatment_id,p_expected_preview->'values');
 if preview<>p_expected_preview then raise exception 'Preview changed; review again' using errcode='P0001'; end if;
 insert into public.treatment_sale_drafts(organization_id,customer_id,treatment_id,description,amount,source_snapshot,created_by,operation_id,request_fingerprint)
 values(p_organization_id,p_customer_id,p_treatment_id,preview->'line'->>'description',(preview->>'total_amount')::numeric,
  preview->'source_snapshot',auth.uid(),p_operation_id,fingerprint) returning * into receipt;
 return next receipt;
end;
$$;
revoke all on function public.create_treatment_sale_draft(uuid,uuid,uuid,uuid,jsonb,boolean) from public,anon;
grant execute on function public.create_treatment_sale_draft(uuid,uuid,uuid,uuid,jsonb,boolean) to authenticated;
commit;
