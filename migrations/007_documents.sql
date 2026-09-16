begin;

create table public.document_templates (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 name text not null check (length(btrim(name)) > 0),
 description text not null default '',
 content text not null default '',
 is_archived boolean not null default false,
 created_by uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

create table public.documents (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 template_id uuid references public.document_templates(id) on delete set null,
 title text not null check (length(btrim(title)) > 0),
 content text not null default '',
 status text not null default 'draft' check (status in ('draft', 'final', 'archived')),
 created_by uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

create index idx_document_templates_organization_updated
 on public.document_templates (organization_id, updated_at desc);
create index idx_documents_organization_updated
 on public.documents (organization_id, updated_at desc);
create index idx_documents_template_id on public.documents (template_id);

alter table public.document_templates enable row level security;
alter table public.documents enable row level security;

create function private.prevent_document_templates_tenant_change()
returns trigger language plpgsql set search_path = '' as $$
begin
 if new.organization_id is distinct from old.organization_id or new.created_by is distinct from old.created_by then
  raise exception 'document template organization and creator are immutable';
 end if;
 new.updated_at = timezone('utc', now());
 return new;
end;
$$;
revoke all on function private.prevent_document_templates_tenant_change() from public;
create trigger document_templates_prevent_tenant_change before update on public.document_templates
 for each row execute function private.prevent_document_templates_tenant_change();

create function private.prevent_documents_tenant_change()
returns trigger language plpgsql set search_path = '' as $$
begin
 if new.organization_id is distinct from old.organization_id or new.created_by is distinct from old.created_by then
  raise exception 'document organization and creator are immutable';
 end if;
 new.updated_at = timezone('utc', now());
 return new;
end;
$$;
revoke all on function private.prevent_documents_tenant_change() from public;
create trigger documents_prevent_tenant_change before update on public.documents
 for each row execute function private.prevent_documents_tenant_change();

create function private.document_template_same_organization()
returns trigger language plpgsql set search_path = '' as $$
begin
 if new.template_id is not null and not exists (
  select 1 from public.document_templates template
  where template.id = new.template_id and template.organization_id = new.organization_id
 ) then
  raise exception 'document template must belong to the document organization';
 end if;
 return new;
end;
$$;
revoke all on function private.document_template_same_organization() from public;
create trigger documents_template_same_organization before insert or update on public.documents
 for each row execute function private.document_template_same_organization();

create policy "document_templates_select_member" on public.document_templates
 for select to authenticated
 using ((select private.has_organization_role(organization_id, array['owner', 'admin', 'member']::text[])));
create policy "document_templates_insert_manager" on public.document_templates
 for insert to authenticated
 with check (
  created_by = (select auth.uid())
  and (select private.has_organization_role(organization_id, array['owner', 'admin']::text[]))
 );
create policy "document_templates_update_manager" on public.document_templates
 for update to authenticated
 using ((select private.has_organization_role(organization_id, array['owner', 'admin']::text[])))
 with check ((select private.has_organization_role(organization_id, array['owner', 'admin']::text[])));

create policy "documents_select_member" on public.documents
 for select to authenticated
 using ((select private.has_organization_role(organization_id, array['owner', 'admin', 'member']::text[])));
create policy "documents_insert_manager" on public.documents
 for insert to authenticated
 with check (
  created_by = (select auth.uid())
  and (select private.has_organization_role(organization_id, array['owner', 'admin']::text[]))
 );
create policy "documents_update_manager" on public.documents
 for update to authenticated
 using ((select private.has_organization_role(organization_id, array['owner', 'admin']::text[])))
 with check ((select private.has_organization_role(organization_id, array['owner', 'admin']::text[])));

commit;
