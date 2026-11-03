-- 109: scoped templates and outbox for MKT P0. No provider success is recorded here.
begin;

create table if not exists public.organization_message_templates (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 name text not null check (length(btrim(name)) between 1 and 120),
 channel text not null check (channel in ('sms','kakao')),
 purpose text not null check (purpose in ('transactional','marketing')),
 body text not null check (length(body) between 1 and 4000),
 version integer not null default 1 check (version > 0),
 is_active boolean not null default true,
 created_by uuid not null,
 updated_by uuid not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (organization_id,id)
);

create table if not exists public.organization_message_outbox (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 template_id uuid not null,
 customer_id uuid not null,
 operation_id uuid not null,
 channel text not null check (channel in ('sms','kakao')),
 purpose text not null check (purpose in ('transactional','marketing')),
 template_name text not null,
 template_version integer not null check (template_version > 0),
 body_snapshot text not null check (length(body_snapshot) between 1 and 4000),
 scheduled_at timestamptz not null default now(),
 status text not null default 'queued' check (status in ('queued','processing','delivered','failed','cancelled')),
 attempt_count integer not null default 0 check (attempt_count between 0 and 3),
 failure_code text check (failure_code is null or failure_code in ('provider_timeout','provider_rejected','temporary_unavailable')),
 retry_operation_id uuid,
 last_attempt_at timestamptz,
 created_by uuid not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 foreign key (organization_id,template_id) references public.organization_message_templates(organization_id,id),
 foreign key (customer_id) references public.customers(id) on delete cascade,
 unique (organization_id,operation_id,customer_id)
);
create table if not exists public.organization_message_enqueue_operations (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 operation_id uuid not null,
 template_id uuid not null,
 customer_ids uuid[] not null check (cardinality(customer_ids) between 1 and 200),
 scheduled_at timestamptz not null,
 created_by uuid not null,
 created_at timestamptz not null default now(),
 primary key (organization_id,operation_id),
 foreign key (organization_id,template_id) references public.organization_message_templates(organization_id,id)
);
create index if not exists organization_message_outbox_org_created_idx on public.organization_message_outbox(organization_id,created_at desc,id desc);
create index if not exists organization_message_outbox_due_idx on public.organization_message_outbox(scheduled_at,id) where status='queued';
alter table public.organization_message_templates enable row level security;
alter table public.organization_message_outbox enable row level security;
alter table public.organization_message_enqueue_operations enable row level security;
revoke all on public.organization_message_templates,public.organization_message_outbox,public.organization_message_enqueue_operations from public,anon,authenticated,service_role;

create or replace function public.save_organization_message_template(p_organization_id uuid,p_template_id uuid,p_name text,p_channel text,p_purpose text,p_body text,p_expected_version integer)
returns jsonb language plpgsql volatile security definer set search_path=''
as $$
declare caller uuid := (select auth.uid()); row_value public.organization_message_templates%rowtype;
begin
 if caller is null or p_organization_id is null or p_name is null or length(btrim(p_name)) not between 1 and 120 or p_channel not in ('sms','kakao') or p_purpose not in ('transactional','marketing') or p_body is null or length(p_body) not between 1 and 4000 or exists(select 1 from regexp_matches(p_body,'#\{([^}]+)\}','g') as m where m[1] not in ('customer_name','appointment_date','appointment_time','service_name')) then
  raise exception 'invalid_template' using errcode='22023';
 end if;
 if not exists(select 1 from public.memberships m where m.organization_id=p_organization_id and m.user_id=caller and m.role in ('owner','admin')) then raise exception 'forbidden' using errcode='42501'; end if;
 if p_template_id is null then
  if p_expected_version is not null then raise exception 'invalid_template' using errcode='22023'; end if;
  insert into public.organization_message_templates(organization_id,name,channel,purpose,body,created_by,updated_by)
  values(p_organization_id,btrim(p_name),p_channel,p_purpose,p_body,caller,caller) returning * into row_value;
 else
  update public.organization_message_templates set name=btrim(p_name),channel=p_channel,purpose=p_purpose,body=p_body,version=version+1,updated_by=caller,updated_at=now()
  where organization_id=p_organization_id and id=p_template_id and is_active and version=p_expected_version returning * into row_value;
  if not found then raise exception 'template_conflict' using errcode='P0001'; end if;
 end if;
 insert into public.audit_events(organization_id,actor_id,action,target_type,target_id,metadata,source)
 values(p_organization_id,caller,'marketing.template_save','message_template',row_value.id::text,jsonb_build_object('version',row_value.version,'channel',row_value.channel,'purpose',row_value.purpose),'api_user');
 return jsonb_build_object('template',to_jsonb(row_value));
