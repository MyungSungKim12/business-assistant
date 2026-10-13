-- CRM-11/CRM-12: 고객 검색 지원 인덱스, 보관 상태 허용, 태그 관리 RPC, 중복 후보 탐지, 고객 병합.
-- 멱등: 여러 번 실행해도 같은 결과다. 기존 마이그레이션은 수정하지 않는다.
begin;

-- 1) 화면은 보관(status = 'archived')을 쓰지만 014의 CHECK 제약은 active/inactive/vip/blocked만 허용했다.
--    병합 후 보조 고객을 보관 처리하려면 'archived'가 필요하므로 제약을 넓힌다(기존 값은 모두 그대로 유효).
alter table public.customers drop constraint if exists customers_status_check;
alter table public.customers
    add constraint customers_status_check check (status in ('active', 'inactive', 'vip', 'blocked', 'archived'));

-- 2) 목록 정렬·최근 등록 조회용 인덱스.
create index if not exists idx_customers_org_created
    on public.customers (organization_id, created_at desc);
create index if not exists idx_customers_org_name
    on public.customers (organization_id, name);

-- 3) 병합 이력. 직접 쓰기는 막고 merge_customers 함수만 기록한다.
--    고객 행은 영구 삭제될 수 있으므로 고객 FK는 걸지 않는다(이력은 남긴다).
create table if not exists public.customer_merge_history (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    primary_customer_id uuid not null,
    secondary_customer_id uuid not null,
    operation_id uuid not null,
    merged_by uuid not null,
    fingerprint text not null,
    moved_counts jsonb not null default '{}'::jsonb check (jsonb_typeof(moved_counts) = 'object'),
    secondary_snapshot jsonb not null check (jsonb_typeof(secondary_snapshot) = 'object'),
    result_snapshot jsonb not null check (jsonb_typeof(result_snapshot) = 'object'),
    created_at timestamptz not null default now(),
    unique (organization_id, operation_id),
    check (primary_customer_id <> secondary_customer_id)
);

create index if not exists idx_customer_merge_history_secondary
    on public.customer_merge_history (organization_id, secondary_customer_id);
create index if not exists idx_customer_merge_history_primary
    on public.customer_merge_history (organization_id, primary_customer_id);

alter table public.customer_merge_history enable row level security;

drop policy if exists customer_merge_history_select_manager on public.customer_merge_history;
create policy customer_merge_history_select_manager on public.customer_merge_history
    for select to authenticated
    using ((select private.has_organization_role(organization_id, array['owner', 'admin']::text[])));

revoke all on public.customer_merge_history from public, anon, authenticated;
grant select on public.customer_merge_history to authenticated;

