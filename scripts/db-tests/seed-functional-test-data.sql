-- 전체 기능 수동 점검용 테스트 데이터. 마이그레이션이 아닙니다.
-- 주의: 기존 DB 조회 결과에 맞춘 최종본이 아닙니다. inspect-functional-test-data.sql 결과를 확인하기 전에는 실행하지 마세요.
-- Supabase SQL Editor에서 실행하기 전에 pg_temp.qa_seed_context에 넣은 UUID를 테스트 조직 ID로 바꾸세요.
-- 운영 조직 대신 테스트 전용 조직에서 실행하고, 파일/사진은 실제 Storage 객체가 필요하므로 앱에서 업로드하세요.
-- 다시 실행해도 이 스크립트의 표식 데이터는 중복 생성하지 않습니다.
-- 만든 데이터는 이름/전화번호/상품 SKU에 [QA-064] 표식이 있습니다.

begin;
create temporary table qa_seed_context (organization_id uuid primary key) on commit drop;
insert into pg_temp.qa_seed_context values ('00000000-0000-0000-0000-000000000000'::uuid);

do $seed$
declare
  v_organization_id uuid;
  v_actor_id uuid;
  v_customer_id uuid;
  v_staff_id uuid;
  v_service_id uuid;
  v_room_id uuid;
  v_appointment_id uuid;
  v_treatment_id uuid;
  v_product_id uuid;
  v_membership_product_id uuid;
  v_supplier_id uuid;
  v_order_id uuid;
  v_order_line_id uuid;
  v_booking_date date := current_date + 1;
  v_starts_at timestamptz;
  v_order_operation_id uuid := '64000000-0000-4000-8000-000000000001';