end;
$$;

create or replace function public.preview_organization_message_audience(p_organization_id uuid,p_template_id uuid,p_customer_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare caller uuid := (select auth.uid()); tmpl public.organization_message_templates%rowtype; eligible jsonb; excluded jsonb;
begin
 if caller is null or p_organization_id is null or p_customer_ids is null or cardinality(p_customer_ids)>200 then raise exception 'invalid_audience' using errcode='22023'; end if;
 if not exists(select 1 from public.memberships m where m.organization_id=p_organization_id and m.user_id=caller) then raise exception 'forbidden' using errcode='42501'; end if;
 select * into tmpl from public.organization_message_templates where organization_id=p_organization_id and id=p_template_id and is_active;
 if not found then raise exception 'template_not_found' using errcode='P0002'; end if;
 with requested as (select distinct unnest(p_customer_ids) as id), candidates as (
  select r.id,c.name,c.phone,c.status,c.marketing_consent from requested r left join public.customers c on c.id=r.id and c.organization_id=p_organization_id
 ), classified as (
  select id,name,phone,case when name is null then 'customer_not_found' when status not in ('active','vip') then 'customer_inactive' when nullif(btrim(phone),'') is null then 'phone_missing' when tmpl.purpose='marketing' and not coalesce(marketing_consent,false) then 'marketing_consent_required' else null end as reason from candidates
 )
 select coalesce(jsonb_agg(jsonb_build_object('customer_id',id,'name',name,'phone_masked',left(phone,3)||'****'||right(phone,4)) order by name,id) filter(where reason is null),'[]'::jsonb),
 coalesce(jsonb_agg(jsonb_build_object('customer_id',id,'name',name,'reason',reason) order by id) filter(where reason is not null),'[]'::jsonb)
 into eligible,excluded from classified;
 return jsonb_build_object('eligible',eligible,'excluded',excluded,'template_version',tmpl.version,'provider_ready',false);
end;
$$;

create or replace function public.enqueue_organization_messages(p_organization_id uuid,p_template_id uuid,p_customer_ids uuid[],p_scheduled_at timestamptz,p_operation_id uuid)
returns jsonb language plpgsql volatile security definer set search_path=''
as $$
declare caller uuid := (select auth.uid()); tmpl public.organization_message_templates%rowtype; op public.organization_message_enqueue_operations%rowtype; created_count integer; excluded jsonb; messages jsonb;
begin
 if caller is null or p_organization_id is null or p_customer_ids is null or cardinality(p_customer_ids)=0 or cardinality(p_customer_ids)>200 or p_operation_id is null then raise exception 'invalid_enqueue' using errcode='22023'; end if;
 if not exists(select 1 from public.memberships m where m.organization_id=p_organization_id and m.user_id=caller and m.role in ('owner','admin')) then raise exception 'forbidden' using errcode='42501'; end if;
 select * into tmpl from public.organization_message_templates where organization_id=p_organization_id and id=p_template_id and is_active;
 if not found then raise exception 'template_not_found' using errcode='P0002'; end if;
 if p_scheduled_at is not null and (p_scheduled_at < now()-interval '1 minute' or p_scheduled_at > now()+interval '366 days') then raise exception 'invalid_enqueue' using errcode='22023'; end if;
 select * into op from public.organization_message_enqueue_operations where organization_id=p_organization_id and operation_id=p_operation_id for update;
 if found then
  if op.template_id<>p_template_id or (p_scheduled_at is not null and op.scheduled_at<>p_scheduled_at) or op.customer_ids is distinct from (select array_agg(distinct x order by x) from unnest(p_customer_ids) x) then raise exception 'idempotency_conflict' using errcode='P0001'; end if;
 else
  insert into public.organization_message_enqueue_operations(organization_id,operation_id,template_id,customer_ids,scheduled_at,created_by)
  values(p_organization_id,p_operation_id,p_template_id,(select array_agg(distinct x order by x) from unnest(p_customer_ids) x),coalesce(p_scheduled_at,now()),caller) returning * into op;
 end if;
 with requested as (select distinct unnest(p_customer_ids) as id), candidates as (
  select r.id,c.name,c.phone,c.status,c.marketing_consent from requested r left join public.customers c on c.id=r.id and c.organization_id=p_organization_id
 ), classified as (
  select id,name,phone,case when name is null then 'customer_not_found' when status not in ('active','vip') then 'customer_inactive' when nullif(btrim(phone),'') is null then 'phone_missing' when tmpl.purpose='marketing' and not coalesce(marketing_consent,false) then 'marketing_consent_required' else null end as reason from candidates
 )
 select coalesce(jsonb_agg(jsonb_build_object('customer_id',id,'name',name,'reason',reason) order by id) filter(where reason is not null),'[]'::jsonb) into excluded from classified;
 insert into public.organization_message_outbox(organization_id,template_id,customer_id,operation_id,channel,purpose,template_name,template_version,body_snapshot,scheduled_at,status,created_by)
 select p_organization_id,tmpl.id,c.id,p_operation_id,tmpl.channel,tmpl.purpose,tmpl.name,tmpl.version,tmpl.body,op.scheduled_at,'queued',caller
 from public.customers c where c.organization_id=p_organization_id and c.id=any(p_customer_ids) and c.status in ('active','vip') and nullif(btrim(c.phone),'') is not null and (tmpl.purpose<>'marketing' or c.marketing_consent)
 on conflict(organization_id,operation_id,customer_id) do nothing;
 get diagnostics created_count = row_count;
 if created_count>0 then insert into public.audit_events(organization_id,actor_id,action,target_type,target_id,metadata,source)
  values(p_organization_id,caller,'marketing.message_enqueue','message_operation',p_operation_id::text,jsonb_build_object('created_count',created_count,'excluded_count',jsonb_array_length(excluded)),'api_user'); end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'customer_id',o.customer_id,'status',o.status,'scheduled_at',o.scheduled_at,'attempt_count',o.attempt_count) order by o.created_at,o.id),'[]'::jsonb) into messages
 from public.organization_message_outbox o where o.organization_id=p_organization_id and o.operation_id=p_operation_id;
 return jsonb_build_object('created',created_count,'excluded',excluded,'messages',messages,'provider_ready',false);
