-- INV-10 / SVC-10 / WAL-10: 상품별 안전재고, 서비스 가격·카테고리 및 수정, 지갑 목록·잔액 변동 이력.
-- 027/028/030/034/035/038 이후에 실행한다. 여러 번 실행해도 안전하다. 기존 함수의 시그니처는 바꾸지 않는다.
begin;

-- 1) 상품별 안전재고. null 이면 화면의 공통 기본값을 쓴다.
-- private.catalog_payload 가 to_jsonb(p) 를 쓰므로 모든 상품 응답에 low_stock_threshold 가 자동으로 포함된다.
alter table public.catalog_products
 add column if not exists low_stock_threshold integer
  check (low_stock_threshold is null or low_stock_threshold between 0 and 1000000000);

create or replace function public.set_catalog_low_stock_threshold(
 p_organization_id uuid,p_product_id uuid,p_threshold integer,p_expected_version bigint,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare fp text; prior public.sale_cart_operations%rowtype; product public.catalog_products%rowtype; result jsonb;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_product_id is null or p_operation_id is null or p_expected_version is null or p_expected_version<1
  or (p_threshold is not null and p_threshold not between 0 and 1000000000) then
  raise exception 'Invalid low stock threshold' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('kind','low_stock','product',p_product_id,'threshold',p_threshold,'version',p_expected_version)::text);
 perform pg_advisory_xact_lock(hashtextextended('sale-cart:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.sale_cart_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.action<>'set_low_stock' or prior.request_fingerprint<>fp then
   raise exception 'Operation conflict' using errcode='P0001'; end if;
  return prior.result_snapshot;
 end if;
 select * into product from public.catalog_products where organization_id=p_organization_id and id=p_product_id for update;
 if not found then raise exception 'Product not found' using errcode='P0002'; end if;
 if product.kind<>'product' then raise exception 'Low stock applies to physical products only' using errcode='22023'; end if;
 if product.version<>p_expected_version then raise exception 'Product version conflict' using errcode='P0001'; end if;
 update public.catalog_products set low_stock_threshold=p_threshold,version=version+1
  where organization_id=p_organization_id and id=p_product_id;
 result=private.catalog_payload(p_product_id);
 insert into public.sale_cart_operations(organization_id,operation_id,actor_id,action,request_fingerprint,result_snapshot)
  values(p_organization_id,p_operation_id,auth.uid(),'set_low_stock',fp,result);
 return result;
end $$;
revoke all on function public.set_catalog_low_stock_threshold(uuid,uuid,integer,bigint,uuid) from public,anon,authenticated;
grant execute on function public.set_catalog_low_stock_threshold(uuid,uuid,integer,bigint,uuid) to authenticated;

-- 2) 서비스 가격·카테고리·편집 버전.
alter table public.appointment_services
 add column if not exists price_krw integer not null default 0 check (price_krw between 0 and 1000000000),
 add column if not exists category text not null default '' check (length(category) <= 60),
 add column if not exists service_version bigint not null default 1 check (service_version > 0);

-- 이름·소요·여유·가격·카테고리·활성 여부 수정. 비활성화는 미래 예약이 있어도 허용한다(기존 예약은 스냅샷을 유지하고 새 예약만 막힌다).
create or replace function public.update_appointment_service(
 p_organization_id uuid,p_service_id uuid,p_name text,p_duration_minutes integer,p_buffer_minutes integer,
 p_price_krw integer,p_category text,p_is_active boolean,p_expected_version bigint,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.appointment_services%rowtype; prior public.appointment_operations%rowtype; fp text;
begin
 perform private.assert_appointment_role(p_organization_id,true);
 if p_service_id is null or p_operation_id is null or p_expected_version is null or p_expected_version<1
  or p_name is null or length(btrim(p_name)) not between 1 and 160
  or p_duration_minutes is null or p_duration_minutes not between 5 and 480
  or p_buffer_minutes is null or p_buffer_minutes not between 0 and 120
  or p_price_krw is null or p_price_krw not between 0 and 1000000000
  or p_category is null or length(btrim(p_category))>60 or p_is_active is null then
  raise exception 'Invalid appointment service update' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('kind','service_update','id',p_service_id,'name',btrim(p_name),'duration',p_duration_minutes,
  'buffer',p_buffer_minutes,'price',p_price_krw,'category',btrim(p_category),'active',p_is_active,'version',p_expected_version)::text);
 perform pg_advisory_xact_lock(hashtextextended('appointment-operation:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.appointment_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if;
  return prior.result_snapshot;
 end if;
 select * into s from public.appointment_services where organization_id=p_organization_id and id=p_service_id for update;
 if not found then raise exception 'Appointment service not found' using errcode='P0002'; end if;
 if s.service_version<>p_expected_version then raise exception 'Appointment service changed' using errcode='P0001'; end if;
 update public.appointment_services set name=btrim(p_name),duration_minutes=p_duration_minutes,buffer_minutes=p_buffer_minutes,
  price_krw=p_price_krw,category=btrim(p_category),is_active=p_is_active,service_version=service_version+1
 where organization_id=p_organization_id and id=p_service_id returning * into s;
 insert into public.appointment_operations(organization_id,operation_id,actor_id,fingerprint,result_snapshot)
  values(p_organization_id,p_operation_id,auth.uid(),fp,to_jsonb(s));
 return to_jsonb(s);
end $$;
revoke all on function public.update_appointment_service(uuid,uuid,text,integer,integer,integer,text,boolean,bigint,uuid) from public,anon,authenticated;
grant execute on function public.update_appointment_service(uuid,uuid,text,integer,integer,integer,text,boolean,bigint,uuid) to authenticated;

-- 3) 조직 전체 지갑 목록(고객 이름·발급 혜택 포함). 조직 구성원 읽기.
create or replace function public.list_organization_wallets(p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin','member']::text[]) then
  raise exception 'Wallet read permission required' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object(
   'id',w.id,'organization_id',w.organization_id,'customer_id',w.customer_id,'customer_name',c.name,
   'product_id',w.product_id,'name_snapshot',w.name_snapshot,
   'money_balance',w.money_balance::text,'count_balance',w.count_balance,
   'issued_money',coalesce(i.money_amount,0)::text,'issued_count',coalesce(i.count_amount,0),
   'valid_from',w.valid_from,'expires_on',w.expires_on,'lifecycle_status',w.lifecycle_status,
   'paused_on',w.paused_on,'lifecycle_version',w.lifecycle_version,'created_at',w.created_at
  ) order by w.created_at desc,w.id desc)
  from public.customer_wallets w
  join public.customers c on c.id=w.customer_id and c.organization_id=w.organization_id
  left join public.wallet_issuance_ledger i on i.wallet_id=w.id and i.organization_id=w.organization_id
  where w.organization_id=p_organization_id),'[]'::jsonb);