begin
  select organization_id into v_organization_id from pg_temp.qa_seed_context;
  if v_organization_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception 'pg_temp.qa_seed_context의 UUID를 테스트 조직 UUID로 바꾼 뒤 실행하세요.';
  end if;

  -- owner/admin 작성자 ID를 사용합니다. 테스트 조직과 권한이 맞지 않으면 중단합니다.
  select m.user_id into v_actor_id
  from public.memberships m
  where m.organization_id = v_organization_id and m.role in ('owner', 'admin')
  order by case m.role when 'owner' then 0 else 1 end, m.created_at
  limit 1;
  if v_actor_id is null then
    raise exception '테스트 조직을 찾을 수 없거나 owner/admin 구성원이 없습니다: %', v_organization_id;
  end if;

  -- 고객관리: 프로필, 태그, 피부/관심 정보를 확인할 대표 고객입니다.
  select c.id into v_customer_id
  from public.customers c
  where c.organization_id = v_organization_id and c.phone = '010-0640-0001'
  limit 1;
  if v_customer_id is null then
    insert into public.customers (
      organization_id, name, email, phone, notes, birth_date, skin_type,
      concerns, allergies, tags, status, created_at, updated_at
    ) values (
      v_organization_id, '[QA-064] 예약·시술 테스트 고객', 'qa064-customer@example.invalid',
      '010-0640-0001', '전체 기능 수동 점검용 데이터입니다. 실제 고객 정보가 아닙니다.',
      date '1992-04-15', '건성', array['탄력','보습'], '향료 민감(테스트)',
      array['QA-064','재방문'], 'vip', now(), now()
    ) returning id into v_customer_id;
  end if;

  insert into public.customers (
    organization_id, name, email, phone, notes, skin_type, concerns, tags, status
  ) select v_organization_id, '[QA-064] 신규 고객 필터 테스트', 'qa064-new@example.invalid',
    '010-0640-0002', '검색·신규 등록 흐름 확인용', '복합성', array['모공'], array['QA-064','신규'], 'active'
  where not exists (select 1 from public.customers where organization_id=v_organization_id and phone='010-0640-0002');

  insert into public.customers (
    organization_id, name, email, phone, notes, tags, status
  ) select v_organization_id, '[QA-064] 휴면 고객 필터 테스트', 'qa064-inactive@example.invalid',
    '010-0640-0003', '비활성/휴면 고객 필터 확인용', array['QA-064','휴면'], 'inactive'
  where not exists (select 1 from public.customers where organization_id=v_organization_id and phone='010-0640-0003');

  -- 예약: 매일 테스트 가능 시간과 직원/서비스/룸을 만들고 내일 오전 예약 1건을 준비합니다.
  select s.id into v_staff_id from public.appointment_staff s
  where s.organization_id=v_organization_id and s.name='[QA-064] 테스트 담당자' limit 1;
  if v_staff_id is null then
    insert into public.appointment_staff (organization_id,name,created_by)
    values (v_organization_id,'[QA-064] 테스트 담당자',v_actor_id) returning id into v_staff_id;
  end if;

  select s.id into v_service_id from public.appointment_services s
  where s.organization_id=v_organization_id and s.name='[QA-064] 시그니처 케어' limit 1;
  if v_service_id is null then
    insert into public.appointment_services (organization_id,name,duration_minutes,buffer_minutes,created_by)
    values (v_organization_id,'[QA-064] 시그니처 케어',60,10,v_actor_id) returning id into v_service_id;
  end if;

  insert into public.appointment_staff_working_hours
    (organization_id,staff_id,weekday,start_time,end_time,timezone_name,created_by)
  select v_organization_id,v_staff_id,d,'09:00'::time,'20:00'::time,'Asia/Seoul',v_actor_id
  from generate_series(1,7) as weekdays(d)
  on conflict (organization_id,staff_id,weekday,start_time) do nothing;

  select r.id into v_room_id from public.appointment_resources r
  where r.organization_id=v_organization_id and r.kind='room' and r.name='[QA-064] 테스트룸 A' limit 1;
  if v_room_id is null then
    insert into public.appointment_resources (organization_id,name,kind,created_by,updated_by)
    values (v_organization_id,'[QA-064] 테스트룸 A','room',v_actor_id,v_actor_id) returning id into v_room_id;
  end if;

  insert into public.appointment_service_resource_requirements
    (organization_id,service_id,kind,quantity,created_by)
  values (v_organization_id,v_service_id,'room',1,v_actor_id)
  on conflict (organization_id,service_id,kind) do nothing;

  insert into public.appointment_service_staff (organization_id,service_id,staff_id)
  values (v_organization_id,v_service_id,v_staff_id)
  on conflict (organization_id,service_id,staff_id) do nothing;

  v_starts_at := (v_booking_date + time '11:00') at time zone 'Asia/Seoul';
  select a.id into v_appointment_id from public.appointments a
  where a.organization_id=v_organization_id and a.customer_id=v_customer_id and a.start_at=v_starts_at
  limit 1;
  if v_appointment_id is null then
    insert into public.appointments (
      organization_id,customer_id,staff_id,service_id,service_name_snapshot,
      duration_minutes,buffer_minutes,start_at,end_at,status,source,resource_ids,created_by,updated_by
    ) values (
      v_organization_id,v_customer_id,v_staff_id,v_service_id,'[QA-064] 시그니처 케어',
      60,10,v_starts_at,v_starts_at+interval '60 minutes','reserved','manual',array[v_room_id],v_actor_id,v_actor_id
    ) returning id into v_appointment_id;
  end if;

  -- 시술: 예약 연결 상태의 초안입니다. 체크인 후 앱에서 방문 연결을 확인할 수 있습니다.
  select t.id into v_treatment_id from public.treatment_records t
  where t.organization_id=v_organization_id and t.customer_id=v_customer_id
    and t.treatment_name='[QA-064] 시그니처 케어 기록'
  order by t.created_at desc limit 1;
  if v_treatment_id is null then
    insert into public.treatment_records (
      organization_id,customer_id,treatment_date,treatment_name,category,practitioner,
      notes,amount,next_visit_date,created_by,appointment_id
    ) values (
      v_organization_id,v_customer_id,current_date,'[QA-064] 시그니처 케어 기록','피부관리',
      '[QA-064] 테스트 담당자','초기 상태: draft. 시술 시작/완료와 방문 연결은 앱에서 진행하세요.',45000,
      current_date+30,v_actor_id,v_appointment_id
    ) returning id into v_treatment_id;
  end if;

  -- 상품/회원권: 상품은 재고 0으로 시작합니다. 발주 입고 또는 재고 조정 UI를 먼저 확인하세요.
  insert into public.catalog_products (
    organization_id,sku,name,kind,unit_name,sale_price,benefit_money,benefit_count,valid_days,is_active,stock_quantity
  ) values (
    v_organization_id,'QA064-PRODUCT-01','[QA-064] 수분 앰플','product','개',32000,0,0,null,true,0
  ) on conflict (organization_id,sku) do nothing;
  select p.id into v_product_id from public.catalog_products p
  where p.organization_id=v_organization_id and p.sku='QA064-PRODUCT-01';

  insert into public.catalog_products (
    organization_id,sku,name,kind,unit_name,sale_price,benefit_money,benefit_count,valid_days,is_active,stock_quantity
  ) values (
    v_organization_id,'QA064-MEMBER-01','[QA-064] 관리 5회권','membership','회',200000,0,5,180,true,0
  ) on conflict (organization_id,sku) do nothing;
  select p.id into v_membership_product_id from public.catalog_products p
  where p.organization_id=v_organization_id and p.sku='QA064-MEMBER-01';

  -- 발주: 10개 주문·미입고 상태로 생성합니다. 앱에서 부분 입고/재시도를 테스트하세요.
  select s.id into v_supplier_id from public.catalog_suppliers s
  where s.organization_id=v_organization_id and s.name='[QA-064] 테스트 공급사' limit 1;
  if v_supplier_id is null then
    insert into public.catalog_suppliers (organization_id,name,contact_name,phone,email,note,created_by)
    values (v_organization_id,'[QA-064] 테스트 공급사','테스트 담당','02-0000-0640','qa064-supplier@example.invalid','수동 기능 점검용',v_actor_id)
    returning id into v_supplier_id;
  end if;

  select o.id into v_order_id from public.catalog_purchase_orders o
  where o.organization_id=v_organization_id and o.operation_id=v_order_operation_id limit 1;
  if v_order_id is null then
    insert into public.catalog_purchase_orders (
      organization_id,supplier_id,operation_id,request_fingerprint,status,ordered_at,note,created_by
    ) values (
      v_organization_id,v_supplier_id,v_order_operation_id,md5('QA-064 purchase order'),
      'ordered',now(),'전체 기능 점검용 발주. 부분 입고 후 남은 수량을 확인하세요.',v_actor_id
    ) returning id into v_order_id;
  end if;
  select l.id into v_order_line_id from public.catalog_purchase_order_lines l
  where l.organization_id=v_organization_id and l.order_id=v_order_id and l.product_id=v_product_id limit 1;
  if v_order_line_id is null then
    insert into public.catalog_purchase_order_lines (
      organization_id,order_id,product_id,quantity_ordered,quantity_received,unit_cost,note
    ) values (v_organization_id,v_order_id,v_product_id,10,0,18000,'부분 입고 테스트용')
    returning id into v_order_line_id;
  end if;

  -- 할 일·정산 목록의 첫 화면에서 확인할 예시입니다.
  insert into public.tasks (organization_id,created_by,title,description,due_at,status,priority,labels,checklist,customer_id,appointment_id)
  select v_organization_id,v_actor_id,'[QA-064] 방문 후 고객 안내','예약 고객에게 관리 후 주의사항을 전달합니다.',
    (v_booking_date + time '15:00') at time zone 'Asia/Seoul','open','high',array['QA-064','고객관리'],
    '[{"id":"qa064-step-1","text":"안내 내용 확인","done":false},{"id":"qa064-step-2","text":"다음 예약 제안","done":false}]'::jsonb,v_customer_id,v_appointment_id
  where not exists (select 1 from public.tasks where organization_id=v_organization_id and title='[QA-064] 방문 후 고객 안내');

  insert into public.finance_transactions (organization_id,transaction_type,amount,transaction_date,category,counterparty,memo,created_by)
  select v_organization_id,'income',45000,current_date,'시술 매출','[QA-064] 테스트 고객','테스트 화면 표시용 예시. 실제 결제 건이 아닙니다.',v_actor_id
  where not exists (select 1 from public.finance_transactions where organization_id=v_organization_id and memo='테스트 화면 표시용 예시. 실제 결제 건이 아닙니다.' and transaction_type='income');
  insert into public.finance_transactions (organization_id,transaction_type,amount,transaction_date,category,counterparty,memo,created_by)
  select v_organization_id,'expense',18000,current_date,'상품 매입','[QA-064] 테스트 공급사','테스트 화면 표시용 예시. 발주 입고 시 별도 실적과 구분하세요.',v_actor_id
  where not exists (select 1 from public.finance_transactions where organization_id=v_organization_id and memo='테스트 화면 표시용 예시. 발주 입고 시 별도 실적과 구분하세요.');

  insert into public.documents (organization_id,title,content,status,created_by)
  select v_organization_id,'[QA-064] 문서 편집 테스트 초안',
    '전체 기능 수동 점검용 초안입니다. 실제 고객 동의서나 서명 증거가 아닙니다.','draft',v_actor_id
  where not exists (select 1 from public.documents where organization_id=v_organization_id and title='[QA-064] 문서 편집 테스트 초안');

  raise notice 'QA-064 seed 완료: org=%, customer=%, appointment=%, treatment=%, product=%, order=%',
    v_organization_id,v_customer_id,v_appointment_id,v_treatment_id,v_product_id,v_order_id;
