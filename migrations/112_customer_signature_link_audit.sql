-- DOC-012 보완: 관리자 링크 철회와 교체 행위자를 보존한다.
begin;
alter table public.treatment_document_signature_links
  add column revoked_by uuid references auth.users(id) on delete restrict,
  add column revocation_reason text check (revocation_reason is null or revocation_reason in ('manager_revoked','replaced'));
alter table public.treatment_document_signature_links
  add constraint treatment_document_signature_links_revocation_actor_check
  check ((revoked_at is null and revoked_by is null and revocation_reason is null)
      or (revoked_at is not null and revoked_by is not null and revocation_reason is not null));

create or replace function public.create_customer_document_signature_link(
 p_organization_id uuid,p_customer_id uuid,p_treatment_id uuid,p_document_id uuid,p_token_hash text,p_expires_at timestamptz
) returns table(id uuid,expires_at timestamptz) language plpgsql security definer set search_path='' as $$
declare doc public.issued_treatment_documents%rowtype; created_id uuid;
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then raise exception 'Document manager required' using errcode='42501'; end if;
 if p_token_hash !~ '^[0-9a-f]{64}$' or p_expires_at<=clock_timestamp() or p_expires_at>clock_timestamp()+interval '30 days' then raise exception 'Invalid signature link' using errcode='22023'; end if;
 select d.* into doc from public.issued_treatment_documents d where d.id=p_document_id and d.organization_id=p_organization_id and d.customer_id=p_customer_id and d.treatment_id=p_treatment_id for update;
 if not found then raise exception 'Issued document not found' using errcode='P0002'; end if;
 if not exists(select 1 from public.customers c where c.id=p_customer_id and c.organization_id=p_organization_id)
   or not exists(select 1 from public.treatment_records t where t.id=p_treatment_id and t.organization_id=p_organization_id and t.customer_id=p_customer_id) then raise exception 'Issued document scope mismatch' using errcode='42501'; end if;
 if exists(select 1 from public.treatment_document_events where document_id=p_document_id and action in ('sign','revoke')) then raise exception 'Document is already signed or revoked' using errcode='22023'; end if;
 update public.treatment_document_signature_links set revoked_at=clock_timestamp(),revoked_by=auth.uid(),revocation_reason='replaced'
 where document_id=p_document_id and consumed_at is null and revoked_at is null;
 insert into public.treatment_document_signature_links(organization_id,customer_id,treatment_id,document_id,token_hash,expires_at,created_by)
 values(p_organization_id,p_customer_id,p_treatment_id,p_document_id,p_token_hash,p_expires_at,auth.uid()) returning treatment_document_signature_links.id into created_id;
 return query select created_id,p_expires_at;
end; $$;
revoke all on function public.create_customer_document_signature_link(uuid,uuid,uuid,uuid,text,timestamptz) from public,anon;
grant execute on function public.create_customer_document_signature_link(uuid,uuid,uuid,uuid,text,timestamptz) to authenticated;

create or replace function public.revoke_customer_document_signature_link(p_organization_id uuid,p_link_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then raise exception 'Document manager required' using errcode='42501'; end if;
 update public.treatment_document_signature_links set revoked_at=clock_timestamp(),revoked_by=auth.uid(),revocation_reason='manager_revoked'
 where id=p_link_id and organization_id=p_organization_id and consumed_at is null and revoked_at is null;
 return found;
end; $$;
revoke all on function public.revoke_customer_document_signature_link(uuid,uuid) from public,anon;
grant execute on function public.revoke_customer_document_signature_link(uuid,uuid) to authenticated;
commit;
