begin;

-- Historical records retain unknown consultation/acknowledgment information.
alter table public.treatment_records
    add column consultation_goal text not null default '',
    add column consultation_plan text not null default '',
    add column cautions_snapshot jsonb not null default '{}'::jsonb,
    add column cautions_acknowledged_by uuid references auth.users(id) on delete restrict,
    add column cautions_acknowledged_at timestamptz,
    add constraint treatment_records_consultation_lengths check (
        length(consultation_goal) <= 2000 and length(consultation_plan) <= 5000
    );
alter table public.treatment_record_events drop constraint treatment_record_events_action_check;
alter table public.treatment_record_events add constraint treatment_record_events_action_check
    check (action in ('edit', 'correct', 'start', 'complete', 'cancel', 'consult'));

-- Keep the established lifecycle mutation, but prohibit callers bypassing the new guard.
alter function private.mutate_treatment(uuid,uuid,uuid,integer,uuid,text,text,jsonb)
    rename to mutate_treatment_v16;
revoke all on function private.mutate_treatment_v16(uuid,uuid,uuid,integer,uuid,text,text,jsonb)
    from public, anon, authenticated;

create function private.mutate_treatment(
    p_organization_id uuid, p_customer_id uuid, p_treatment_id uuid,
    p_expected_version integer, p_operation_id uuid, p_action text, p_reason text, p_values jsonb
) returns setof public.treatment_records
language plpgsql security definer set search_path = ''
as $$
declare
    v_row public.treatment_records;
    v_actor uuid := auth.uid();
    v_request jsonb;
    v_previous jsonb;
    v_cautions jsonb;
    v_expected jsonb;
    v_before jsonb;
    v_time timestamptz;
begin
    if v_actor is null or not private.has_organization_role(p_organization_id, array['owner','admin']::text[]) then
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
        -- Replaying a successful start remains valid after a later profile change.
        return next v_row;
        return;
    end if;
    if v_row.version <> p_expected_version then
        raise exception 'Treatment version conflict' using errcode = 'P0001';
    end if;
    if p_action in ('consult', 'start') then
        if v_row.status <> 'draft' then
            raise exception 'Invalid treatment transition' using errcode = 'P0001';
        end if;
        -- Serialize profile updates with acknowledgment and start. The record lock above
        -- also serializes versions, audit insertion and operation-id replay.
        select jsonb_build_object('allergies', allergies, 'skin_type', skin_type, 'concerns', concerns)
            into v_cautions from public.customers
            where id = p_customer_id and organization_id = p_organization_id for update;
        if not found then
            raise exception 'Customer not found' using errcode = 'P0002';
        end if;
    end if;
    if p_action = 'start' then
        if v_row.consultation_goal !~ '[^[:space:]]'
           or v_row.cautions_acknowledged_by is null or v_row.cautions_acknowledged_at is null
           or v_row.cautions_snapshot <> v_cautions then
            raise exception 'Consultation goal and current caution acknowledgment are required' using errcode = 'P0001';
        end if;
    end if;
    if p_action <> 'consult' then
        return query select * from private.mutate_treatment_v16(p_organization_id, p_customer_id,
            p_treatment_id, p_expected_version, p_operation_id, p_action, p_reason, p_values);
        return;
    end if;
    if not (p_values ?& array['goal','plan','acknowledge_cautions','expected_cautions'])
       or (p_values - array['goal','plan','acknowledge_cautions','expected_cautions']) <> '{}'::jsonb
       or jsonb_typeof(p_values -> 'goal') <> 'string'
       or jsonb_typeof(p_values -> 'plan') <> 'string'
       or jsonb_typeof(p_values -> 'acknowledge_cautions') <> 'boolean'
       or length(p_values ->> 'goal') > 2000 or length(p_values ->> 'plan') > 5000 then
        raise exception 'Invalid consultation fields' using errcode = '22023';
    end if;
    v_expected := p_values -> 'expected_cautions';
    if jsonb_typeof(v_expected) <> 'object'
       or not (v_expected ?& array['allergies','skin_type','concerns'])
       or (v_expected - array['allergies','skin_type','concerns']) <> '{}'::jsonb
       or jsonb_typeof(v_expected -> 'allergies') <> 'string'
       or jsonb_typeof(v_expected -> 'skin_type') not in ('string','null')
       or jsonb_typeof(v_expected -> 'concerns') <> 'array' then
        raise exception 'Invalid expected cautions' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(v_expected -> 'concerns') as item(value)
        where jsonb_typeof(value) <> 'string') then
        raise exception 'Caution concerns must be strings' using errcode = '22023';
    end if;
    if (p_values ->> 'acknowledge_cautions')::boolean and v_expected <> v_cautions then
        raise exception 'Customer cautions changed; review current values' using errcode = 'P0001';
    end if;
    v_before := to_jsonb(v_row);
    v_time := clock_timestamp();
    update public.treatment_records set
        consultation_goal = p_values ->> 'goal', consultation_plan = p_values ->> 'plan',
        cautions_snapshot = case when (p_values ->> 'acknowledge_cautions')::boolean then v_cautions else '{}'::jsonb end,
        cautions_acknowledged_by = case when (p_values ->> 'acknowledge_cautions')::boolean then v_actor else null end,
        cautions_acknowledged_at = case when (p_values ->> 'acknowledge_cautions')::boolean then v_time else null end,
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

-- Rebind explicitly, including databases that already cached the former SQL function.
create or replace function public.mutate_treatment(
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