end;
$seed$;

-- 실행 결과를 확인합니다. Supabase SQL Editor는 아래 SELECT 결과도 함께 표시합니다.
select id,name,phone,status,tags
from public.customers
where organization_id=(select organization_id from pg_temp.qa_seed_context)
  and phone like '010-0640-%'
order by phone;

select a.id,a.start_at,a.status,c.name as customer,s.name as staff,a.service_name_snapshot
from public.appointments a
join public.customers c on c.id=a.customer_id and c.organization_id=a.organization_id
join public.appointment_staff s on s.id=a.staff_id and s.organization_id=a.organization_id
where a.organization_id=(select organization_id from pg_temp.qa_seed_context)
  and c.phone='010-0640-0001'
order by a.start_at desc;

select p.id,p.sku,p.name,p.kind,p.stock_quantity,
       o.id as purchase_order_id,o.status as purchase_order_status,l.quantity_ordered,l.quantity_received
from public.catalog_products p
left join public.catalog_purchase_order_lines l on l.product_id=p.id and l.organization_id=p.organization_id
left join public.catalog_purchase_orders o on o.id=l.order_id and o.organization_id=l.organization_id
where p.organization_id=(select organization_id from pg_temp.qa_seed_context)
  and p.sku like 'QA064-%'
order by p.sku;

select id,title,status,priority,customer_id,appointment_id
from public.tasks
where organization_id=(select organization_id from pg_temp.qa_seed_context)
  and title like '[QA-064]%'
order by created_at desc;

select id,title,status,created_at
from public.documents
where organization_id=(select organization_id from pg_temp.qa_seed_context)
  and title='[QA-064] 문서 편집 테스트 초안';

commit;
