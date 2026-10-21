-- LAB-10: append-only manager-confirmed snapshots for complete recorded-cost periods.
begin;

create table if not exists public.management_profit_finalizations (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 from_date date not null,
 to_date date not null,
 revision integer not null check(revision>0),
 operation_id uuid not null,
 request_fingerprint text not null check(request_fingerprint ~ '^[0-9a-f]{32}$'),
 result jsonb not null check(jsonb_typeof(result)='object' and result->>'is_final_profit'='true'),
 reason text not null default '' check(length(reason)<=500),
 confirmed_by uuid not null,
 confirmed_at timestamptz not null default now(),
 check(to_date>=from_date and to_date<current_date and to_date<=from_date+366),
 unique(organization_id,operation_id),
 unique(organization_id,from_date,to_date,revision)
);
create index if not exists management_profit_finalizations_period
 on public.management_profit_finalizations(organization_id,from_date,to_date,revision desc);
alter table public.management_profit_finalizations enable row level security;
revoke all on public.management_profit_finalizations from public,anon,authenticated;

create or replace function private.prevent_management_profit_finalization_change()
returns trigger language plpgsql set search_path='' as $$
begin raise exception 'Management profit finalizations are immutable' using errcode='P0001'; end $$;
revoke all on function private.prevent_management_profit_finalization_change() from public,anon,authenticated;
drop trigger if exists management_profit_finalizations_immutable on public.management_profit_finalizations;
create trigger management_profit_finalizations_immutable before update or delete on public.management_profit_finalizations
 for each row execute function private.prevent_management_profit_finalization_change();
drop trigger if exists management_profit_finalizations_no_truncate on public.management_profit_finalizations;
create trigger management_profit_finalizations_no_truncate before truncate on public.management_profit_finalizations
 for each statement execute function private.prevent_management_profit_finalization_change();

create or replace function public.finalize_management_profit(
 p_organization_id uuid,p_from_date date,p_to_date date,p_operation_id uuid,p_confirmed_complete boolean,p_reason text default ''
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 actor uuid:=auth.uid();
 fingerprint text;
 prior public.management_profit_finalizations%rowtype;
 preview jsonb;
 final_result jsonb;
 snapshot_id uuid;
 next_revision integer;
 snapshot jsonb;
begin
 if actor is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then
  raise exception 'Management report permission required' using errcode='42501';
 end if;
 if p_organization_id is null or p_from_date is null or p_to_date is null or p_to_date<p_from_date or p_to_date>=current_date or p_to_date>p_from_date+366
  or p_operation_id is null or p_confirmed_complete is distinct from true or p_reason is null or length(p_reason)>500 then
  raise exception 'Invalid management profit finalization' using errcode='22023';
 end if;
 fingerprint=md5(jsonb_build_object('organization_id',p_organization_id,'from_date',p_from_date,'to_date',p_to_date,'confirmed_complete',p_confirmed_complete,'reason',p_reason)::text);
 perform pg_advisory_xact_lock(hashtextextended('management-profit-operation:'||p_organization_id::text||':'||p_operation_id::text,0));
 select * into prior from public.management_profit_finalizations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.request_fingerprint<>fingerprint then raise exception 'Operation ID reused with different finalization input' using errcode='P0001'; end if;
  return jsonb_build_object('id',prior.id,'organization_id',prior.organization_id,'from_date',prior.from_date,'to_date',prior.to_date,'revision',prior.revision,'result',prior.result,'reason',prior.reason,'confirmed_by',prior.confirmed_by,'confirmed_at',prior.confirmed_at);
 end if;
 perform pg_advisory_xact_lock(hashtextextended('management-profit-period:'||p_organization_id::text||':'||p_from_date::text||':'||p_to_date::text,0));
 select coalesce(max(revision),0)+1 into next_revision from public.management_profit_finalizations
  where organization_id=p_organization_id and from_date=p_from_date and to_date=p_to_date;
 if next_revision>1 and btrim(p_reason)='' then raise exception 'Reason required for a revised finalization' using errcode='22023'; end if;
 preview=public.get_management_preview(p_organization_id,p_from_date,p_to_date);
 if preview->>'organization_id'<>p_organization_id::text or preview->>'from_date'<>p_from_date::text or preview->>'to_date'<>p_to_date::text
  or coalesce((preview->>'inventory_cost_unknown_units')::integer,1)<>0 or preview->>'inventory_cogs' is null
  or coalesce((preview->>'commission_settlement_complete')::boolean,false) is not true
  or preview->>'operating_profit_after_recorded_tax' is null then
  raise exception 'Inventory cost or commission settlement is incomplete' using errcode='22023';
 end if;
 final_result=preview||jsonb_build_object('is_final_profit',true,'excluded_costs','[]'::jsonb,'staff_basis_is_commission',true,'finalization_scope','manager_confirmed_recorded_ledger');
 insert into public.management_profit_finalizations(organization_id,from_date,to_date,revision,operation_id,request_fingerprint,result,reason,confirmed_by)
 values(p_organization_id,p_from_date,p_to_date,next_revision,p_operation_id,fingerprint,final_result,btrim(p_reason),actor)
 returning id into snapshot_id;
 insert into public.audit_events(organization_id,actor_id,action,target_type,target_id,metadata,source)
 values(p_organization_id,actor,'management.profit_finalize','management_profit',snapshot_id::text,
  jsonb_build_object('from_date',p_from_date,'to_date',p_to_date,'revision',next_revision,'operation_id',p_operation_id),'api_user');
 select jsonb_build_object('id',id,'organization_id',organization_id,'from_date',from_date,'to_date',to_date,'revision',revision,
  'result',result,'reason',reason,'confirmed_by',confirmed_by,'confirmed_at',confirmed_at)
 into snapshot from public.management_profit_finalizations where id=snapshot_id;
 return snapshot;
end $$;

create or replace function public.list_management_profit_finalizations(p_organization_id uuid,p_from_date date,p_to_date date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then
  raise exception 'Management report permission required' using errcode='42501';
 end if;
 if p_from_date is null or p_to_date is null or p_to_date<p_from_date or p_to_date>=current_date or p_to_date>p_from_date+366 then
  raise exception 'Invalid management profit period' using errcode='22023';
 end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',id,'organization_id',organization_id,'from_date',from_date,'to_date',to_date,'revision',revision,
  'result',result,'reason',reason,'confirmed_by',confirmed_by,'confirmed_at',confirmed_at) order by revision desc)
  from public.management_profit_finalizations where organization_id=p_organization_id and from_date=p_from_date and to_date=p_to_date),'[]'::jsonb);
end $$;
revoke all on function public.finalize_management_profit(uuid,date,date,uuid,boolean,text),public.list_management_profit_finalizations(uuid,date,date) from public,anon,authenticated;
grant execute on function public.finalize_management_profit(uuid,date,date,uuid,boolean,text),public.list_management_profit_finalizations(uuid,date,date) to authenticated;
commit;