end;
$$;

create or replace function public.cancel_organization_message(p_organization_id uuid,p_message_id uuid,p_expected_version integer)
returns jsonb language plpgsql volatile security definer set search_path=''
as $$
declare caller uuid := (select auth.uid()); changed integer;
begin
 if caller is null or not exists(select 1 from public.memberships m where m.organization_id=p_organization_id and m.user_id=caller and m.role in ('owner','admin')) then raise exception 'forbidden' using errcode='42501'; end if;
 update public.organization_message_outbox set status='cancelled',updated_at=now()
 where organization_id=p_organization_id and id=p_message_id and status in ('queued','failed') and attempt_count=p_expected_version;
 get diagnostics changed = row_count;
 if changed=1 then
  insert into public.audit_events(organization_id,actor_id,action,target_type,target_id,metadata,source) values(p_organization_id,caller,'marketing.message_cancel','message',p_message_id::text,'{}'::jsonb,'api_user');
 end if;
 if changed=0 and not exists(select 1 from public.organization_message_outbox where organization_id=p_organization_id and id=p_message_id) then raise exception 'message_not_found' using errcode='P0002'; end if;
 if changed=0 and exists(select 1 from public.organization_message_outbox where organization_id=p_organization_id and id=p_message_id and status='cancelled' and attempt_count=p_expected_version) then return jsonb_build_object('cancelled',true,'id',p_message_id); end if;
 if changed=0 then raise exception 'message_conflict' using errcode='P0001'; end if;
 return jsonb_build_object('cancelled',true,'id',p_message_id);
end;
$$;

