-- 107: SET-002 업무별 조직 구성원 권한.
-- 역할 기본값을 유지하고 명시 override만 저장한다. 소유자 권한은 항상 전체 허용이며 수정할 수 없다.
begin;

create table if not exists public.organization_member_permissions (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 user_id uuid not null,
 permission_code text not null check (permission_code in (
  'customer.read','customer.manage','appointment.read','appointment.manage',
  'treatment.read','treatment.manage','payment.read','payment.collect','refund.approve','data.export'
 )),
 allowed boolean not null,
 updated_at timestamptz not null default now(),
 updated_by uuid not null,
 primary key (organization_id,user_id,permission_code),
 foreign key (organization_id,user_id) references public.memberships(organization_id,user_id) on delete cascade
);
alter table public.organization_member_permissions enable row level security;
revoke all on public.organization_member_permissions from public,anon,authenticated,service_role;

create or replace function private.organization_member_permission_defaults(p_role text)
returns jsonb language sql immutable set search_path=''
as $$
 select case p_role
  when 'owner' then '{"customer.read":true,"customer.manage":true,"appointment.read":true,"appointment.manage":true,"treatment.read":true,"treatment.manage":true,"payment.read":true,"payment.collect":true,"refund.approve":true,"data.export":true}'::jsonb
  when 'admin' then '{"customer.read":true,"customer.manage":true,"appointment.read":true,"appointment.manage":true,"treatment.read":true,"treatment.manage":true,"payment.read":true,"payment.collect":true,"refund.approve":true,"data.export":true}'::jsonb
  else '{"customer.read":true,"customer.manage":false,"appointment.read":true,"appointment.manage":false,"treatment.read":true,"treatment.manage":false,"payment.read":true,"payment.collect":false,"refund.approve":false,"data.export":false}'::jsonb
 end;
$$;

create or replace function public.get_organization_business_permissions(p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare caller uuid := (select auth.uid()); role_name text; result jsonb;
begin
 if caller is null or p_organization_id is null then raise exception 'forbidden' using errcode='42501'; end if;
 select m.role into role_name from public.memberships m where m.organization_id=p_organization_id and m.user_id=caller;
 if role_name is null then raise exception 'forbidden' using errcode='42501'; end if;
 result := private.organization_member_permission_defaults(role_name);
 if role_name <> 'owner' then
  select coalesce(jsonb_object_agg(p.permission_code,p.allowed),'{}'::jsonb) into result
  from public.organization_member_permissions p where p.organization_id=p_organization_id and p.user_id=caller;
  result := private.organization_member_permission_defaults(role_name) || coalesce(result,'{}'::jsonb);
 end if;
 return result;
end;
$$;

create or replace function public.has_organization_business_permission(p_organization_id uuid,p_permission_code text)
returns boolean language plpgsql stable security definer set search_path=''
as $$
declare permissions jsonb;
begin
 if p_permission_code is null or p_permission_code not in (
  'customer.read','customer.manage','appointment.read','appointment.manage',
  'treatment.read','treatment.manage','payment.read','payment.collect','refund.approve','data.export'
 ) then return false; end if;
 permissions := public.get_organization_business_permissions(p_organization_id);
 return coalesce((permissions->>p_permission_code)::boolean,false);
end;
$$;

create or replace function public.set_organization_member_permissions(p_organization_id uuid,p_user_id uuid,p_permissions jsonb)
returns jsonb language plpgsql volatile security definer set search_path=''
as $$
declare caller uuid := (select auth.uid()); target_role text; key text; value jsonb; changed text[] := array[]::text[];
begin
 if caller is null or p_organization_id is null or p_user_id is null or jsonb_typeof(p_permissions)<>'object' then
  raise exception 'invalid_permissions' using errcode='22023';
 end if;
 if not private.has_organization_role(p_organization_id,array['owner']::text[]) then raise exception 'forbidden' using errcode='42501'; end if;
 select m.role into target_role from public.memberships m where m.organization_id=p_organization_id and m.user_id=p_user_id for update;
 if target_role is null then raise exception 'member_not_found' using errcode='P0002'; end if;
 if target_role='owner' then raise exception 'owner_permissions_locked' using errcode='42501'; end if;
 for key,value in select k,v from jsonb_each(p_permissions) e(k,v) loop
  if key not in ('customer.read','customer.manage','appointment.read','appointment.manage','treatment.read','treatment.manage','payment.read','payment.collect','refund.approve','data.export')
     or value not in ('true'::jsonb,'false'::jsonb) then raise exception 'invalid_permissions' using errcode='22023'; end if;
  insert into public.organization_member_permissions(organization_id,user_id,permission_code,allowed,updated_at,updated_by)
  values(p_organization_id,p_user_id,key,(value='true'::jsonb),now(),caller)
  on conflict(organization_id,user_id,permission_code) do update set allowed=excluded.allowed,updated_at=now(),updated_by=caller
  where organization_member_permissions.allowed is distinct from excluded.allowed;
  if found then changed := array_append(changed,key); end if;
 end loop;
 if cardinality(changed)>0 then
  insert into public.audit_events(organization_id,actor_id,action,target_type,target_id,metadata,source)
  values(p_organization_id,caller,'member.permissions_change','membership',p_user_id::text,
   jsonb_build_object('permission_codes',to_jsonb(changed),'role',target_role),'api_user');
 end if;
 return jsonb_build_object('user_id',p_user_id,'permissions',public.get_organization_business_permissions_for_user(p_organization_id,p_user_id));
end;
$$;

create or replace function private.organization_member_permissions_for(p_organization_id uuid,p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare role_name text; result jsonb;
begin
 select m.role into role_name from public.memberships m where m.organization_id=p_organization_id and m.user_id=p_user_id;
 if role_name is null then return null; end if;
 result:=private.organization_member_permission_defaults(role_name);
 if role_name<>'owner' then
  select result || coalesce(jsonb_object_agg(p.permission_code,p.allowed),'{}'::jsonb) into result
  from public.organization_member_permissions p where p.organization_id=p_organization_id and p.user_id=p_user_id;
 end if;
 return result;
end;
$$;

create or replace function public.get_organization_business_permissions_for_user(p_organization_id uuid,p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then raise exception 'forbidden' using errcode='42501'; end if;
 return private.organization_member_permissions_for(p_organization_id,p_user_id);
end;
$$;

revoke all on function private.organization_member_permission_defaults(text) from public,anon,authenticated;
revoke all on function private.organization_member_permissions_for(uuid,uuid) from public,anon,authenticated;
revoke all on function public.get_organization_business_permissions(uuid) from public,anon;
revoke all on function public.get_organization_business_permissions_for_user(uuid,uuid) from public,anon;
revoke all on function public.has_organization_business_permission(uuid,text) from public,anon;
revoke all on function public.set_organization_member_permissions(uuid,uuid,jsonb) from public,anon;
grant execute on function public.get_organization_business_permissions(uuid) to authenticated;
grant execute on function public.get_organization_business_permissions_for_user(uuid,uuid) to authenticated;
grant execute on function public.has_organization_business_permission(uuid,text) to authenticated;
grant execute on function public.set_organization_member_permissions(uuid,uuid,jsonb) to authenticated;

commit;
