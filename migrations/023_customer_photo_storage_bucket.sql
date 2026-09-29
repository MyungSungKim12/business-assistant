begin;

-- 022_customer_photos may already be applied on projects that were initialized
-- without the generic file migration. Make the photo upload bucket explicit and
-- idempotent so the signed upload URL endpoint has a target.
insert into storage.buckets (id, name, public)
values ('business-files', 'business-files', false)
on conflict (id) do update set public = false;

commit;