create or replace function public.retry_organization_message(p_organization_id uuid,p_message_id uuid,p_expected_attempt_count integer,p_operation_id uuid)
returns jsonb language plpgsql volatile security definer set search_path=''
as $$
declare caller uuid := (select auth.uid()); row_value public.organization_message_outbox%rowtype;
begin
 if caller is null or p_operation_id is null or not exists(select 1 from public.memberships m where m.organization_id=p_organization_id and m.user_id=caller and m.role in ('owner','admin')) then raise exception 'forbidden' using errcode='42501'; end if;
 select * into row_value from public.organization_message_outbox where organization_id=p_organization_id and id=p_message_id for update;
 if not found then raise exception 'message_not_found' using errcode='P0002'; end if;
 if row_value.status='queued' and row_value.retry_operation_id=p_operation_id then return jsonb_build_object('id',row_value.id,'status',row_value.status,'attempt_count',row_value.attempt_count,'provider_ready',false); end if;
 if row_value.status<>'failed' or row_value.attempt_count<>p_expected_attempt_count or row_value.attempt_count>=3 then raise exception 'message_conflict' using errcode='P0001'; end if;
 if row_value.purpose='marketing' and not exists(select 1 from public.customers c where c.organization_id=p_organization_id and c.id=row_value.customer_id and c.status in ('active','vip') and c.marketing_consent and nullif(btrim(c.phone),'') is not null) then raise exception 'consent_required' using errcode='42501'; end if;
 update public.organization_message_outbox set status='queued',retry_operation_id=p_operation_id,failure_code=null,updated_at=now() where id=p_message_id returning * into row_value;
 return jsonb_build_object('id',row_value.id,'status',row_value.status,'attempt_count',row_value.attempt_count,'provider_ready',false);
end;
$$;

create or replace function public.get_organization_message_workspace(p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare caller uuid := (select auth.uid()); templates jsonb; messages jsonb;
begin
 if caller is null or not exists(select 1 from public.memberships m where m.organization_id=p_organization_id and m.user_id=caller) then raise exception 'forbidden' using errcode='42501'; end if;
 select coalesce(jsonb_agg(to_jsonb(t) order by t.updated_at desc,t.id),'[]'::jsonb) into templates from public.organization_message_templates t where t.organization_id=p_organization_id and t.is_active;
 select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'organization_id',o.organization_id,'template_id',o.template_id,'customer_id',o.customer_id,'operation_id',o.operation_id,'channel',o.channel,'purpose',o.purpose,'template_name',o.template_name,'template_version',o.template_version,'scheduled_at',o.scheduled_at,'status',o.status,'attempt_count',o.attempt_count,'failure_code',o.failure_code,'created_at',o.created_at) order by o.created_at desc,o.id desc),'[]'::jsonb) into messages from (select * from public.organization_message_outbox where organization_id=p_organization_id order by created_at desc,id desc limit 200) o;
 return jsonb_build_object('organization_id',p_organization_id,'templates',templates,'messages',messages,'provider_ready',false);
end;
$$;

revoke all on function public.get_organization_message_workspace(uuid) from public,anon;
revoke all on function public.save_organization_message_template(uuid,uuid,text,text,text,text,integer) from public,anon;
revoke all on function public.preview_organization_message_audience(uuid,uuid,uuid[]) from public,anon;
revoke all on function public.enqueue_organization_messages(uuid,uuid,uuid[],timestamptz,uuid) from public,anon;
revoke all on function public.cancel_organization_message(uuid,uuid,integer) from public,anon;
revoke all on function public.retry_organization_message(uuid,uuid,integer,uuid) from public,anon;
revoke all on function public.get_organization_message_workspace(uuid) from public,anon;
grant execute on function public.save_organization_message_template(uuid,uuid,text,text,text,text,integer) to authenticated;
grant execute on function public.preview_organization_message_audience(uuid,uuid,uuid[]) to authenticated;
grant execute on function public.enqueue_organization_messages(uuid,uuid,uuid[],timestamptz,uuid) to authenticated;
grant execute on function public.cancel_organization_message(uuid,uuid,integer) to authenticated;
grant execute on function public.retry_organization_message(uuid,uuid,integer,uuid) to authenticated;
grant execute on function public.get_organization_message_workspace(uuid) to authenticated;

commit;
