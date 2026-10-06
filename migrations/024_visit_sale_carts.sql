-- SALE-001: customer visits and review-only sale carts. No payment or ledger side effects.

create table public.customer_visits (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 customer_id uuid not null references public.customers(id),
 appointment_id uuid,
 status text not null default 'open' check(status in ('open','checkout_ready','closed','canceled')),
 opened_at timestamptz not null default now(),
 closed_at timestamptz,
 version bigint not null default 1 check(version > 0),
 created_by uuid not null references auth.users(id),
 updated_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(organization_id,id),
 unique(organization_id,id,customer_id),
 check((status in ('closed','canceled')) = (closed_at is not null))
);
create index customer_visits_org_customer_status
 on public.customer_visits(organization_id,customer_id,status,opened_at desc);

create table public.sale_carts (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 visit_id uuid not null unique,
 customer_id uuid not null references public.customers(id),
 status text not null default 'draft' check(status in ('draft','ready','void')),
 version bigint not null default 1 check(version > 0),
 subtotal numeric(14,2) not null default 0 check(subtotal >= 0),
 discount_total numeric(14,2) not null default 0 check(discount_total >= 0),
 total_amount numeric(14,2) not null default 0 check(total_amount >= 0),
 created_by uuid not null references auth.users(id),
 updated_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(organization_id,id),
 unique(organization_id,visit_id),
 foreign key(organization_id,visit_id,customer_id)
  references public.customer_visits(organization_id,id,customer_id),
 check(discount_total <= subtotal),
 check(total_amount = subtotal - discount_total)
);

create table public.sale_cart_lines (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 cart_id uuid not null references public.sale_carts(id),
 source_type text not null check(source_type in ('treatment_draft','product','membership')),
 source_id uuid not null,
 description_snapshot text not null check(length(btrim(description_snapshot)) between 1 and 200),
 quantity integer not null default 1 check(quantity between 1 and 999),
 unit_price numeric(14,2) not null check(unit_price >= 0),
 line_total numeric(14,2) not null check(line_total = quantity * unit_price),
 staff_id uuid,
 staff_name_snapshot text not null default '' check(length(staff_name_snapshot) <= 200),
 source_snapshot jsonb not null check(jsonb_typeof(source_snapshot)='object'),
 status text not null default 'active' check(status in ('active','removed')),
 removal_reason text not null default '' check(length(removal_reason) <= 1000),
 created_by uuid not null references auth.users(id),
 removed_by uuid references auth.users(id),
 created_at timestamptz not null default now(),
 removed_at timestamptz,
 unique(organization_id,id),
 foreign key(organization_id,cart_id) references public.sale_carts(organization_id,id),
 check((status='removed') = (removed_at is not null)),
 check((status='removed') = (removed_by is not null))
);
create unique index sale_cart_lines_active_source
 on public.sale_cart_lines(organization_id,source_type,source_id) where status='active';
create index sale_cart_lines_cart_status
 on public.sale_cart_lines(organization_id,cart_id,status,created_at,id);

create table public.sale_cart_operations (
 organization_id uuid not null references public.organizations(id),
 operation_id uuid not null,
 actor_id uuid not null references auth.users(id),
 action text not null,
 request_fingerprint text not null,
 result_snapshot jsonb not null check(jsonb_typeof(result_snapshot)='object'),
 created_at timestamptz not null default now(),
 primary key(organization_id,operation_id)
);

alter table public.customer_visits enable row level security;
alter table public.sale_carts enable row level security;
alter table public.sale_cart_lines enable row level security;
alter table public.sale_cart_operations enable row level security;

