begin;

-- Existing records have unknown historical lifecycle; never infer completion.
alter table public.treatment_records
    add column status text not null default 'legacy',
    add column version integer not null default 1,
    add column started_at timestamptz,
    add column ended_at timestamptz;
alter table public.treatment_records alter column status set default 'draft';
alter table public.treatment_records
    add constraint treatment_records_status_check check (status in ('legacy', 'draft', 'in_progress', 'completed', 'cancelled')),
    add constraint treatment_records_version_check check (version > 0),
    add constraint treatment_records_values_check check (
        length(btrim(treatment_name)) between 1 and 200 and treatment_name ~ '[^[:space:]]'
        and length(category) <= 100 and length(practitioner) <= 100
        and length(notes) <= 10000 and isfinite(treatment_date)
        and (next_visit_date is null or (isfinite(next_visit_date) and next_visit_date >= treatment_date))
        and (amount is null or amount between 0 and 999999999999.99)
    ) not valid;

create table public.treatment_record_events (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete restrict,
    customer_id uuid not null,
    treatment_id uuid not null,
    actor_id uuid not null references auth.users(id) on delete restrict,
    action text not null check (action in ('edit', 'correct', 'start', 'complete', 'cancel')),
    reason text not null default '',
    occurred_at timestamptz not null default clock_timestamp(),
    before_data jsonb not null,
    after_data jsonb not null,
    operation_id uuid not null,
    request_data jsonb not null,
    constraint treatment_record_events_operation unique (treatment_id, operation_id),
    constraint treatment_record_events_customer foreign key (customer_id, organization_id)
        references public.customers(id, organization_id) on delete restrict,
    constraint treatment_record_events_treatment foreign key (treatment_id, customer_id)
        references public.treatment_records(id, customer_id) on delete restrict
);
create index idx_treatment_record_events_scope
    on public.treatment_record_events(organization_id, customer_id, treatment_id, occurred_at, id);
create index idx_treatment_record_events_actor on public.treatment_record_events(actor_id);
alter table public.treatment_record_events enable row level security;
create policy treatment_record_events_select_member on public.treatment_record_events
    for select to authenticated using (
        (select private.has_organization_role(organization_id, array['owner', 'admin', 'member']::text[]))
    );
revoke all on public.treatment_record_events from public, anon, authenticated;
grant select on public.treatment_record_events to authenticated;

-- Clients cannot spoof lifecycle metadata or bypass the atomic audit mutation.
revoke insert, update, delete on public.treatment_records from public, anon, authenticated;
drop policy treatment_records_update_manager on public.treatment_records;
drop policy treatment_records_delete_manager on public.treatment_records;
grant insert (organization_id, customer_id, treatment_date, treatment_name, category,
    practitioner, notes, amount, next_visit_date) on public.treatment_records to authenticated;

create function private.mutate_treatment(
    p_organization_id uuid, p_customer_id uuid, p_treatment_id uuid,
    p_expected_version integer, p_operation_id uuid, p_action text, p_reason text, p_values jsonb
) returns setof public.treatment_records
language plpgsql security definer set search_path = ''
as $$
declare
    v_row public.treatment_records;
    v_before jsonb;
    v_request jsonb;
    v_previous jsonb;
    v_actor uuid := auth.uid();
    v_time timestamptz;
    v_date date;
    v_next date;
    v_amount numeric;
    v_key text;
