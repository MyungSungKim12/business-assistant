begin;

-- RLS가 행 단위 접근을 통제하고, 아래 GRANT는 Data API의 테이블 접근 자체를 허용한다.
grant usage on schema public to authenticated;

grant select, insert, update, delete on
    public.profiles,
    public.organizations,
    public.memberships,
    public.features,
    public.plans,
    public.plan_features,
    public.subscriptions,
    public.customers,
    public.tasks,
    public.document_templates,
    public.documents,
    public.finance_transactions,
    public.file_assets
to authenticated;

commit;
