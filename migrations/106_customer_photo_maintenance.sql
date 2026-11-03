-- N1030-06 / MED-002. Apply after 100,104,105. No Storage object deletion.
-- pg_cron is available on the target (1.6.4), not yet enabled. This file is a draft
-- until operator review/application. Jobs run as the migration owner, without JWT.
begin;
create extension if not exists pg_cron with schema pg_catalog;

alter table public.customer_photos add column if not exists upload_failure_reason text;
alter table public.customer_photos add column if not exists upload_failed_at timestamptz;
alter table public.customer_photos drop constraint if exists customer_photos_upload_failure_reason_check;
alter table public.customer_photos add constraint customer_photos_upload_failure_reason_check
 check(upload_failure_reason is null or upload_failure_reason in ('object_missing','metadata_mismatch','upload_not_completed'));
create index if not exists idx_customer_photos_global_pending on public.customer_photos(created_at,id)
 where upload_state='pending' and not is_archived;

-- Storage metadata is read-only. Avoid bigint overflow on malformed metadata.
create or replace function private.customer_photo_object_matches(p_path text,p_size bigint,p_type text)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from storage.objects o where o.bucket_id='business-files' and o.name=p_path
  and o.metadata->>'mimetype'=p_type and case when o.metadata->>'size' ~ '^[0-9]{1,20}$'
   then (o.metadata->>'size')::numeric=p_size else false end)
$$;
revoke all on function private.customer_photo_object_matches(text,bigint,text) from public,anon,authenticated;

create or replace function private.guard_customer_photo_upload()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT' then
  new.upload_state:='pending';new.uploaded_at:=null;new.upload_failure_reason:=null;new.upload_failed_at:=null;
 elsif old.upload_state='pending' and new.is_archived then
  new.upload_state:='failed';new.archived_reason:='upload_failed';new.uploaded_at:=null;new.upload_failed_at:=now();
  new.upload_failure_reason:=case
   when private.customer_photo_object_matches(old.storage_path,old.size_bytes,old.content_type) then 'upload_not_completed'
   when exists(select 1 from storage.objects where bucket_id='business-files' and name=old.storage_path) then 'metadata_mismatch'
   else 'object_missing' end;
 elsif old.upload_state='pending' and new.upload_state='ready' then
  if not private.customer_photo_object_matches(new.storage_path,new.size_bytes,new.content_type) then
   raise exception 'Photo upload is missing or does not match its metadata' using errcode='22023';
  end if;
  new.uploaded_at:=now();new.upload_failure_reason:=null;new.upload_failed_at:=null;
 elsif new.upload_state is distinct from old.upload_state then
  raise exception 'Invalid photo upload transition' using errcode='22023';
 else
  new.uploaded_at:=old.uploaded_at;new.upload_failure_reason:=old.upload_failure_reason;new.upload_failed_at:=old.upload_failed_at;
 end if;
 return new;
end $$;
revoke all on function private.guard_customer_photo_upload() from public,anon,authenticated;

-- NULL scope is INTERNAL ONLY. Public entry points below always authorize scope.
-- Eligibility is applied BEFORE limit so fresh, incomplete rows cannot starve
-- completed uploads behind them. Row locks serialize manual completion/cron.
create or replace function private.reconcile_customer_photo_uploads(p_organization_id uuid,p_customer_id uuid)
returns integer language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare photo public.customer_photos%rowtype;processed integer:=0;deadline timestamptz:=clock_timestamp()+interval '10 seconds';
begin
 if (p_organization_id is null)<>(p_customer_id is null) then raise exception 'Invalid scope' using errcode='22023';end if;
 for photo in select p.* from public.customer_photos p
  where p.upload_state='pending' and not p.is_archived
   and (p_organization_id is null or (p.organization_id=p_organization_id and p.customer_id=p_customer_id))
   and (p.created_at<now()-interval '130 minutes' or private.customer_photo_object_matches(p.storage_path,p.size_bytes,p.content_type))
  order by p.created_at,p.id limit 250 for update of p skip locked
 loop
  exit when clock_timestamp()>deadline;
  if private.customer_photo_object_matches(photo.storage_path,photo.size_bytes,photo.content_type) then
   update public.customer_photos set upload_state='ready' where id=photo.id and upload_state='pending' and not is_archived;
  elsif photo.created_at<now()-interval '130 minutes' then
   update public.customer_photos set is_archived=true,archived_reason='upload_failed' where id=photo.id and upload_state='pending' and not is_archived;
  end if;
  processed:=processed+1;
 end loop;
 return processed;
end $$;
revoke all on function private.reconcile_customer_photo_uploads(uuid,uuid) from public,anon,authenticated;

create or replace function public.reconcile_customer_photo_uploads(p_organization_id uuid,p_customer_id uuid)
returns integer language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or p_organization_id is null or p_customer_id is null
  or not private.has_organization_role(p_organization_id,array['owner','admin','member']::text[])
  then raise exception 'Photo access required' using errcode='42501';end if;
 return private.reconcile_customer_photo_uploads(p_organization_id,p_customer_id);
