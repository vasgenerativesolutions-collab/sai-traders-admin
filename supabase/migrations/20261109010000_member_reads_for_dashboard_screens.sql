-- Let a member read the three things the dashboard shows but could not reach.
--
-- Sales analytics, reconciliation and the sync history were all service-role only, so a
-- dashboard hosted without a store server behind it could not load any of them — the
-- screens appeared broken rather than empty, which is a different message and sends
-- someone looking in the wrong place.
--
-- Reads only, scoped to the member's own shop, exactly as the catalogue is. Resolving a
-- discrepancy is a decision that changes stock, so it stays behind the server.

begin;

drop policy if exists discrepancies_member_read on public.discrepancies;
create policy discrepancies_member_read on public.discrepancies
  for select to authenticated
  using (shop_id in (select public.current_user_shop_ids()));

drop policy if exists sync_runs_member_read on public.sync_runs;
create policy sync_runs_member_read on public.sync_runs
  for select to authenticated
  using (shop_id in (select public.current_user_shop_ids()));

commit;
