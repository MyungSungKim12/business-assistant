-- INT-006 / N1030-05. Requires 103 session-aware membership and 104 private.call_phone.
-- Run as one migration transaction. Existing APK's directory route remains unchanged.
lock table public.customers in share row exclusive mode;
create table if not exists public.phone_directory_state (
 organization_id uuid primary key references public.organizations(id) on delete cascade,
 revision bigint not null default 0 check(revision>=0), min_revision bigint not null default 0 check(min_revision>=0 and min_revision<=revision),
 secret bytea not null default sha256(convert_to(gen_random_uuid()::text||gen_random_uuid()::text,'UTF8'))
);
create table if not exists public.phone_directory_live (
 organization_id uuid not null references public.organizations(id) on delete cascade, customer_id uuid not null,
 revision bigint not null, name text not null, phone text not null, phone_e164 text not null,
 primary key(organization_id,customer_id)
);
create table if not exists public.phone_directory_changes (
 organization_id uuid not null references public.organizations(id) on delete cascade, revision bigint not null,
 customer_id uuid not null, operation text not null check(operation in ('upsert','delete')),
 name text,phone text,phone_e164 text, primary key(organization_id,revision)
);
alter table public.phone_directory_state enable row level security;
alter table public.phone_directory_live enable row level security;
alter table public.phone_directory_changes enable row level security;
revoke all on public.phone_directory_state,public.phone_directory_live,public.phone_directory_changes from public,anon,authenticated;