end $$;
revoke all on function public.reconcile_customer_photo_uploads(uuid,uuid) from public,anon,authenticated;
grant execute on function public.reconcile_customer_photo_uploads(uuid,uuid) to authenticated;

-- A single bounded diagnostic row. Never stores customer identifiers, names,
-- paths, URLs, tokens, or raw exception messages. No direct client table access.
create table if not exists private.photo_upload_maintenance_status(
 singleton boolean primary key default true check(singleton),
 attempted_at timestamptz not null,finished_at timestamptz,state text not null check(state in ('succeeded','failed')),
 processed integer not null default 0,error_code text);
alter table private.photo_upload_maintenance_status enable row level security;
revoke all on private.photo_upload_maintenance_status from public,anon,authenticated;

create or replace function private.run_photo_upload_maintenance()
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare started timestamptz:=clock_timestamp();n integer:=0;failure text;
begin
 -- Duplicate/manual scheduler runs return immediately. Public scoped calls use
 -- SKIP LOCKED and share the state machine, rather than this global lock.
 if not pg_try_advisory_xact_lock(106,1) then return jsonb_build_object('state','busy','processed',0);end if;
 begin
  n:=private.reconcile_customer_photo_uploads(null,null);
 exception when query_canceled or others then
  get stacked diagnostics failure=returned_sqlstate;
 end;
 insert into private.photo_upload_maintenance_status(singleton,attempted_at,finished_at,state,processed,error_code)
 values(true,started,clock_timestamp(),case when failure is null then 'succeeded' else 'failed' end,n,failure)
 on conflict(singleton) do update set attempted_at=excluded.attempted_at,finished_at=excluded.finished_at,
  state=excluded.state,processed=excluded.processed,error_code=excluded.error_code;
 return jsonb_build_object('state',case when failure is null then 'succeeded' else 'failed' end,'processed',n);
end $$;
revoke all on function private.run_photo_upload_maintenance() from public,anon,authenticated;

-- Manager-only redacted recovery queue; failed legacy rows have no known failure
-- instant/reason, so the UI explicitly labels them as unrecorded.
create or replace function public.customer_photo_upload_status(p_organization_id uuid,p_customer_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare items jsonb;maintenance jsonb;has_more boolean;
begin
 if auth.uid() is null or p_organization_id is null or p_customer_id is null
  or not private.has_organization_role(p_organization_id,array['owner','admin']::text[])
  then raise exception 'Photo manager required' using errcode='42501';end if;
 select coalesce(jsonb_agg(to_jsonb(q) order by q.upload_state,q.created_at desc,q.id),'[]'::jsonb) into items from (
  select id,organization_id,customer_id,original_name,upload_state,created_at,upload_failure_reason,upload_failed_at
  from public.customer_photos where organization_id=p_organization_id and customer_id=p_customer_id
   and ((upload_state='pending' and not is_archived) or upload_state='failed')
  order by upload_state,created_at desc,id limit 250) q;
 select exists(select 1 from public.customer_photos where organization_id=p_organization_id and customer_id=p_customer_id
  and ((upload_state='pending' and not is_archived) or upload_state='failed') offset 250 limit 1) into has_more;
 select jsonb_build_object('attempted_at',attempted_at,'finished_at',finished_at,'state',state,'error_code',error_code)
  into maintenance from private.photo_upload_maintenance_status where singleton;
 return jsonb_build_object('items',items,'limit',250,'has_more',has_more,'maintenance',maintenance);
end $$;
revoke all on function public.customer_photo_upload_status(uuid,uuid) from public,anon,authenticated;
grant execute on function public.customer_photo_upload_status(uuid,uuid) to authenticated;

-- 104 TTL and 105 explicit 100000-change retention only. No business ledger,
-- customer activity, treatment, transaction, legal hold or Storage deletion.
create or replace function private.run_phone_retention_maintenance()
returns void language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare org record;deadline timestamptz:=clock_timestamp()+interval '10 seconds';
begin
 if not pg_try_advisory_xact_lock(106,2) then return;end if;
 perform private.cleanup_phone_inbox(500);
 for org in select organization_id from public.phone_directory_state
  where revision-min_revision>100000 order by organization_id limit 10 for update skip locked
 loop
  exit when clock_timestamp()>deadline;
  perform private.cleanup_phone_directory(org.organization_id,100000);
 end loop;
end $$;
revoke all on function private.run_phone_retention_maintenance() from public,anon,authenticated;

-- Name-based cron.schedule replaces the same job on reapplication (no duplicates).
-- SET is outside the function: PostgreSQL statement_timeout starts at command entry.
select cron.schedule('customer-photo-upload-maintenance','*/5 * * * *',
 'SET statement_timeout = ''15s''; SET lock_timeout = ''2s''; SELECT private.run_photo_upload_maintenance();');
select cron.schedule('phone-retention-maintenance','17 * * * *',
 'SET statement_timeout = ''15s''; SET lock_timeout = ''2s''; SELECT private.run_phone_retention_maintenance();');
commit;
