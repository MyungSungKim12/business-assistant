begin;

alter table public.document_templates
 add column status text not null default 'draft' check (status in ('draft','published','retired')),
 add column version integer not null default 1 check (version > 0),
 add column revision integer not null default 1 check (revision > 0);
update public.document_templates set status='retired' where is_archived;

create table public.document_template_versions (
 template_id uuid not null references public.document_templates(id) on delete restrict,
 organization_id uuid not null references public.organizations(id) on delete restrict,
 version integer not null check (version > 0),
 name text not null, description text not null, content text not null,
 published_by uuid not null references auth.users(id) on delete restrict,
 published_at timestamptz not null default clock_timestamp(),
 primary key (template_id,version)
);
create index document_template_versions_org on public.document_template_versions(organization_id,template_id,version desc);
alter table public.document_template_versions enable row level security;
create policy template_versions_member on public.document_template_versions for select to authenticated
 using ((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));

create table private.document_template_operations (
 organization_id uuid not null references public.organizations(id) on delete restrict,
 operation_id uuid not null,
 template_id uuid not null references public.document_templates(id) on delete restrict,
 actor_id uuid not null references auth.users(id) on delete restrict,
 fingerprint jsonb not null,
 occurred_at timestamptz not null default clock_timestamp(),
 primary key (organization_id,operation_id)
);
create index document_template_operations_template on private.document_template_operations(template_id);
alter table private.document_template_operations enable row level security;
revoke all on private.document_template_operations from public,anon,authenticated;
revoke all on public.document_template_versions from public,anon,authenticated;
grant select on public.document_template_versions to authenticated;
revoke all on public.document_templates from public,anon,authenticated;
grant select on public.document_templates to authenticated;

-- One transaction controls current draft, immutable publication and retry receipt.
create function private.mutate_document_template(
 p_organization_id uuid, p_template_id uuid, p_expected_revision integer,
 p_operation_id uuid, p_action text, p_values jsonb
) returns setof public.document_templates
language plpgsql security definer set search_path='' as $$
declare
 current_row public.document_templates%rowtype;
 receipt private.document_template_operations%rowtype;
 fingerprint jsonb;
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then
  raise exception 'Template management permission required' using errcode='42501';
 end if;
 if p_template_id is null or p_operation_id is null or p_expected_revision is null
    or p_action is null or p_action not in ('create','save','publish','revise','retire')
    or p_values is null or jsonb_typeof(p_values)<>'object' then
  raise exception 'Invalid template operation' using errcode='22023';
 end if;
 -- Serializes retries, including a new template which does not yet have a row.
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text || p_operation_id::text,0));
 fingerprint=jsonb_build_object('template_id',p_template_id,'revision',p_expected_revision,
   'action',p_action,'values',p_values,'actor',auth.uid());
 select * into receipt from private.document_template_operations
  where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if receipt.fingerprint<>fingerprint then
   raise exception 'Operation ID already used for a different request' using errcode='P0001';
  end if;
  return query select * from public.document_templates where id=p_template_id and organization_id=p_organization_id;
  return;
 end if;
 if p_action in ('create','save') then
  if not (p_values ?& array['name','description','content']) or
    (p_values - array['name','description','content'])<>'{}'::jsonb or
    jsonb_typeof(p_values->'name')<>'string' or jsonb_typeof(p_values->'description')<>'string' or
    jsonb_typeof(p_values->'content')<>'string' or
    (p_values->>'name') !~ '\S' or length(btrim(p_values->>'name')) not between 1 and 200 or
    length(p_values->>'description')>100000 or length(p_values->>'content')>100000 then
   raise exception 'Invalid template fields' using errcode='22023';
  end if;
 elsif p_values<>'{}'::jsonb then
  raise exception 'Transition must not include fields' using errcode='22023';
 end if;
 if p_action='create' then
  if p_expected_revision<>0 then raise exception 'New template revision must be zero' using errcode='22023'; end if;
  insert into public.document_templates(id,organization_id,created_by,name,description,content)
   values(p_template_id,p_organization_id,auth.uid(),btrim(p_values->>'name'),p_values->>'description',p_values->>'content')
   on conflict(id) do nothing returning * into current_row;
  if not found then raise exception 'Template ID already exists' using errcode='P0001'; end if;
 else
  select * into current_row from public.document_templates
   where id=p_template_id and organization_id=p_organization_id for update;
  if not found then raise exception 'Template not found' using errcode='P0002'; end if;
  if current_row.revision<>p_expected_revision then
   raise exception 'Template changed; reload before retrying' using errcode='P0001';
  end if;
  if current_row.status='retired' or
     (p_action in ('save','publish') and current_row.status<>'draft') or
     (p_action='revise' and current_row.status<>'published') then
   raise exception 'Invalid template state transition' using errcode='P0001';
  end if;
  if p_action='publish' then
   if current_row.content !~ '\S' then raise exception 'Publication requires content' using errcode='22023'; end if;
   insert into public.document_template_versions(template_id,organization_id,version,name,description,content,published_by)
    values(current_row.id,p_organization_id,current_row.version,current_row.name,current_row.description,current_row.content,auth.uid());
  end if;
  update public.document_templates set
   name=case when p_action='save' then btrim(p_values->>'name') else name end,
   description=case when p_action='save' then p_values->>'description' else description end,
   content=case when p_action='save' then p_values->>'content' else content end,
   status=case p_action when 'publish' then 'published' when 'revise' then 'draft' when 'retire' then 'retired' else status end,
   is_archived=(p_action='retire'),
   version=version+case when p_action='revise' then 1 else 0 end,
   revision=revision+1
   where id=p_template_id and organization_id=p_organization_id returning * into current_row;
 end if;
 insert into private.document_template_operations(organization_id,operation_id,template_id,actor_id,fingerprint)
  values(p_organization_id,p_operation_id,p_template_id,auth.uid(),fingerprint);
 return next current_row;
end;
$$;
revoke all on function private.mutate_document_template(uuid,uuid,integer,uuid,text,jsonb) from public,anon;
grant execute on function private.mutate_document_template(uuid,uuid,integer,uuid,text,jsonb) to authenticated;
create function public.mutate_document_template(
 p_organization_id uuid,p_template_id uuid,p_expected_revision integer,p_operation_id uuid,p_action text,p_values jsonb
) returns setof public.document_templates language sql security invoker set search_path='' as $$
 select * from private.mutate_document_template(p_organization_id,p_template_id,p_expected_revision,p_operation_id,p_action,p_values);
$$;
revoke all on function public.mutate_document_template(uuid,uuid,integer,uuid,text,jsonb) from public,anon;
grant execute on function public.mutate_document_template(uuid,uuid,integer,uuid,text,jsonb) to authenticated;
commit;
