-- 039: 재무·매출·재고 API가 요구하는 finance.basic 기능을 등록하고 모든 요금제에 포함한다.
-- 002 시드에는 이 기능이 없어 매출·정산·재고 화면이 권한 오류를 낼 수 있었다. 여러 번 실행해도 안전하다.
begin;

insert into public.features (code, name, description)
values ('finance.basic', '기본 재무·매출', '매출 장바구니·수납·정산, 재고와 수입·지출 관리 기능')
on conflict (code) do update
set name = excluded.name,
    description = excluded.description;

insert into public.plan_features (plan_id, feature_code)
select plans.id, 'finance.basic'
from public.plans
where plans.code in ('BASIC', 'STANDARD', 'PRO')
on conflict (plan_id, feature_code) do nothing;

commit;
