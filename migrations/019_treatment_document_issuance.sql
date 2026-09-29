begin;

create table public.issued_treatment_documents (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete restrict,
 customer_id uuid not null,
 treatment_id uuid not null,
 template_id uuid not null references public.document_templates(id) on delete restrict,
 template_version integer not null,
 title text not null check (length(btrim(title)) between 1 and 200),
 content text not null check (length(content) between 1 and 100000),
 source_snapshot jsonb not null check (jsonb_typeof(source_snapshot)='object'),
 issued_by uuid not null references auth.users(id) on delete restrict,
 issued_at timestamptz not null default clock_timestamp(),
 operation_id uuid not null,
 request_fingerprint jsonb not null,
 unique(organization_id,operation_id),
 foreign key(customer_id,organization_id) references public.customers(id,organization_id) on delete restrict,
 foreign key(treatment_id,customer_id) references public.treatment_records(id,customer_id) on delete restrict,
 foreign key(template_id,template_version) references public.document_template_versions(template_id,version) on delete restrict
);
create index issued_treatment_documents_scope on public.issued_treatment_documents(organization_id,customer_id,treatment_id,issued_at desc,id);
create index issued_treatment_documents_treatment on public.issued_treatment_documents(treatment_id,customer_id);
create index issued_treatment_documents_template on public.issued_treatment_documents(template_id,template_version);
create index issued_treatment_documents_actor on public.issued_treatment_documents(issued_by);
alter table public.issued_treatment_documents enable row level security;
create policy issued_documents_member on public.issued_treatment_documents for select to authenticated
 using ((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
revoke all on public.issued_treatment_documents from public,anon,authenticated;
grant select on public.issued_treatment_documents to authenticated;

-- Internal renderer is never directly executable by clients. Only the checked
-- preview/issue entry points invoke it. SHARE prevents source edits through commit.
create function private.render_treatment_document(
 p_organization_id uuid,p_customer_id uuid,p_treatment_id uuid,p_template_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 c public.customers%rowtype;
 t public.treatment_records%rowtype;
 d public.document_templates%rowtype;
 v public.document_template_versions%rowtype;
 fields jsonb;
 snapshot jsonb;
 output text='';
 missing text[]='{}';
 token text;
 key text;
 value text;
 pos integer=1;
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin','member']::text[]) then
  raise exception 'Organization membership required' using errcode='42501';
 end if;
 -- Match migration 017: treatment before customer, then template.
 select * into t from public.treatment_records where id=p_treatment_id and customer_id=p_customer_id and organization_id=p_organization_id for share;
 if not found then raise exception 'Treatment not found' using errcode='P0002'; end if;
 select * into c from public.customers where id=p_customer_id and organization_id=p_organization_id for share;
 if not found then raise exception 'Customer not found' using errcode='P0002'; end if;
 select * into d from public.document_templates where id=p_template_id and organization_id=p_organization_id for share;
 if not found then raise exception 'Template not found' using errcode='P0002'; end if;
 if d.status<>'published' or d.is_archived then raise exception 'Published template required' using errcode='22023'; end if;
 select * into v from public.document_template_versions where template_id=d.id and version=d.version and organization_id=p_organization_id;
 if not found then raise exception 'Published version not found' using errcode='P0002'; end if;
 if v.content !~ '\S' or length(v.content)>100000 or length(btrim(v.name)) not between 1 and 200 then
  raise exception 'Invalid published template content' using errcode='22023';
 end if;
 fields=jsonb_build_object('customer.name',c.name,'customer.phone',c.phone,
  'customer.birth_date',to_char(c.birth_date,'YYYY-MM-DD'),'treatment.name',t.treatment_name,
  'treatment.date',to_char(t.treatment_date,'YYYY-MM-DD'),'treatment.practitioner',t.practitioner,
  'treatment.amount',t.amount::text,'treatment.consultation_goal',t.consultation_goal);
 snapshot=jsonb_build_object('organization_id',p_organization_id,
  'customer',jsonb_build_object('id',c.id,'name',c.name,'phone',c.phone,'birth_date',c.birth_date,'updated_at',c.updated_at),
  'treatment',jsonb_build_object('id',t.id,'name',t.treatment_name,'date',t.treatment_date,'practitioner',t.practitioner,
    'amount',t.amount,'consultation_goal',t.consultation_goal,'version',t.version,'updated_at',t.updated_at,'status',t.status),
  'template',jsonb_build_object('id',d.id,'version',d.version,'revision',d.revision,'published_at',v.published_at));
 -- Scan only original template text. Inserted customer data is never reparsed.
 while pos<=length(v.content) loop
  token=substring(substr(v.content,pos) from '^[^{}]+');
  if token is not null then
   output=output||token;
   pos=pos+length(token);
   if length(output)>100000 then raise exception 'Rendered content exceeds 100000 characters' using errcode='22023'; end if;
   continue;
  end if;
  token=substring(substr(v.content,pos) from '^\{\{[^{}]*\}\}');
  if token is not null then
   key=substr(token,3,length(token)-4);
   value=fields->>key;
   if not (fields ? key) or coalesce(value,'') !~ '\S' then
    if not (key=any(missing)) then missing=array_append(missing,key); end if;
    output=output||token;
   else output=output||value;
   end if;
   pos=pos+length(token);
  else
   if substr(v.content,pos,1) in ('{','}') and not ('malformed_placeholder'=any(missing)) then
    missing=array_append(missing,'malformed_placeholder');
   end if;
   output=output||substr(v.content,pos,1);
   pos=pos+1;
  end if;
  if length(output)>100000 then raise exception 'Rendered content exceeds 100000 characters' using errcode='22023'; end if;
 end loop;
 return jsonb_build_object('template_id',d.id,'template_version',d.version,'title',v.name,
  'content',output,'source_snapshot',snapshot,'missing_fields',to_jsonb(missing));
end;
$$;
revoke all on function private.render_treatment_document(uuid,uuid,uuid,uuid) from public,anon,authenticated;

create function private.preview_treatment_document(
 p_organization_id uuid,p_customer_id uuid,p_treatment_id uuid,p_template_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 return private.render_treatment_document(p_organization_id,p_customer_id,p_treatment_id,p_template_id);
end;
$$;
revoke all on function private.preview_treatment_document(uuid,uuid,uuid,uuid) from public,anon;
grant execute on function private.preview_treatment_document(uuid,uuid,uuid,uuid) to authenticated;
create function public.preview_treatment_document(
 p_organization_id uuid,p_customer_id uuid,p_treatment_id uuid,p_template_id uuid
) returns jsonb language sql security invoker set search_path='' as $$
 select private.preview_treatment_document(p_organization_id,p_customer_id,p_treatment_id,p_template_id);
$$;
revoke all on function public.preview_treatment_document(uuid,uuid,uuid,uuid) from public,anon;
grant execute on function public.preview_treatment_document(uuid,uuid,uuid,uuid) to authenticated;

create function private.issue_treatment_document(
 p_organization_id uuid,p_customer_id uuid,p_treatment_id uuid,p_template_id uuid,p_operation_id uuid,p_expected_preview jsonb
) returns setof public.issued_treatment_documents language plpgsql security definer set search_path='' as $$
declare
 receipt public.issued_treatment_documents%rowtype;
 fingerprint jsonb;
 preview jsonb;
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then
  raise exception 'Document issuance requires organization manager' using errcode='42501';
 end if;
 if p_customer_id is null or p_treatment_id is null or p_template_id is null or p_operation_id is null
  or p_expected_preview is null or jsonb_typeof(p_expected_preview)<>'object' then
  raise exception 'Invalid issuance request' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('document-issue:'||p_organization_id::text||p_operation_id::text,0));
 fingerprint=jsonb_build_object('customer_id',p_customer_id,'treatment_id',p_treatment_id,'template_id',p_template_id,
  'actor_id',auth.uid(),'expected_preview',p_expected_preview);
 select * into receipt from public.issued_treatment_documents where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if receipt.request_fingerprint<>fingerprint then raise exception 'Operation ID already used for different request' using errcode='P0001'; end if;
  return next receipt; return;
 end if;
 preview=private.render_treatment_document(p_organization_id,p_customer_id,p_treatment_id,p_template_id);
 if preview<>p_expected_preview then raise exception 'Preview changed; review again' using errcode='P0001'; end if;
 if preview->'missing_fields'<>'[]'::jsonb then raise exception 'Missing document fields' using errcode='22023'; end if;
 insert into public.issued_treatment_documents(organization_id,customer_id,treatment_id,template_id,template_version,title,content,source_snapshot,issued_by,operation_id,request_fingerprint)
 values(p_organization_id,p_customer_id,p_treatment_id,p_template_id,(preview->>'template_version')::integer,
  preview->>'title',preview->>'content',preview->'source_snapshot',auth.uid(),p_operation_id,fingerprint) returning * into receipt;
 return next receipt;
end;
$$;
revoke all on function private.issue_treatment_document(uuid,uuid,uuid,uuid,uuid,jsonb) from public,anon;
grant execute on function private.issue_treatment_document(uuid,uuid,uuid,uuid,uuid,jsonb) to authenticated;
create function public.issue_treatment_document(
 p_organization_id uuid,p_customer_id uuid,p_treatment_id uuid,p_template_id uuid,p_operation_id uuid,p_expected_preview jsonb
) returns setof public.issued_treatment_documents language sql security invoker set search_path='' as $$
 select * from private.issue_treatment_document(p_organization_id,p_customer_id,p_treatment_id,p_template_id,p_operation_id,p_expected_preview);
$$;
revoke all on function public.issue_treatment_document(uuid,uuid,uuid,uuid,uuid,jsonb) from public,anon;
grant execute on function public.issue_treatment_document(uuid,uuid,uuid,uuid,uuid,jsonb) to authenticated;
commit;
