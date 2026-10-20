-- CRM: 고객 병합이 예약 대기 목록(appointment_waitlist, 056)도 대표 고객으로 옮기도록 merge_customers 를 다시 정의한다.
-- 044 이후에 만들어진 테이블이 병합 이동 목록에서 빠져, 병합으로 보조 고객이 삭제되면 대기 목록이 연쇄 삭제되던 문제를 막는다.
-- 044 는 수정하지 않고 이 파일에서 함수만 교체한다(서명·권한 동일).
begin;

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

    update public.appointment_waitlist set customer_id = p_primary_id
    where organization_id = p_organization_id and customer_id = p_secondary_id;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('appointment_waitlist', v_n);

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

revoke all on function public.merge_customers(uuid, uuid, uuid, uuid, jsonb) from public, anon;
grant execute on function public.merge_customers(uuid, uuid, uuid, uuid, jsonb) to authenticated;

commit;
