-- SEC-13: keep RPC-only migration and operational tables closed to direct client access.
begin;

-- This function is an event-trigger callback, not an application RPC.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

-- These RLS-enabled tables are intentionally accessed through checked RPCs only.
-- Explicit restrictive policies keep that boundary closed if table grants change later.
do $$
declare
  target record;
  policy_name text := 'deny_direct_client_access';
begin
  for target in
    select * from (values
      ('public', 'appointment_series_operations'),
      ('public', 'file_storage_upload_reservations'),
      ('public', 'management_profit_finalizations'),
      ('public', 'sale_line_commission_allocations'),
      ('public', 'staff_commission_attribution_events'),
      ('public', 'staff_commission_attribution_overrides'),
      ('public', 'staff_commission_settlement_lines'),
      ('public', 'staff_commission_settlements'),
      ('private', 'document_template_operations')
    ) as t(schema_name, table_name)
  loop
    execute format(
      'drop policy if exists %I on %I.%I',
      policy_name, target.schema_name, target.table_name
    );
    execute format(
      'create policy %I on %I.%I as restrictive for all to anon, authenticated using (false) with check (false)',
      policy_name, target.schema_name, target.table_name
    );
  end loop;
end;
$$;

commit;