-- RFC2104 HMAC-SHA256 using core sha256 (no pgcrypto/extension schema dependency).
create or replace function private.phone_directory_mac(payload text,secret bytea) returns text
language plpgsql immutable set search_path='' as $$
declare ipad bytea:=decode(repeat('36',64),'hex');opad bytea:=decode(repeat('5c',64),'hex');i integer;
begin
 if octet_length(secret)<>32 then raise exception 'Invalid MAC key';end if;
 for i in 0..31 loop ipad:=set_byte(ipad,i,get_byte(ipad,i)#get_byte(secret,i));opad:=set_byte(opad,i,get_byte(opad,i)#get_byte(secret,i));end loop;
 return encode(sha256(opad||sha256(ipad||convert_to(payload,'UTF8'))),'hex');
end $$;
revoke all on function private.phone_directory_mac(text,bytea) from public,anon,authenticated;
create or replace function private.phone_directory_cursor(o uuid,m text,u bigint,b text,k bytea) returns text
language sql immutable set search_path='' as $$
 select 'd1:'||o||':'||m||':'||u||':'||b||':'||private.phone_directory_mac('d1:'||o||':'||m||':'||u||':'||b,k)
$$;
revoke all on function private.phone_directory_cursor(uuid,text,bigint,text,bytea) from public,anon,authenticated;

create or replace function private.track_phone_directory() returns trigger language plpgsql security definer set search_path='' as $$
declare old_org uuid;new_org uuid;o uuid;r bigint;is_live boolean;
begin
 if TG_OP<>'INSERT' then old_org:=old.organization_id;end if;
 if TG_OP<>'DELETE' then new_org:=new.organization_id;end if;
 -- Parent organization deletion cascades through customers after the parent is
 -- no longer visible in this transaction. Its directory rows also cascade;
 -- recreating state/tombstones here would violate the organization FK.
 if TG_OP='DELETE' and not exists(select 1 from public.organizations where id=old_org) then return null;end if;
 if TG_OP='UPDATE' and (old.organization_id,old.id,old.name,old.phone,old.status) is not distinct from (new.organization_id,new.id,new.name,new.phone,new.status) then return null;end if;
 -- Row locks live through COMMIT, so a later committed directory revision can
 -- never overtake an earlier uncommitted one. No global sequence or org-global lock.
 for o in select distinct x from unnest(array[old_org,new_org]) x where x is not null order by x loop
  insert into public.phone_directory_state(organization_id) values(o) on conflict do nothing;
  perform 1 from public.phone_directory_state where organization_id=o for update;
 end loop;
 if old_org is not null and (TG_OP='DELETE' or old_org<>new_org or old.id<>new.id) then
  update public.phone_directory_state set revision=revision+1 where organization_id=old_org returning revision into r;
  delete from public.phone_directory_live where organization_id=old_org and customer_id=old.id;
  insert into public.phone_directory_changes(organization_id,revision,customer_id,operation) values(old_org,r,old.id,'delete');
 end if;
 if new_org is not null then
  update public.phone_directory_state set revision=revision+1 where organization_id=new_org returning revision into r;
  is_live:=new.status in ('active','vip') and private.call_phone(new.phone) is not null;
  if is_live then
   insert into public.phone_directory_live values(new_org,new.id,r,new.name,new.phone,private.call_phone(new.phone))
    on conflict(organization_id,customer_id) do update set revision=excluded.revision,name=excluded.name,phone=excluded.phone,phone_e164=excluded.phone_e164;
   insert into public.phone_directory_changes values(new_org,r,new.id,'upsert',new.name,new.phone,private.call_phone(new.phone));
  else
   delete from public.phone_directory_live where organization_id=new_org and customer_id=new.id;
   insert into public.phone_directory_changes(organization_id,revision,customer_id,operation) values(new_org,r,new.id,'delete');
  end if;
 end if;
 return null;
end $$;
revoke all on function private.track_phone_directory() from public,anon,authenticated;
drop trigger if exists customers_phone_directory on public.customers;
create trigger customers_phone_directory after insert or update or delete on public.customers for each row execute function private.track_phone_directory();
-- Only seed orgs that have never had directory state; reapplication must not reset revisions.
with seeded as (insert into public.phone_directory_state(organization_id) select distinct organization_id from public.customers on conflict do nothing returning organization_id)
insert into public.phone_directory_live(organization_id,customer_id,revision,name,phone,phone_e164)
 select c.organization_id,c.id,0,c.name,c.phone,private.call_phone(c.phone) from public.customers c join seeded s on s.organization_id=c.organization_id
 where c.status in ('active','vip') and private.call_phone(c.phone) is not null;

create or replace function public.phone_directory(p_org uuid,p_cursor text default null,p_limit integer default 200) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='5s' set lock_timeout='2s' as $$
declare s public.phone_directory_state;parts text[];m text:='s';upper_rev bigint;boundary text:='00000000-0000-0000-0000-000000000000';after_rev bigint:=0;
 rows jsonb;last_id text;last_rev bigint;next_token text;checkpoint text;payload text;expired boolean:=false;
begin
 if auth.uid() is null or p_org is null or not private.has_organization_role(p_org,array['owner','admin','member']::text[])
 or not exists(select 1 from public.subscriptions x join public.plan_features f on f.plan_id=x.plan_id
 where x.organization_id=p_org and x.status in ('active','trialing') and (x.ends_at is null or x.ends_at>clock_timestamp()) and f.feature_code='crm.basic') then
 raise exception 'Phone directory access denied' using errcode='42501';end if;
 if p_limit is null or p_limit<1 or p_limit>200 or length(coalesce(p_cursor,''))>512 then raise exception 'Invalid directory input' using errcode='22023';end if;
 insert into public.phone_directory_state(organization_id) values(p_org) on conflict do nothing;
 select * into s from public.phone_directory_state where organization_id=p_org for update;
 upper_rev:=s.revision;
 if p_cursor is not null then
  parts:=string_to_array(p_cursor,':');
  if cardinality(parts)<>6 or parts[1]<>'d1' or parts[2]<>p_org::text or parts[3] not in ('s','d','c')
    or parts[4]!~'^(0|[1-9][0-9]{0,17})$' or parts[6]!~'^[0-9a-f]{64}$' then raise exception 'Invalid directory cursor' using errcode='22023';end if;
  payload:=array_to_string(parts[1:5],':');
  if private.phone_directory_mac(payload,s.secret)<>parts[6] then raise exception 'Invalid directory signature' using errcode='22023';end if;
  m:=parts[3];upper_rev:=parts[4]::bigint;boundary:=parts[5];
  if upper_rev>s.revision then raise exception 'Future revision' using errcode='22023';end if;
  if m='s' then
   if boundary!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Invalid keyset' using errcode='22023';end if;
   expired:=upper_rev<s.min_revision;
  else
   if boundary!~'^(0|[1-9][0-9]{0,17})$' then raise exception 'Invalid boundary' using errcode='22023';end if;
   after_rev:=boundary::bigint;
   if after_rev>upper_rev or (m='c' and after_rev<>upper_rev) then raise exception 'Invalid revision range' using errcode='22023';end if;
   expired:=after_rev<s.min_revision;
   if m='c' then m:='d';upper_rev:=s.revision;end if;
  end if;
 end if;
 if expired then return jsonb_build_object('organization_id',p_org,'mode','delta','items','[]'::jsonb,'revision',s.revision::text,'next_cursor',null,'cursor',null,'reset_required',true);end if;
 if m='s' then
  with page as materialized(select * from public.phone_directory_live where organization_id=p_org and customer_id>boundary::uuid and revision<=upper_rev order by customer_id limit p_limit)
  select coalesce(jsonb_agg(jsonb_build_object('operation','upsert','customer_id',customer_id,'name',name,'phone',phone,'phone_e164',phone_e164) order by customer_id),'[]'::jsonb),max(customer_id::text) into rows,last_id from page;
  -- A full page may need an empty terminal page. ID order never changes on rename.
  if jsonb_array_length(rows)=p_limit then next_token:=private.phone_directory_cursor(p_org,'s',upper_rev,last_id,s.secret);
  else next_token:=private.phone_directory_cursor(p_org,'d',s.revision,upper_rev::text,s.secret);end if;
 else
  with page as materialized(select * from public.phone_directory_changes where organization_id=p_org and revision>after_rev and revision<=upper_rev order by revision limit p_limit)
  select coalesce(jsonb_agg(jsonb_build_object('operation',operation,'customer_id',customer_id,'name',name,'phone',phone,'phone_e164',phone_e164,'revision',revision::text) order by revision),'[]'::jsonb),max(revision) into rows,last_rev from page;
  if coalesce(last_rev,upper_rev)<upper_rev then next_token:=private.phone_directory_cursor(p_org,'d',upper_rev,last_rev::text,s.secret);
  else checkpoint:=private.phone_directory_cursor(p_org,'c',upper_rev,upper_rev::text,s.secret);end if;
 end if;
 return jsonb_build_object('organization_id',p_org,'mode',case when m='s' then 'snapshot' else 'delta' end,'items',rows,'revision',upper_rev::text,'next_cursor',next_token,'cursor',checkpoint,'reset_required',false);
end $$;
revoke all on function public.phone_directory(uuid,text,integer) from public,anon,authenticated;
grant execute on function public.phone_directory(uuid,text,integer) to authenticated;

-- Privileged bounded retention helper: retain the newest p_keep changes per org.
-- Cursor floor and physical removal share the same org row lock/transaction.
create or replace function private.cleanup_phone_directory(p_org uuid,p_keep integer default 100000) returns integer
language plpgsql security definer set search_path='' set statement_timeout='5s' set lock_timeout='2s' as $$
declare s public.phone_directory_state;floor_rev bigint;n integer;
begin
 if p_keep is null or p_keep<1 or p_keep>100000 then raise exception 'Invalid retention' using errcode='22023';end if;
 select * into s from public.phone_directory_state where organization_id=p_org for update;
 if not found then return 0;end if;
 floor_rev:=greatest(s.min_revision,least(s.revision-p_keep,s.min_revision+5000));
 if floor_rev<=s.min_revision then return 0;end if;
 delete from public.phone_directory_changes where organization_id=p_org and revision<=floor_rev;
 get diagnostics n=row_count;
 update public.phone_directory_state set min_revision=floor_rev where organization_id=p_org;
 return n;
end $$;
revoke all on function private.cleanup_phone_directory(uuid,integer) from public,anon,authenticated;