create policy customer_visits_member_select on public.customer_visits for select to authenticated
 using((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
create policy sale_carts_member_select on public.sale_carts for select to authenticated
 using((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
create policy sale_cart_lines_member_select on public.sale_cart_lines for select to authenticated
 using((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
create policy sale_cart_operations_actor_select on public.sale_cart_operations for select to authenticated
 using(actor_id=(select auth.uid()) and
  (select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));

revoke all on public.customer_visits,public.sale_carts,public.sale_cart_lines,public.sale_cart_operations
 from public,anon,authenticated;
grant select on public.customer_visits to authenticated;
grant select on public.sale_carts to authenticated;
grant select on public.sale_cart_lines to authenticated;
grant select on public.sale_cart_operations to authenticated;

create function private.sale_cart_payload(p_cart_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'visit',to_jsonb(v),
  'cart',to_jsonb(c),
  'lines',coalesce((select jsonb_agg(to_jsonb(l) order by l.created_at,l.id)
   from public.sale_cart_lines l where l.cart_id=c.id),'[]'::jsonb)
 )
 from public.sale_carts c join public.customer_visits v on v.id=c.visit_id
 where c.id=p_cart_id
$$;
revoke all on function private.sale_cart_payload(uuid) from public,anon,authenticated;

create function public.get_visit_sale_cart(p_organization_id uuid,p_visit_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null or p_organization_id is null or not private.has_organization_role(
  p_organization_id,array['owner','admin','member']::text[]
 ) then raise exception 'Sale cart read permission required' using errcode='42501'; end if;
 select private.sale_cart_payload(c.id) into result
 from public.sale_carts c where c.organization_id=p_organization_id and c.visit_id=p_visit_id;
 if result is null then raise exception 'Visit cart not found' using errcode='P0002'; end if;
 return result;
end $$;
revoke all on function public.get_visit_sale_cart(uuid,uuid) from public,anon;
grant execute on function public.get_visit_sale_cart(uuid,uuid) to authenticated;

create function private.assert_sale_cart_manager(p_organization_id uuid) returns void
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.has_organization_role(
  p_organization_id,array['owner', 'admin']::text[]
 ) then raise exception 'Sale cart management permission required' using errcode='42501'; end if;
end $$;
revoke all on function private.assert_sale_cart_manager(uuid) from public,anon,authenticated;

create function private.sale_cart_recalculate(p_cart_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare total numeric;
begin
 select coalesce(sum(line_total),0) into total
 from public.sale_cart_lines where cart_id=p_cart_id and status='active';
 if total>=1000000000000 then raise exception 'Cart total exceeds supported amount' using errcode='22023'; end if;
 update public.sale_carts set subtotal=total,total_amount=total-discount_total,
  version=version+1,status='draft',updated_by=auth.uid(),updated_at=now()
 where id=p_cart_id;
 update public.customer_visits v set status='open',version=v.version+1,
  updated_by=auth.uid(),updated_at=now()
 from public.sale_carts c where c.id=p_cart_id and v.id=c.visit_id and v.status='checkout_ready';
end $$;
revoke all on function private.sale_cart_recalculate(uuid) from public,anon,authenticated;

create function public.create_customer_visit(
 p_organization_id uuid,p_customer_id uuid,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare fp text; prior public.sale_cart_operations%rowtype; visit_row public.customer_visits%rowtype;
 cart_row public.sale_carts%rowtype; result jsonb;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_customer_id is null or p_operation_id is null then raise exception 'Invalid visit request' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('customer_id',p_customer_id)::text);
 perform pg_advisory_xact_lock(hashtextextended('sale-cart:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.sale_cart_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.action<>'create_visit' or prior.request_fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if;
  return prior.result_snapshot;
 end if;
 if not exists(select 1 from public.customers where id=p_customer_id and organization_id=p_organization_id)
  then raise exception 'Customer not found' using errcode='P0002'; end if;
 insert into public.customer_visits(organization_id,customer_id,created_by,updated_by)
 values(p_organization_id,p_customer_id,auth.uid(),auth.uid()) returning * into visit_row;
 insert into public.sale_carts(organization_id,visit_id,customer_id,created_by,updated_by)
 values(p_organization_id,visit_row.id,p_customer_id,auth.uid(),auth.uid()) returning * into cart_row;
 result=private.sale_cart_payload(cart_row.id);
 insert into public.sale_cart_operations values(p_organization_id,p_operation_id,auth.uid(),'create_visit',fp,result,now());
 return result;
end $$;
revoke all on function public.create_customer_visit(uuid,uuid,uuid) from public,anon;
grant execute on function public.create_customer_visit(uuid,uuid,uuid) to authenticated;

create function public.add_treatment_draft_to_cart(
 p_organization_id uuid,p_visit_id uuid,p_draft_id uuid,p_expected_version bigint,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare fp text; prior public.sale_cart_operations%rowtype; cart_row public.sale_carts%rowtype;
 draft_row public.treatment_sale_drafts%rowtype; result jsonb;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_visit_id is null or p_draft_id is null or p_operation_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'Invalid cart request' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('visit_id',p_visit_id,'draft_id',p_draft_id,'version',p_expected_version)::text);
 perform pg_advisory_xact_lock(hashtextextended('sale-cart:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.sale_cart_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.action<>'add_treatment_draft' or prior.request_fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if;
  return prior.result_snapshot;
 end if;
 select * into cart_row from public.sale_carts where organization_id=p_organization_id and visit_id=p_visit_id for update;
 if not found then raise exception 'Visit cart not found' using errcode='P0002'; end if;
 if cart_row.status not in ('draft','ready') or cart_row.version<>p_expected_version then raise exception 'Cart changed' using errcode='P0001'; end if;
 select * into draft_row from public.treatment_sale_drafts
 where id=p_draft_id and organization_id=p_organization_id and customer_id=cart_row.customer_id;
 if not found then raise exception 'Treatment draft not found' using errcode='P0002'; end if;
 if draft_row.amount::text='NaN' or draft_row.amount<0 then raise exception 'Invalid draft amount' using errcode='22023'; end if;
 insert into public.sale_cart_lines(organization_id,cart_id,source_type,source_id,
  description_snapshot,quantity,unit_price,line_total,staff_name_snapshot,source_snapshot,created_by)
 values(p_organization_id,cart_row.id,'treatment_draft',draft_row.id,draft_row.description,1,
  draft_row.amount,draft_row.amount,coalesce(draft_row.source_snapshot#>>'{treatment,practitioner}',''),
  draft_row.source_snapshot||jsonb_build_object('sale_draft_id',draft_row.id),auth.uid());
 perform private.sale_cart_recalculate(cart_row.id);
 result=private.sale_cart_payload(cart_row.id);
 insert into public.sale_cart_operations values(p_organization_id,p_operation_id,auth.uid(),'add_treatment_draft',fp,result,now());
 return result;
exception when unique_violation then raise exception 'Treatment draft already in an active cart' using errcode='P0001';
end $$;
revoke all on function public.add_treatment_draft_to_cart(uuid,uuid,uuid,bigint,uuid) from public,anon;
grant execute on function public.add_treatment_draft_to_cart(uuid,uuid,uuid,bigint,uuid) to authenticated;

create function public.mutate_sale_cart_line(
 p_organization_id uuid,p_visit_id uuid,p_line_id uuid,p_expected_version bigint,
 p_operation_id uuid,p_action text,p_values jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare fp text; prior public.sale_cart_operations%rowtype; cart_row public.sale_carts%rowtype;
 line_row public.sale_cart_lines%rowtype; result jsonb; new_quantity integer; new_price numeric(14,2);
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_visit_id is null or p_line_id is null or p_expected_version is null or p_expected_version<1
  or p_operation_id is null or p_action is null or p_action not in ('update','remove','restore') or p_values is null or jsonb_typeof(p_values)<>'object'
  then raise exception 'Invalid line mutation' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('visit_id',p_visit_id,'line_id',p_line_id,'version',p_expected_version,'action',p_action,'values',p_values)::text);
 perform pg_advisory_xact_lock(hashtextextended('sale-cart:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.sale_cart_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.action<>'mutate_line' or prior.request_fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if;
  return prior.result_snapshot;
 end if;
 select * into cart_row from public.sale_carts where organization_id=p_organization_id and visit_id=p_visit_id for update;
 if not found then raise exception 'Visit cart not found' using errcode='P0002'; end if;
 if cart_row.status not in ('draft','ready') or cart_row.version<>p_expected_version then raise exception 'Cart changed' using errcode='P0001'; end if;
 select * into line_row from public.sale_cart_lines where id=p_line_id and organization_id=p_organization_id and cart_id=cart_row.id;
 if not found then raise exception 'Cart line not found' using errcode='P0002'; end if;
 if p_action='update' then
  if line_row.status<>'active' or p_values='{}'::jsonb or p_values - array['quantity','unit_price','staff_id','staff_name'] <> '{}'::jsonb
   then raise exception 'Invalid line update' using errcode='22023'; end if;
  if (p_values ? 'quantity' and (jsonb_typeof(p_values->'quantity')<>'number' or (p_values->>'quantity') !~ '^[0-9]{1,3}$'))
   or (p_values ? 'unit_price' and (jsonb_typeof(p_values->'unit_price') not in ('number','string')
    or (p_values->>'unit_price') !~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$'))
   or (p_values ? 'staff_name' and (jsonb_typeof(p_values->'staff_name')<>'string' or length(p_values->>'staff_name')>200))
   or (p_values ? 'staff_id' and jsonb_typeof(p_values->'staff_id') not in ('string','null'))
   then raise exception 'Invalid line values' using errcode='22023'; end if;
  begin new_quantity=coalesce((p_values->>'quantity')::integer,line_row.quantity);
   new_price=coalesce((p_values->>'unit_price')::numeric,line_row.unit_price);
  exception when others then raise exception 'Invalid line values' using errcode='22023'; end;
  if new_quantity not between 1 and 999 or new_price::text='NaN' or new_price<0 or new_price>=1000000000000
   or new_quantity*new_price>=1000000000000
   then raise exception 'Invalid line values' using errcode='22023'; end if;
  if p_values ? 'staff_id' and p_values->>'staff_id' is not null then
   if (p_values->>'staff_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or not exists(select 1 from public.memberships where organization_id=p_organization_id
     and user_id=(p_values->>'staff_id')::uuid and role in ('owner','admin','member'))
    then raise exception 'Invalid staff assignment' using errcode='22023'; end if;
  end if;
  update public.sale_cart_lines set quantity=new_quantity,unit_price=new_price,
   line_total=(new_quantity*new_price)::numeric(14,2),
   staff_id=case when p_values ? 'staff_id' then (p_values->>'staff_id')::uuid else staff_id end,
   staff_name_snapshot=case when p_values ? 'staff_name' then p_values->>'staff_name' else staff_name_snapshot end
  where id=p_line_id;
 elsif p_action='remove' then
  if line_row.status<>'active' or p_values - 'reason' <> '{}'::jsonb
   or jsonb_typeof(p_values->'reason')<>'string' or length(btrim(p_values->>'reason')) not between 1 and 1000
   then raise exception 'Removal reason required' using errcode='22023'; end if;
  update public.sale_cart_lines set status='removed',removal_reason=btrim(p_values->>'reason'),
   removed_by=auth.uid(),removed_at=now() where id=p_line_id;
 else
  if line_row.status<>'removed' or p_values<>'{}'::jsonb then raise exception 'Only removed lines can be restored' using errcode='22023'; end if;
  update public.sale_cart_lines set status='active',removal_reason='',removed_by=null,removed_at=null where id=p_line_id;
 end if;
 perform private.sale_cart_recalculate(cart_row.id);
 result=private.sale_cart_payload(cart_row.id);
 insert into public.sale_cart_operations values(p_organization_id,p_operation_id,auth.uid(),'mutate_line',fp,result,now());
 return result;
exception when unique_violation then raise exception 'Source already active in another cart' using errcode='P0001';
end $$;
revoke all on function public.mutate_sale_cart_line(uuid,uuid,uuid,bigint,uuid,text,jsonb) from public,anon;
grant execute on function public.mutate_sale_cart_line(uuid,uuid,uuid,bigint,uuid,text,jsonb) to authenticated;

create function public.review_sale_cart(
 p_organization_id uuid,p_visit_id uuid,p_expected_version bigint,p_operation_id uuid,p_ready boolean
) returns jsonb language plpgsql security definer set search_path='' as $$
declare fp text; prior public.sale_cart_operations%rowtype; cart_row public.sale_carts%rowtype; result jsonb;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_visit_id is null or p_expected_version is null or p_expected_version<1 or p_operation_id is null or p_ready is null then raise exception 'Invalid review request' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('visit_id',p_visit_id,'version',p_expected_version,'ready',p_ready)::text);
 perform pg_advisory_xact_lock(hashtextextended('sale-cart:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.sale_cart_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then if prior.actor_id<>auth.uid() or prior.action<>'review_cart' or prior.request_fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if; return prior.result_snapshot; end if;
 select * into cart_row from public.sale_carts where organization_id=p_organization_id and visit_id=p_visit_id for update;
 if not found then raise exception 'Visit cart not found' using errcode='P0002'; end if;
 if cart_row.version<>p_expected_version or cart_row.status not in ('draft','ready') then raise exception 'Cart changed' using errcode='P0001'; end if;
 perform 1 from public.customer_visits where organization_id=p_organization_id and id=p_visit_id
  and status in ('open','checkout_ready') for update;
 if not found then raise exception 'Visit changed' using errcode='P0001'; end if;
 if p_ready and not exists(select 1 from public.sale_cart_lines where cart_id=cart_row.id and status='active')
  then raise exception 'Empty cart cannot be ready' using errcode='22023'; end if;
 update public.sale_carts set status=case when p_ready then 'ready' else 'draft' end,
  version=version+1,updated_by=auth.uid(),updated_at=now() where id=cart_row.id;
 update public.customer_visits set status=case when p_ready then 'checkout_ready' else 'open' end,
  version=version+1,updated_by=auth.uid(),updated_at=now() where id=p_visit_id;
 result=private.sale_cart_payload(cart_row.id);
 insert into public.sale_cart_operations values(p_organization_id,p_operation_id,auth.uid(),'review_cart',fp,result,now());
 return result;
end $$;
revoke all on function public.review_sale_cart(uuid,uuid,bigint,uuid,boolean) from public,anon;
grant execute on function public.review_sale_cart(uuid,uuid,bigint,uuid,boolean) to authenticated;

create function public.cancel_customer_visit(
 p_organization_id uuid,p_visit_id uuid,p_expected_version bigint,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare fp text; prior public.sale_cart_operations%rowtype; visit_row public.customer_visits%rowtype;
 cart_row public.sale_carts%rowtype; result jsonb;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_visit_id is null or p_expected_version is null or p_expected_version<1 or p_operation_id is null
  then raise exception 'Invalid cancel request' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('visit_id',p_visit_id,'version',p_expected_version)::text);
 perform pg_advisory_xact_lock(hashtextextended('sale-cart:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.sale_cart_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then if prior.actor_id<>auth.uid() or prior.action<>'cancel_visit' or prior.request_fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if; return prior.result_snapshot; end if;
 select * into cart_row from public.sale_carts where organization_id=p_organization_id and visit_id=p_visit_id for update;
 if not found then raise exception 'Visit cart not found' using errcode='P0002'; end if;
 select * into visit_row from public.customer_visits where organization_id=p_organization_id and id=p_visit_id for update;
 if cart_row.status not in ('draft','ready') then raise exception 'Cart changed' using errcode='P0001'; end if;
 if visit_row.version<>p_expected_version or visit_row.status not in ('open','checkout_ready') then raise exception 'Visit changed' using errcode='P0001'; end if;
 if exists(select 1 from public.sale_cart_lines where cart_id=cart_row.id and status='active')
  then raise exception 'Remove active lines before canceling visit' using errcode='22023'; end if;
 update public.customer_visits set status='canceled',closed_at=now(),version=version+1,
  updated_by=auth.uid(),updated_at=now() where id=p_visit_id;
 update public.sale_carts set status='void',version=version+1,updated_by=auth.uid(),updated_at=now() where id=cart_row.id;
 result=private.sale_cart_payload(cart_row.id);
 insert into public.sale_cart_operations values(p_organization_id,p_operation_id,auth.uid(),'cancel_visit',fp,result,now());
 return result;
end $$;
revoke all on function public.cancel_customer_visit(uuid,uuid,bigint,uuid) from public,anon;
grant execute on function public.cancel_customer_visit(uuid,uuid,bigint,uuid) to authenticated;

