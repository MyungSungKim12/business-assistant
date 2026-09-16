begin;

insert into public.features (code, name, description)
values
    ('dashboard.basic', '기본 대시보드', '기본 대시보드 조회 권한'),
    ('crm.basic', '기본 CRM', '고객 관계 관리 기본 기능'),
    ('task.basic', '기본 작업 관리', '작업과 일정 관리 기능'),
    ('document.template', '문서 템플릿', '문서 템플릿 기능'),
    ('data.basic', '기본 데이터', '기본 데이터 관리 기능'),
    ('reports.basic', '기본 보고서', '기본 보고서 조회 기능'),
    ('automation.custom', '맞춤 자동화', '맞춤 자동화 기능'),
    ('ai.summary', 'AI 요약', 'AI 요약 기능')
on conflict (code) do update
set name = excluded.name,
    description = excluded.description;

insert into public.plans (code, name, price_krw, billing_interval, is_active)
values
    ('BASIC', '베이직', 0, 'monthly', true),
    ('STANDARD', '스탠다드', 49000, 'monthly', true),
    ('PRO', '프로', 99000, 'monthly', true)
on conflict (code) do update
set name = excluded.name,
    price_krw = excluded.price_krw,
    billing_interval = excluded.billing_interval,
    is_active = excluded.is_active;

insert into public.plan_features (plan_id, feature_code)
select plans.id, entitlements.feature_code
from (
    values
        ('BASIC', 'dashboard.basic'),
        ('BASIC', 'crm.basic'),
        ('BASIC', 'task.basic'),
        ('STANDARD', 'dashboard.basic'),
        ('STANDARD', 'crm.basic'),
        ('STANDARD', 'task.basic'),
        ('STANDARD', 'document.template'),
        ('STANDARD', 'data.basic'),
        ('STANDARD', 'reports.basic'),
        ('PRO', 'dashboard.basic'),
        ('PRO', 'crm.basic'),
        ('PRO', 'task.basic'),
        ('PRO', 'document.template'),
        ('PRO', 'data.basic'),
        ('PRO', 'reports.basic'),
        ('PRO', 'automation.custom'),
        ('PRO', 'ai.summary')
) as entitlements(plan_code, feature_code)
join public.plans on plans.code = entitlements.plan_code
on conflict (plan_id, feature_code) do nothing;

commit;
