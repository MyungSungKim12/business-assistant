-- INT-007: minimal durable relay + separately consented 30-day response inbox.
-- Requires 103. No existing customer/activity/task rows are rewritten.
begin;
create table if not exists public.phone_inbox_channels (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 id uuid not null default gen_random_uuid() unique,
 consent_enabled boolean not null default false, consent_version integer not null default 0, last_sequence bigint not null default 0,
 consent_updated_at timestamptz, consent_operation_id uuid, consent_request jsonb,
 primary key(organization_id,user_id)
);
create table if not exists public.phone_call_events (
 sequence bigint generated always as identity primary key, id uuid not null,
 organization_id uuid not null references public.organizations(id) on delete cascade,
 recipient_id uuid not null references auth.users(id) on delete cascade,
 phone_e164 text not null, occurred_at timestamptz not null, received_at timestamptz not null default now(),
 expires_at timestamptz not null, customer_ids uuid[] not null,
 retained boolean not null default false, retained_until timestamptz,
 status text not null default 'unconfirmed' check(status in ('unconfirmed','seen','completed','callback_needed')),
 assignee_id uuid references auth.users(id) on delete set null,
 version integer not null default 1, callback_task_id uuid references public.tasks(id) on delete set null,
 unique(organization_id,recipient_id,id), check(cardinality(customer_ids) between 1 and 100)
);
create index if not exists phone_calls_recipient on public.phone_call_events(organization_id,recipient_id,sequence desc);
create index if not exists phone_calls_assignee on public.phone_call_events(organization_id,assignee_id,sequence desc) where assignee_id is not null;
create index if not exists phone_calls_expiry on public.phone_call_events(expires_at) where not retained;
create index if not exists phone_calls_retention on public.phone_call_events(retained_until) where retained;
create table if not exists public.phone_inbox_operations (
 sequence bigint not null references public.phone_call_events(sequence) on delete cascade,
 actor_id uuid not null references auth.users(id) on delete cascade, operation_id uuid not null,
 request jsonb not null, result jsonb not null, primary key(sequence,actor_id,operation_id)
);
alter table public.phone_inbox_channels enable row level security;
alter table public.phone_call_events enable row level security;
alter table public.phone_inbox_operations enable row level security;
-- Only checked RPCs expose these tables, including raw numbers. No direct REST access.
revoke all on public.phone_inbox_channels,public.phone_call_events,public.phone_inbox_operations from public,anon,authenticated;
revoke all on sequence public.phone_call_events_sequence_seq from public,anon,authenticated;

create or replace function private.call_phone(p text) returns text language plpgsql immutable set search_path='' as $$
declare d text;
begin
 if p is null or length(p)>40 or btrim(p)='' or p ~ '[a-zA-Z가-힣]' then return null;end if;
 d:=regexp_replace(p,'[^0-9]','','g');
 if d like '0082%' then d:='82'||substr(d,5);elsif d like '00%' and btrim(p) not like '+%' then d:=substr(d,3);end if;
 if d like '82%' then d:='0'||substr(d,3);end if;
 if d like '0%' then
  if length(d) not between 8 and 11 or d ~ '^0+$' or d ~ '^0(10|11|16|17|18|19)0{4,}' then return null;end if;
  return '+82'||substr(d,2);
 end if;
 if btrim(p) not like '+%' or length(d) not between 8 and 15 or d ~ '^0+$' then return null;end if;
 return '+'||d;
end $$;
revoke all on function private.call_phone(text) from public,anon,authenticated;
-- INSERT/UPDATE index maintenance runs as the customer writer. This pure function
-- reads no tables and must remain executable by authenticated customer writers.
grant execute on function private.call_phone(text) to authenticated;
create index if not exists customers_call_phone_lookup on public.customers(organization_id,private.call_phone(phone)) where status in ('active','vip');

