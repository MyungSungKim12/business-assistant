-- APT-20: branches belong to an organization. Existing organizations receive a primary "본점".
begin;

create table if not exists public.organization_branches (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 code text not null check(code ~ '^[A-Z0-9][A-Z0-9-]{1,19}$'),
 name text not null check(length(btrim(name)) between 1 and 100),
 timezone_name text not null default 'Asia/Seoul' check(length(btrim(timezone_name)) between 1 and 100),
 is_primary boolean not null default false,
 is_active boolean not null default true,
 version bigint not null default 1 check(version>0),
 created_by uuid references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(organization_id,id),
 unique(organization_id,code)
);
create unique index if not exists organization_branches_one_primary
 on public.organization_branches(organization_id) where is_primary;
create index if not exists organization_branches_active
 on public.organization_branches(organization_id,name,id) where is_active;
alter table public.organization_branches enable row level security;
drop policy if exists organization_branch_member_select on public.organization_branches;
create policy organization_branch_member_select on public.organization_branches for select to authenticated
 using((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
revoke all on public.organization_branches from public,anon,authenticated;
grant select on public.organization_branches to authenticated;

insert into public.organization_branches(organization_id,code,name,is_primary,created_by)
select o.id,'MAIN','본점',true,null
from public.organizations o
where not exists(select 1 from public.organization_branches b where b.organization_id=o.id and b.is_primary)
on conflict(organization_id,code) do nothing;

create or replace function public.list_organization_branches(p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin','member']::text[]) then
  raise exception 'Organization access required' using errcode='42501';
 end if;
 return coalesce((select jsonb_agg(to_jsonb(b) order by b.is_primary desc,b.name,b.id)
  from public.organization_branches b where b.organization_id=p_organization_id and b.is_active),'[]'::jsonb);
end $$;
revoke all on function public.list_organization_branches(uuid) from public,anon;
grant execute on function public.list_organization_branches(uuid) to authenticated;

create or replace function public.create_organization_branch(
 p_organization_id uuid,p_code text,p_name text,p_timezone_name text,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare saved public.organization_branches%rowtype; prior public.appointment_operations%rowtype; fp text;
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then
  raise exception 'Branch manager access required' using errcode='42501'; end if;
 if p_operation_id is null or p_code is null or upper(btrim(p_code)) !~ '^[A-Z0-9][A-Z0-9-]{1,19}$'
  or p_name is null or length(btrim(p_name)) not between 1 and 100 or p_timezone_name is null
  or length(btrim(p_timezone_name)) not between 1 and 100 then raise exception 'Invalid branch' using errcode='22023'; end if;
 begin perform timezone(btrim(p_timezone_name),now()); exception when invalid_parameter_value then raise exception 'Invalid timezone' using errcode='22023'; end;
 fp=md5(jsonb_build_object('branch',upper(btrim(p_code)),'name',btrim(p_name),'timezone',btrim(p_timezone_name))::text);
 perform pg_advisory_xact_lock(hashtextextended('branch-create:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.appointment_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then if prior.actor_id<>auth.uid() or prior.fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if; return prior.result_snapshot; end if;
 insert into public.organization_branches(organization_id,code,name,timezone_name,created_by)
 values(p_organization_id,upper(btrim(p_code)),btrim(p_name),btrim(p_timezone_name),auth.uid()) returning * into saved;
 insert into public.appointment_operations(organization_id,operation_id,actor_id,fingerprint,result_snapshot)
 values(p_organization_id,p_operation_id,auth.uid(),fp,to_jsonb(saved));
 return to_jsonb(saved);
end $$;
revoke all on function public.create_organization_branch(uuid,text,text,text,uuid) from public,anon;
grant execute on function public.create_organization_branch(uuid,text,text,text,uuid) to authenticated;
commit;
