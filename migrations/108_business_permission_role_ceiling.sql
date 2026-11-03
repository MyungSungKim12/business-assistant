-- 108: custom permissions cannot grant member writes that the existing domain RLS/RPCs still deny.
-- Read/export choices remain adjustable; owner is always immutable. owner/admin defaults remain unchanged.
begin;

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
  if target_role='member' and key in ('customer.manage','appointment.manage','treatment.manage','payment.collect','refund.approve') and value='true'::jsonb then
   raise exception 'role_permission_limit' using errcode='42501';
  end if;
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

revoke all on function public.set_organization_member_permissions(uuid,uuid,jsonb) from public,anon;
grant execute on function public.set_organization_member_permissions(uuid,uuid,jsonb) to authenticated;

commit;