end $$;
revoke all on function public.list_organization_wallets(uuid) from public,anon,authenticated;
grant execute on function public.list_organization_wallets(uuid) to authenticated;

-- 4) 지갑 잔액 변동 이력: 발급·사용·사용 취소(환불)·구매 취소·정지·재개·연장. 최신순 최대 500건.
create or replace function public.list_wallet_history(p_organization_id uuid,p_customer_id uuid,p_wallet_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin','member']::text[]) then
  raise exception 'Wallet read permission required' using errcode='42501'; end if;
 if not exists(select 1 from public.customer_wallets where organization_id=p_organization_id
  and customer_id=p_customer_id and id=p_wallet_id) then
  raise exception 'Wallet not found' using errcode='P0002'; end if;
 return coalesce((select jsonb_agg(h.event order by h.occurred_at desc,h.id desc) from (
  select e.id,e.occurred_at,e.event from (
   select i.id,i.created_at as occurred_at,jsonb_build_object('id',i.id,'event_type','issue','occurred_at',i.created_at,
    'money_delta',i.money_amount::text,'count_delta',i.count_amount,'reason',null,'visit_id',null,
    'previous_expires_on',null,'expires_on',null) as event
   from public.wallet_issuance_ledger i where i.organization_id=p_organization_id and i.wallet_id=p_wallet_id
   union all
   select u.id,u.created_at,jsonb_build_object('id',u.id,'event_type','use','occurred_at',u.created_at,
    'money_delta',u.money_delta::text,'count_delta',u.count_delta,'reason',null,'visit_id',u.visit_id,
    'previous_expires_on',null,'expires_on',null)
   from public.wallet_usage_ledger u where u.organization_id=p_organization_id and u.wallet_id=p_wallet_id
   union all
   select r.id,r.created_at,jsonb_build_object('id',r.id,'event_type','use_refund','occurred_at',r.created_at,
    'money_delta',r.money_delta::text,'count_delta',r.count_delta,'reason',r.reason,'visit_id',r.visit_id,
    'previous_expires_on',null,'expires_on',null)
   from public.visit_payment_refunds r join public.wallet_usage_ledger u on u.id=r.wallet_usage_id
   where r.source_kind='wallet_usage' and u.organization_id=p_organization_id and u.wallet_id=p_wallet_id
   union all
   select v.id,v.created_at,jsonb_build_object('id',v.id,'event_type','reversal','occurred_at',v.created_at,
    'money_delta',(-v.money_amount)::text,'count_delta',-v.count_amount,'reason',null,'visit_id',null,
    'previous_expires_on',null,'expires_on',null)
   from public.catalog_sale_reversal_ledger v
   where v.organization_id=p_organization_id and v.kind='membership' and v.wallet_id=p_wallet_id
   union all
   select l.id,l.created_at,jsonb_build_object('id',l.id,'event_type',l.action,'occurred_at',l.created_at,
    'money_delta','0','count_delta',0,'reason',l.reason,'visit_id',null,
    'previous_expires_on',l.previous_expires_on,'expires_on',l.expires_on)
   from public.wallet_lifecycle_events l where l.organization_id=p_organization_id and l.wallet_id=p_wallet_id
  ) e order by e.occurred_at desc,e.id desc limit 500
 ) h),'[]'::jsonb);
end $$;
revoke all on function public.list_wallet_history(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.list_wallet_history(uuid,uuid,uuid) to authenticated;

commit;