begin
    if v_actor is null or not private.has_organization_role(p_organization_id, array['owner', 'admin']::text[]) then
        raise exception 'Treatment mutation requires organization manager' using errcode = '42501';
    end if;
    if p_expected_version is null or p_expected_version < 1 or p_operation_id is null
       or p_action is null or p_values is null or jsonb_typeof(p_values) <> 'object'
       or length(coalesce(p_reason, '')) > 2000 then
        raise exception 'Invalid mutation input' using errcode = '22023';
    end if;
    select * into v_row from public.treatment_records
        where id = p_treatment_id and organization_id = p_organization_id and customer_id = p_customer_id
        for update;
    if not found then
        raise exception 'Treatment not found' using errcode = 'P0002';
    end if;
    v_request := jsonb_build_object('actor_id', v_actor, 'expected_version', p_expected_version,
        'action', p_action, 'reason', coalesce(p_reason, ''), 'values', p_values);
    select request_data into v_previous from public.treatment_record_events
        where treatment_id = p_treatment_id and operation_id = p_operation_id;
    if found then
        if v_previous <> v_request then
            raise exception 'Operation ID reused with different request' using errcode = 'P0001';
        end if;
        return next v_row;
        return;
    end if;
    if v_row.version <> p_expected_version then
        raise exception 'Treatment version conflict' using errcode = 'P0001';
    end if;
    if not (
        (p_action = 'edit' and v_row.status in ('draft', 'in_progress', 'legacy')) or
        (p_action = 'correct' and v_row.status in ('completed', 'cancelled', 'legacy')) or
        (p_action = 'start' and v_row.status = 'draft') or
        (p_action = 'complete' and v_row.status = 'in_progress') or
        (p_action = 'cancel' and v_row.status in ('draft', 'in_progress'))
    ) then
        raise exception 'Invalid treatment transition' using errcode = 'P0001';
    end if;
    if p_action in ('correct', 'cancel') and coalesce(p_reason, '') !~ '[^[:space:]]' then
        raise exception 'A reason is required' using errcode = '22023';
    end if;
    v_before := to_jsonb(v_row);
    if p_action in ('edit', 'correct') then
        if not (p_values ?& array['treatment_date','treatment_name','category','practitioner','notes','amount','next_visit_date'])
           or (p_values - array['treatment_date','treatment_name','category','practitioner','notes','amount','next_visit_date']) <> '{}'::jsonb then
            raise exception 'Exactly seven editable fields are required' using errcode = '22023';
        end if;
        foreach v_key in array array['treatment_date','treatment_name','category','practitioner','notes'] loop
            if jsonb_typeof(p_values -> v_key) <> 'string' then
                raise exception 'Editable text must be a string' using errcode = '22023';
            end if;
        end loop;
        if (p_values ->> 'treatment_date') !~ '^\d{4}-\d{2}-\d{2}$' then
            raise exception 'Expected ISO treatment date' using errcode = '22023';
        end if;
        v_date := (p_values ->> 'treatment_date')::date;
        if p_values -> 'next_visit_date' <> 'null'::jsonb then
            if jsonb_typeof(p_values -> 'next_visit_date') <> 'string'
               or (p_values ->> 'next_visit_date') !~ '^\d{4}-\d{2}-\d{2}$' then
                raise exception 'Expected ISO next visit date' using errcode = '22023';
            end if;
            v_next := (p_values ->> 'next_visit_date')::date;
        end if;
        if p_values -> 'amount' <> 'null'::jsonb then
            if jsonb_typeof(p_values -> 'amount') not in ('number', 'string')
               or (p_values ->> 'amount') !~ '^\d+(\.\d{1,2})?$' then
                raise exception 'Invalid amount' using errcode = '22023';
            end if;
            v_amount := (p_values ->> 'amount')::numeric;
        end if;
        v_row.treatment_date := v_date;
        v_row.treatment_name := btrim(p_values ->> 'treatment_name');
        v_row.category := btrim(p_values ->> 'category');
        v_row.practitioner := btrim(p_values ->> 'practitioner');
        v_row.notes := p_values ->> 'notes';
        v_row.amount := v_amount;
        v_row.next_visit_date := v_next;
    elsif p_values <> '{}'::jsonb then
        raise exception 'Transition cannot modify record values' using errcode = '22023';
    end if;
    v_time := clock_timestamp();
    if p_action = 'start' then
        v_row.status := 'in_progress';
        v_row.started_at := v_time;
    elsif p_action = 'complete' then
        v_row.status := 'completed';
        v_row.ended_at := v_time;
    elsif p_action = 'cancel' then
        v_row.status := 'cancelled';
        v_row.ended_at := v_time;
    end if;
    update public.treatment_records set
        treatment_date = v_row.treatment_date, treatment_name = v_row.treatment_name,
        category = v_row.category, practitioner = v_row.practitioner, notes = v_row.notes,
        amount = v_row.amount, next_visit_date = v_row.next_visit_date,
        status = v_row.status, started_at = v_row.started_at, ended_at = v_row.ended_at,
        version = version + 1, updated_at = v_time
        where id = v_row.id returning * into v_row;
    insert into public.treatment_record_events (organization_id, customer_id, treatment_id,
        actor_id, action, reason, occurred_at, before_data, after_data, operation_id, request_data)
    values (p_organization_id, p_customer_id, p_treatment_id, v_actor, p_action,
        coalesce(p_reason, ''), v_time, v_before, to_jsonb(v_row), p_operation_id, v_request);
    return next v_row;
end;
$$;
revoke all on function private.mutate_treatment(uuid,uuid,uuid,integer,uuid,text,text,jsonb) from public, anon;
grant execute on function private.mutate_treatment(uuid,uuid,uuid,integer,uuid,text,text,jsonb) to authenticated;

create function public.mutate_treatment(
    p_organization_id uuid, p_customer_id uuid, p_treatment_id uuid,
    p_expected_version integer, p_operation_id uuid, p_action text, p_reason text, p_values jsonb
) returns setof public.treatment_records
language sql security invoker set search_path = ''
as $$
    select * from private.mutate_treatment(p_organization_id, p_customer_id, p_treatment_id,
        p_expected_version, p_operation_id, p_action, p_reason, p_values);
$$;
revoke all on function public.mutate_treatment(uuid,uuid,uuid,integer,uuid,text,text,jsonb) from public, anon;
grant execute on function public.mutate_treatment(uuid,uuid,uuid,integer,uuid,text,text,jsonb) to authenticated;

commit;