-- 4) 태그 목록과 사용 고객 수(조직 구성원 조회).
create or replace function public.list_customer_tags(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if (select auth.uid()) is null or p_organization_id is null
        or not private.has_organization_role(p_organization_id, array['owner', 'admin', 'member']::text[]) then
        raise exception 'Customer permission required' using errcode = '42501';
    end if;
    return coalesce((
        select jsonb_agg(jsonb_build_object('tag', t.tag, 'count', t.customer_count) order by t.customer_count desc, t.tag)
        from (
            select u.tag, count(distinct c.id) as customer_count
            from public.customers c
            cross join lateral unnest(c.tags) as u(tag)
            where c.organization_id = p_organization_id and btrim(u.tag) <> ''
            group by u.tag
        ) t
    ), '[]'::jsonb);
end
$$;

-- 5) 태그 병합(여러 이름을 하나로)·이름 바꾸기. 고객별 배열을 치환하고 중복은 첫 위치만 남긴다.
create or replace function public.merge_customer_tags(
    p_organization_id uuid,
    p_from text[],
    p_to text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_to text := btrim(coalesce(p_to, ''));
    v_from text[];
    v_updated bigint;
begin
    if (select auth.uid()) is null or p_organization_id is null
        or not private.has_organization_role(p_organization_id, array['owner', 'admin']::text[]) then
        raise exception 'Customer tag permission required' using errcode = '42501';
    end if;
    if p_from is null or cardinality(p_from) = 0 or cardinality(p_from) > 30
        or length(v_to) not between 1 and 50 then
        raise exception 'Invalid customer tag' using errcode = '22023';
    end if;
    select coalesce(array_agg(distinct btrim(f)), '{}'::text[]) into v_from
    from unnest(p_from) as f where btrim(coalesce(f, '')) <> '';
    if cardinality(v_from) = 0 or exists (select 1 from unnest(v_from) as f where length(f) > 50) then
        raise exception 'Invalid customer tag' using errcode = '22023';
    end if;

    update public.customers c
    set tags = coalesce((
        select array_agg(x.tag order by x.first_pos)
        from (
            select m.tag, min(m.pos) as first_pos
            from (
                select case when t.tag = any (v_from) then v_to else t.tag end as tag, t.pos
                from unnest(c.tags) with ordinality as t(tag, pos)
            ) m
            group by m.tag
        ) x
    ), '{}'::text[])
    where c.organization_id = p_organization_id and c.tags && v_from;
    get diagnostics v_updated = row_count;
    return jsonb_build_object('updated', v_updated, 'to', v_to);
end
$$;

create or replace function public.rename_customer_tag(
    p_organization_id uuid,
    p_from text,
    p_to text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
    return public.merge_customer_tags(p_organization_id, array[p_from]::text[], p_to);
end
$$;

-- 6) 태그 삭제(모든 고객에서 제거).
create or replace function public.delete_customer_tag(p_organization_id uuid, p_tag text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_tag text := btrim(coalesce(p_tag, ''));
    v_updated bigint;
begin
    if (select auth.uid()) is null or p_organization_id is null
        or not private.has_organization_role(p_organization_id, array['owner', 'admin']::text[]) then
        raise exception 'Customer tag permission required' using errcode = '42501';
    end if;
    if length(v_tag) not between 1 and 50 then
        raise exception 'Invalid customer tag' using errcode = '22023';
    end if;
    update public.customers c
    set tags = array_remove(c.tags, v_tag)
    where c.organization_id = p_organization_id and c.tags @> array[v_tag]::text[];
    get diagnostics v_updated = row_count;
    return jsonb_build_object('updated', v_updated);
end
$$;

-- 7) 중복 후보 그룹: 같은 연락처(숫자만 비교, 7자리 이상) 또는 같은 이메일(대소문자 무시)을 가진 보관되지 않은 고객.
create or replace function public.find_duplicate_customer_groups(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if (select auth.uid()) is null or p_organization_id is null
        or not private.has_organization_role(p_organization_id, array['owner', 'admin', 'member']::text[]) then
        raise exception 'Customer permission required' using errcode = '42501';
    end if;
    return coalesce((
        select jsonb_agg(jsonb_build_object('reason', g.reason, 'key', g.match_key, 'customers', g.customers) order by g.reason, g.match_key)
        from (
            select k.reason, k.match_key, jsonb_agg(to_jsonb(c) order by c.created_at, c.id) as customers
            from (
                select cc.id, 'phone'::text as reason, regexp_replace(cc.phone, '\D', '', 'g') as match_key
                from public.customers cc
                where cc.organization_id = p_organization_id and cc.status <> 'archived'
                    and length(regexp_replace(coalesce(cc.phone, ''), '\D', '', 'g')) >= 7
                union all
                select cc.id, 'email'::text, lower(btrim(cc.email))
                from public.customers cc
                where cc.organization_id = p_organization_id and cc.status <> 'archived'
                    and btrim(coalesce(cc.email, '')) <> ''
            ) k
            join public.customers c on c.id = k.id and c.organization_id = p_organization_id
            group by k.reason, k.match_key
            having count(*) > 1
            order by k.reason, k.match_key
            limit 100
        ) g
    ), '[]'::jsonb);
end
$$;

-- 8) 고객 병합. 보조 고객을 참조하는 모든 행을 대표 고객으로 옮기고 보조 고객은 보관한다(삭제하지 않는다).
--    - owner/admin 전용, 한 트랜잭션, operation_id 멱등.
--    - 이동 대상(고객 FK 보유 테이블): customer_activities, customer_photos, appointments, customer_visits,
--      sale_carts, customer_wallets, treatment_records, treatment_photos, treatment_record_events,
--      issued_treatment_documents. (treatment_sale_drafts는 불변이라 해당 고객에 있으면 병합을 거부한다.)
--    - (id, customer_id)로 서로 참조하는 테이블은 FK가 즉시 검사되므로 한 문장의 CTE로 함께 갱신한다.
--    - p_resolved: 대표 고객에 적용할 필드 값(name,email,phone,birth_date,skin_type,allergies,notes,tags,concerns,
--      last_visit_date,next_visit_date). 없는 키는 자동 병합(빈 값 보충, 메모 이어붙이기, 태그·고민 합집합, 최근 방문일 큰 값).
create or replace function public.merge_customers(
    p_organization_id uuid,
    p_primary_id uuid,
    p_secondary_id uuid,
    p_operation_id uuid,
    p_resolved jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := (select auth.uid());
    v_resolved jsonb := coalesce(p_resolved, '{}'::jsonb);
    v_primary public.customers%rowtype;
    v_secondary public.customers%rowtype;
    v_prior public.customer_merge_history%rowtype;
    v_fingerprint text;
    v_counts jsonb := '{}'::jsonb;
    v_n bigint;
    v_n2 bigint;
    v_n3 bigint;
    v_n4 bigint;
    v_name text;
    v_notes text;
    v_tags text[];
    v_concerns text[];
    v_result jsonb;
    v_history_id uuid;
begin
    if v_actor is null or p_organization_id is null
        or not private.has_organization_role(p_organization_id, array['owner', 'admin']::text[]) then
        raise exception 'Customer merge permission required' using errcode = '42501';
    end if;
    if p_primary_id is null or p_secondary_id is null or p_operation_id is null
        or p_primary_id = p_secondary_id or jsonb_typeof(v_resolved) <> 'object' then
        raise exception 'Invalid customer merge' using errcode = '22023';
    end if;
    if exists (
        select 1 from jsonb_object_keys(v_resolved) as k
        where k <> all (array['name', 'email', 'phone', 'birth_date', 'skin_type', 'allergies', 'notes',
            'tags', 'concerns', 'last_visit_date', 'next_visit_date']::text[])
    ) then
        raise exception 'Invalid customer merge field' using errcode = '22023';
    end if;

    v_fingerprint := md5(jsonb_build_object('primary', p_primary_id, 'secondary', p_secondary_id, 'resolved', v_resolved)::text);
    perform pg_advisory_xact_lock(hashtextextended('customer-merge:' || p_organization_id::text || p_operation_id::text, 0));
    select * into v_prior from public.customer_merge_history
    where organization_id = p_organization_id and operation_id = p_operation_id;
    if found then
        if v_prior.merged_by <> v_actor or v_prior.fingerprint <> v_fingerprint then
            raise exception 'Operation conflict' using errcode = 'P0001';
        end if;
        return v_prior.result_snapshot;
    end if;

    -- 데드락을 피하려고 id 순서로 두 행을 잠근다.
    perform 1 from public.customers
    where organization_id = p_organization_id and id in (p_primary_id, p_secondary_id)
    order by id for update;
    select * into v_primary from public.customers where organization_id = p_organization_id and id = p_primary_id;
    if not found then raise exception 'Primary customer not found' using errcode = 'P0002'; end if;
    select * into v_secondary from public.customers where organization_id = p_organization_id and id = p_secondary_id;
    if not found then raise exception 'Secondary customer not found' using errcode = 'P0002'; end if;

    if exists (
        select 1 from public.customer_merge_history h
        where h.organization_id = p_organization_id and h.secondary_customer_id in (p_primary_id, p_secondary_id)
    ) then
        raise exception 'Customer was already merged' using errcode = 'P0001';
    end if;
    if exists (
        select 1 from public.treatment_sale_drafts d
        where d.organization_id = p_organization_id and d.customer_id = p_secondary_id
    ) then
        raise exception 'Customer has immutable sale handoff records' using errcode = 'P0001';
    end if;

    -- 필드 결정(지정값 우선, 없으면 자동 병합).
    v_name := btrim(case when v_resolved ? 'name' then v_resolved ->> 'name' else v_primary.name end);
    if v_name is null or length(v_name) not between 1 and 200 then
        raise exception 'Invalid customer name' using errcode = '22023';
    end if;
    v_notes := case
        when v_resolved ? 'notes' then coalesce(v_resolved ->> 'notes', '')
        when btrim(v_secondary.notes) = '' or btrim(v_secondary.notes) = btrim(v_primary.notes) then v_primary.notes
        when btrim(v_primary.notes) = '' then v_secondary.notes
        else v_primary.notes || E'\n\n[병합: ' || v_secondary.name || E']\n' || v_secondary.notes
    end;
    if length(v_notes) > 5000 then raise exception 'Customer notes too long' using errcode = '22023'; end if;
    if v_resolved ? 'tags' then
        select coalesce(array_agg(x.t order by x.pos), '{}'::text[]) into v_tags from (
            select btrim(e.t) as t, min(e.pos) as pos from jsonb_array_elements_text(v_resolved -> 'tags') with ordinality as e(t, pos)
            where btrim(e.t) <> '' and length(btrim(e.t)) <= 50 group by btrim(e.t)
        ) x;
    else
        select coalesce(array_agg(x.t order by x.pos), '{}'::text[]) into v_tags from (
            select u.t, min(u.pos) as pos from unnest(v_primary.tags || v_secondary.tags) with ordinality as u(t, pos) group by u.t
        ) x;
    end if;
    v_tags := v_tags[1:30];
    if v_resolved ? 'concerns' then
        select coalesce(array_agg(x.t order by x.pos), '{}'::text[]) into v_concerns from (
            select btrim(e.t) as t, min(e.pos) as pos from jsonb_array_elements_text(v_resolved -> 'concerns') with ordinality as e(t, pos)
            where btrim(e.t) <> '' and length(btrim(e.t)) <= 100 group by btrim(e.t)
        ) x;
    else
        select coalesce(array_agg(x.t order by x.pos), '{}'::text[]) into v_concerns from (
            select u.t, min(u.pos) as pos from unnest(v_primary.concerns || v_secondary.concerns) with ordinality as u(t, pos) group by u.t
        ) x;
    end if;
    v_concerns := v_concerns[1:30];

    -- 연결 데이터 이동. 단일 FK 테이블은 문장별로, (id, customer_id) 복합 FK 묶음은 한 문장으로 갱신한다.
    update public.customer_activities set customer_id = p_primary_id
    where organization_id = p_organization_id and customer_id = p_secondary_id;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('customer_activities', v_n);

    update public.customer_photos set customer_id = p_primary_id
    where organization_id = p_organization_id and customer_id = p_secondary_id;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('customer_photos', v_n);

    update public.appointments
    set customer_id = p_primary_id, version = version + 1, updated_by = v_actor, updated_at = now()
    where organization_id = p_organization_id and customer_id = p_secondary_id;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('appointments', v_n);

    update public.customer_wallets set customer_id = p_primary_id
    where organization_id = p_organization_id and customer_id = p_secondary_id;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('customer_wallets', v_n);

    with moved_visits as (
        update public.customer_visits
        set customer_id = p_primary_id, version = version + 1, updated_by = v_actor, updated_at = now()
        where organization_id = p_organization_id and customer_id = p_secondary_id
        returning id
    ), moved_carts as (
        update public.sale_carts
        set customer_id = p_primary_id, updated_by = v_actor, updated_at = now()
        where organization_id = p_organization_id and customer_id = p_secondary_id
        returning id
    )
    select (select count(*) from moved_visits), (select count(*) from moved_carts) into v_n, v_n2;
    v_counts := v_counts || jsonb_build_object('customer_visits', v_n, 'sale_carts', v_n2);

    with moved_records as (
        update public.treatment_records set customer_id = p_primary_id, updated_at = now()
        where organization_id = p_organization_id and customer_id = p_secondary_id
        returning id
    ), moved_photos as (
        update public.treatment_photos set customer_id = p_primary_id
        where organization_id = p_organization_id and customer_id = p_secondary_id
        returning id
    ), moved_events as (
        update public.treatment_record_events set customer_id = p_primary_id
        where organization_id = p_organization_id and customer_id = p_secondary_id
        returning id
    ), moved_documents as (
        update public.issued_treatment_documents set customer_id = p_primary_id
        where organization_id = p_organization_id and customer_id = p_secondary_id
        returning id
    )
    select (select count(*) from moved_records), (select count(*) from moved_photos),
        (select count(*) from moved_events), (select count(*) from moved_documents)
    into v_n, v_n2, v_n3, v_n4;
    v_counts := v_counts || jsonb_build_object('treatment_records', v_n, 'treatment_photos', v_n2,
        'treatment_record_events', v_n3, 'issued_treatment_documents', v_n4);

    -- 대표 고객 갱신 후 보조 고객 보관(삭제 금지).
    update public.customers c
    set name = v_name,
        email = case when v_resolved ? 'email' then nullif(btrim(v_resolved ->> 'email'), '') else coalesce(c.email, v_secondary.email) end,
        phone = case when v_resolved ? 'phone' then nullif(btrim(v_resolved ->> 'phone'), '') else coalesce(c.phone, v_secondary.phone) end,
        birth_date = case when v_resolved ? 'birth_date' then (v_resolved ->> 'birth_date')::date else coalesce(c.birth_date, v_secondary.birth_date) end,
        skin_type = case when v_resolved ? 'skin_type' then nullif(btrim(v_resolved ->> 'skin_type'), '') else coalesce(c.skin_type, v_secondary.skin_type) end,
        allergies = case when v_resolved ? 'allergies' then coalesce(v_resolved ->> 'allergies', '')
            when btrim(c.allergies) = '' then v_secondary.allergies else c.allergies end,
        last_visit_date = case when v_resolved ? 'last_visit_date' then (v_resolved ->> 'last_visit_date')::date
            else greatest(c.last_visit_date, v_secondary.last_visit_date) end,
        next_visit_date = case when v_resolved ? 'next_visit_date' then (v_resolved ->> 'next_visit_date')::date
            else coalesce(c.next_visit_date, v_secondary.next_visit_date) end,
        notes = v_notes,
        tags = v_tags,
        concerns = v_concerns
    where c.organization_id = p_organization_id and c.id = p_primary_id
    returning * into v_primary;

    update public.customers
    set status = 'archived',
        notes = case when btrim(notes) = '' then '' else notes || E'\n\n' end || '[병합되어 보관됨: ' || v_primary.name || ']'
    where organization_id = p_organization_id and id = p_secondary_id;

    v_result := jsonb_build_object(
        'primary', (to_jsonb(v_primary) - 'updated_at'),
        'secondary_id', p_secondary_id,
        'moved', v_counts
    );
    insert into public.customer_merge_history (
        organization_id, primary_customer_id, secondary_customer_id, operation_id, merged_by,
        fingerprint, moved_counts, secondary_snapshot, result_snapshot
    ) values (
        p_organization_id, p_primary_id, p_secondary_id, p_operation_id, v_actor,
        v_fingerprint, v_counts, to_jsonb(v_secondary), v_result
    ) returning id into v_history_id;
    return v_result || jsonb_build_object('history_id', v_history_id);
end
$$;

-- 권한: 익명 실행 회수, 로그인 사용자에게만 부여(함수 안에서 조직 역할을 다시 검사한다).
revoke all on function public.list_customer_tags(uuid) from public, anon;
revoke all on function public.merge_customer_tags(uuid, text[], text) from public, anon;
revoke all on function public.rename_customer_tag(uuid, text, text) from public, anon;
revoke all on function public.delete_customer_tag(uuid, text) from public, anon;
revoke all on function public.find_duplicate_customer_groups(uuid) from public, anon;
revoke all on function public.merge_customers(uuid, uuid, uuid, uuid, jsonb) from public, anon;
grant execute on function public.list_customer_tags(uuid) to authenticated;
grant execute on function public.merge_customer_tags(uuid, text[], text) to authenticated;
grant execute on function public.rename_customer_tag(uuid, text, text) to authenticated;
grant execute on function public.delete_customer_tag(uuid, text) to authenticated;
grant execute on function public.find_duplicate_customer_groups(uuid) to authenticated;
grant execute on function public.merge_customers(uuid, uuid, uuid, uuid, jsonb) to authenticated;

commit;