create or replace function public.phone_inbox(p_org uuid,p_action text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 actor uuid:=auth.uid(); channel public.phone_inbox_channels; row public.phone_call_events;
 op public.phone_inbox_operations; result jsonb; allowed text[]; normalized text; ids uuid[];
 stamp timestamptz:=clock_timestamp(); occurred timestamptz; retained boolean; duplicate boolean:=false;
 after_sequence bigint:=0; last_sequence bigint; page_limit integer; cursor_value text; scope_id uuid;
 chosen uuid; assignee uuid; task_id uuid; v_status text; memo text; due timestamptz; event_id uuid;
begin
 if actor is null or p_org is null or not private.has_organization_role(p_org,array['owner','admin','member']::text[])
 or not exists(select 1 from public.subscriptions s join public.plan_features f on f.plan_id=s.plan_id
  where s.organization_id=p_org and s.status in ('active','trialing') and (s.ends_at is null or s.ends_at>stamp) and f.feature_code='crm.basic') then
  raise exception 'Phone access denied' using errcode='42501';end if;
 allowed:=case p_action when 'consent' then array[]::text[] when 'set-consent' then array['enabled','expected_version','operation_id']
 when 'publish' then array['event_id','number','occurred_at','retention_consent_version']
 when 'poll' then array['after','limit'] when 'list' then array['after','limit','status','customer_id','from','to']
 when 'update' then array['id','recipient_id','expected_version','operation_id','status','memo','customer_id','assignee_id','callback_due_at']
 when 'record' then array['id','recipient_id'] when 'ack' then array['id'] end;
 if allowed is null or jsonb_typeof(p_input) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_input) k where not(k=any(allowed))) then
  raise exception 'Invalid phone input' using errcode='22023';end if;
 -- Serializes same-recipient publish, consent and cursor reads across every API process.
 perform pg_advisory_xact_lock(hashtextextended(p_org::text||':'||actor::text,104));
 insert into public.phone_inbox_channels(organization_id,user_id) values(p_org,actor) on conflict do nothing;
 select * into channel from public.phone_inbox_channels where organization_id=p_org and user_id=actor for update;
 if p_action in ('consent','set-consent') then
  if p_action='set-consent' then
   if jsonb_typeof(p_input->'enabled') is distinct from 'boolean' or (p_input->>'operation_id')::uuid is null or (p_input->>'expected_version')::integer is null then raise exception 'Invalid consent' using errcode='22023';end if;
   if channel.consent_operation_id=(p_input->>'operation_id')::uuid then
    if channel.consent_request is distinct from p_input then raise exception 'Operation conflict' using errcode='23505';end if;
   else
    if channel.consent_version<>(p_input->>'expected_version')::integer then raise exception 'Consent version conflict' using errcode='40001';end if;
    update public.phone_inbox_channels set consent_enabled=(p_input->>'enabled')::boolean,consent_version=consent_version+1,
     consent_updated_at=stamp,consent_operation_id=(p_input->>'operation_id')::uuid,consent_request=p_input
     where organization_id=p_org and user_id=actor returning * into channel;
   end if;
  end if;
  return jsonb_build_object('enabled',channel.consent_enabled,'version',channel.consent_version,'retention_days',30);
 elsif p_action='publish' then
  event_id:=(p_input->>'event_id')::uuid;normalized:=private.call_phone(p_input->>'number');occurred:=(p_input->>'occurred_at')::timestamptz;
  if event_id is null or normalized is null or occurred is null or not isfinite(occurred) then raise exception 'Invalid call' using errcode='22023';end if;
  select * into row from public.phone_call_events where organization_id=p_org and recipient_id=actor and id=event_id for update;
  if found then
   if row.phone_e164<>normalized or row.occurred_at<>occurred then raise exception 'Event conflict' using errcode='23505';end if;
   -- Keep the event-ID conflict check above, but never reveal logically expired
   -- facts/matches while the internal cleanup has not physically removed them.
   -- Identical expired retries are not found (HTTP 404), without inserting a row
   -- or extending either retention deadline.
   if (row.retained and (row.retained_until is null or row.retained_until<=stamp)) or (not row.retained and row.expires_at<=stamp) then
    raise exception 'Call expired' using errcode='P0002';end if;
   duplicate:=true;
  else
   if occurred<stamp-interval '2 minutes' or occurred>stamp+interval '30 seconds' then raise exception 'Expired call' using errcode='22023';end if;
   select array_agg(c.id order by c.id) into ids from (select c.id from public.customers c where c.organization_id=p_org and c.status in ('active','vip') and private.call_phone(c.phone)=normalized order by c.id limit 101)c;
   if ids is null then raise exception 'No customer match' using errcode='P0002';end if;
   if cardinality(ids)>100 then raise exception 'Too many customer matches' using errcode='22023';end if;
   retained:=channel.consent_enabled and channel.consent_version=(p_input->>'retention_consent_version')::integer;
   insert into public.phone_call_events(id,organization_id,recipient_id,phone_e164,occurred_at,expires_at,customer_ids,retained,retained_until)
   values(event_id,p_org,actor,normalized,occurred,least(stamp+interval '2 minutes',occurred+interval '2 minutes'),ids,coalesce(retained,false),case when retained then occurred+interval '30 days' end) returning * into row;
   update public.phone_inbox_channels set last_sequence=row.sequence where organization_id=p_org and user_id=actor;
  end if;
  return jsonb_build_object('duplicate',duplicate,'retained',row.retained,'event',jsonb_build_object('id',row.id,'phone_e164',row.phone_e164,'occurred_at',row.occurred_at,'received_at',row.received_at,'expires_at',row.expires_at,'matches',
   coalesce((select jsonb_agg(jsonb_build_object('customer_id',c.id,'name',c.name,'phone',row.phone_e164,'phone_e164',row.phone_e164) order by c.id) from public.customers c where c.organization_id=p_org and c.id=any(row.customer_ids)),'[]'::jsonb)));
 elsif p_action in ('poll','list') then
  cursor_value:=coalesce(p_input->>'after','');page_limit:=coalesce((p_input->>'limit')::integer,case when p_action='poll' then 100 else 30 end);
  if page_limit<1 or page_limit>100 or length(cursor_value)>100 then raise exception 'Invalid limit/cursor' using errcode='22023';end if;
  if cursor_value<>'' then
   if cursor_value ~ '^v1:[0-9a-f-]{36}:[0-9]{1,18}$' then
    scope_id:=split_part(cursor_value,':',2)::uuid;after_sequence:=split_part(cursor_value,':',3)::bigint;
    if scope_id<>channel.id then raise exception 'Cursor scope mismatch' using errcode='22023';end if;
   elsif cursor_value ~ '^[a-zA-Z0-9-]{1,50}:[0-9]{1,18}$' and p_action='poll' then after_sequence:=0;
   else raise exception 'Invalid cursor' using errcode='22023';end if;
  end if;
  if p_action='poll' then
   if after_sequence>channel.last_sequence then raise exception 'Future cursor' using errcode='22023';end if;
   with page as materialized(select e.* from public.phone_call_events e where e.organization_id=p_org and e.recipient_id=actor and e.sequence>after_sequence and e.expires_at>stamp and (not e.retained or e.retained_until>stamp) order by e.sequence limit page_limit)
   select jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object('id',p.id,'phone_e164',p.phone_e164,'occurred_at',p.occurred_at,'received_at',p.received_at,'expires_at',p.expires_at,'matches',
     coalesce((select jsonb_agg(jsonb_build_object('customer_id',c.id,'name',c.name,'phone',p.phone_e164,'phone_e164',p.phone_e164) order by c.id) from public.customers c where c.organization_id=p_org and c.id=any(p.customer_ids)),'[]'::jsonb)) order by p.sequence),'[]'::jsonb),'last',max(p.sequence)) into result from page p;
   last_sequence:=coalesce((result->>'last')::bigint,channel.last_sequence);
   return (result-'last')||jsonb_build_object('cursor','v1:'||channel.id||':'||last_sequence);
  else
   if p_input ? 'status' and p_input->>'status' not in ('unconfirmed','seen','completed','callback_needed') then raise exception 'Invalid status' using errcode='22023';end if;
   with page as materialized(select e.* from public.phone_call_events e where e.organization_id=p_org and (e.recipient_id=actor or e.assignee_id=actor) and e.retained and e.retained_until>stamp
    and (after_sequence=0 or e.sequence<after_sequence) and (not(p_input ? 'status') or e.status=p_input->>'status')
    and (not(p_input ? 'customer_id') or (p_input->>'customer_id')::uuid=any(e.customer_ids))
    and (not(p_input ? 'from') or e.occurred_at>=(p_input->>'from')::timestamptz) and (not(p_input ? 'to') or e.occurred_at<(p_input->>'to')::timestamptz)
    order by e.sequence desc limit page_limit)
   select jsonb_build_object('items',coalesce(jsonb_agg(to_jsonb(p)-'sequence' order by p.sequence desc),'[]'::jsonb),'last',min(p.sequence)) into result from page p;
   return (result-'last')||jsonb_build_object('cursor','v1:'||channel.id||':'||coalesce(result->>'last','0'),'next_cursor',case when jsonb_array_length(result->'items')=page_limit then 'v1:'||channel.id||':'||(result->>'last') end);
  end if;
 elsif p_action='ack' then
  update public.phone_call_events e set status='seen',version=version+1 where e.organization_id=p_org and e.recipient_id=actor and e.id=(p_input->>'id')::uuid and e.retained and e.retained_until>stamp and e.status='unconfirmed';
  return jsonb_build_object('acknowledged',true);
 elsif p_action in ('update','record') then
  select * into row from public.phone_call_events e where e.organization_id=p_org and e.id=(p_input->>'id')::uuid
   and e.recipient_id=coalesce((p_input->>'recipient_id')::uuid,actor)
   and (e.recipient_id=actor or e.assignee_id=actor) and e.retained and e.retained_until>stamp for update;
  if not found then
   if p_action='record' then raise exception 'Call not found' using errcode='P0002';end if;
   raise exception 'Call access denied' using errcode='42501';end if;
  if p_action='record' then return to_jsonb(row)-'sequence';end if;
  if (p_input->>'operation_id')::uuid is null or (p_input->>'expected_version')::integer is null then raise exception 'Invalid operation' using errcode='22023';end if;
  select * into op from public.phone_inbox_operations where sequence=row.sequence and actor_id=actor and operation_id=(p_input->>'operation_id')::uuid;
  if found then
   if op.request is distinct from to_jsonb(encode(sha256(convert_to(p_input::text,'UTF8')),'hex')) then raise exception 'Operation conflict' using errcode='23505';end if;
   return op.result;
  end if;
  if row.version<>(p_input->>'expected_version')::integer then raise exception 'Call version conflict' using errcode='40001';end if;
  v_status:=coalesce(p_input->>'status',row.status);memo:=btrim(coalesce(p_input->>'memo',''));chosen:=(p_input->>'customer_id')::uuid;
  if v_status not in ('unconfirmed','seen','completed','callback_needed') or length(memo)>10000 then raise exception 'Invalid response' using errcode='22023';end if;
  assignee:=case when p_input ? 'assignee_id' then (p_input->>'assignee_id')::uuid else row.assignee_id end;
  if assignee is not null and not exists(select 1 from public.memberships m where m.organization_id=p_org and m.user_id=assignee and m.role in ('owner','admin','member')) then raise exception 'Invalid assignee' using errcode='22023';end if;
  due:=(p_input->>'callback_due_at')::timestamptz;
  if memo<>'' or due is not null then
   if chosen is null or not(chosen=any(row.customer_ids)) or not exists(select 1 from public.customers c where c.organization_id=p_org and c.id=chosen and c.status in ('active','vip')) then raise exception 'Invalid saved customer match' using errcode='22023';end if;
  end if;
  if due is not null and (not isfinite(due) or due<=stamp or due>stamp+interval '365 days') then raise exception 'Invalid callback due date' using errcode='22023';end if;
  if due is not null and not exists(select 1 from public.subscriptions s join public.plan_features f on f.plan_id=s.plan_id
   where s.organization_id=p_org and s.status in ('active','trialing') and (s.ends_at is null or s.ends_at>stamp) and f.feature_code='task.basic') then raise exception 'Task access denied' using errcode='42501';end if;
  if memo<>'' then insert into public.customer_activities(organization_id,customer_id,created_by,activity_type,title,description,occurred_at) values(p_org,chosen,actor,'phone_call','전화 응대 메모',memo,row.occurred_at);end if;
  task_id:=row.callback_task_id;
  if due is not null and task_id is null then
   insert into public.tasks(organization_id,created_by,title,description,due_at,customer_id,assignee_id) values(p_org,actor,'고객 콜백','전화 수신함에서 요청한 콜백',due,chosen,assignee) returning id into task_id;
  end if;
  update public.phone_call_events set status=v_status,assignee_id=assignee,callback_task_id=task_id,version=version+1 where sequence=row.sequence returning * into row;
  result:=to_jsonb(row)-'sequence';
  insert into public.phone_inbox_operations(sequence,actor_id,operation_id,request,result) values(row.sequence,actor,(p_input->>'operation_id')::uuid,to_jsonb(encode(sha256(convert_to(p_input::text,'UTF8')),'hex')),result);
  return result;
 end if;
 raise exception 'Invalid action' using errcode='22023';
