begin;
create table public.tasks (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 created_by uuid not null references auth.users(id) on delete restrict, title text not null check (length(btrim(title)) > 0), description text not null default '', due_at timestamptz,
 status text not null default 'open' check (status in ('open','in_progress','done','canceled')),
 priority text not null default 'normal' check (priority in ('low','normal','high')), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index idx_tasks_organization_id on public.tasks (organization_id);
create index idx_tasks_created_by on public.tasks (created_by);
create index idx_tasks_organization_status on public.tasks (organization_id, status);
alter table public.tasks enable row level security;
create policy "tasks_select_member" on public.tasks for select to authenticated using ((select private.has_organization_role(organization_id, array['owner','admin','member']::text[])));
create policy "tasks_insert_creator_or_manager" on public.tasks for insert to authenticated with check (created_by = (select auth.uid()) and (select private.has_organization_role(organization_id, array['owner','admin','member']::text[])));
create policy "tasks_update_creator_or_manager" on public.tasks for update to authenticated using (created_by = (select auth.uid()) or (select private.has_organization_role(organization_id, array['owner','admin']::text[]))) with check (created_by = (select auth.uid()) or (select private.has_organization_role(organization_id, array['owner','admin']::text[])));
create policy "tasks_delete_creator_or_manager" on public.tasks for delete to authenticated using (created_by = (select auth.uid()) or (select private.has_organization_role(organization_id, array['owner','admin']::text[])));
commit;