end $$;
revoke all on function public.phone_inbox(uuid,text,jsonb) from public,anon;
grant execute on function public.phone_inbox(uuid,text,jsonb) to authenticated;

-- Internal bounded cleanup, never callable through authenticated/anon REST. No business ledger deletion.
create or replace function private.cleanup_phone_inbox(p_limit integer default 500) returns integer language plpgsql security definer set search_path='' as $$
declare removed integer;
begin
 if p_limit is null or p_limit<1 or p_limit>5000 then raise exception 'Invalid cleanup limit' using errcode='22023';end if;
 with doomed as(select sequence from public.phone_call_events where (not retained and expires_at<=now()) or (retained and retained_until<=now()) order by sequence limit p_limit for update skip locked),
 deleted as(delete from public.phone_call_events e using doomed d where e.sequence=d.sequence returning e.sequence)
 select count(*) into removed from deleted;return removed;
end $$;
revoke all on function private.cleanup_phone_inbox(integer) from public,anon,authenticated;
comment on function public.phone_inbox(uuid,text,jsonb) is 'INT-007: own/explicit-assignee inbox. Legacy publish retains 2 minutes only; versioned optional consent retains 30 days. Withdrawal blocks future retention; existing records expire on original date. TTL never means missed/completed. Old in-memory poll cursor resets, v1 foreign scope rejected.';
commit;
