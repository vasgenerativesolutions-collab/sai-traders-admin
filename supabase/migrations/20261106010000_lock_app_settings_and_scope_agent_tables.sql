-- Stop app_settings handing out credentials, and let a member read their own shop's
-- agent state.
--
-- app_settings had `for select to anon, authenticated using (true)`. With the project's
-- anon key — public by design and published in this repository — that table returned
-- WHATSAPP_ACCESS_TOKEN: a live 281-character Meta token. Anyone could have sent
-- WhatsApp messages as this business. It also exposed stock levels, the store PC's
-- hostname and the tunnel URL.
--
-- The token now lives where a secret belongs, as an edge function secret, which is
-- where _shared/whatsapp.ts already looks when the table does not answer. The rows are
-- removed below. Rotating the token at Meta is still necessary — locking the table does
-- not undo an exposure that has already happened.
--
-- agent_devices and agent_jobs were deny-all to clients, which is correct while the
-- dashboard is served by a server holding the service key. A dashboard hosted with no
-- server has to read them directly, so members get a scoped read — and only a read.

begin;

-- ---------------------------------------------------------------------------
-- app_settings: no anonymous access, and never a credential
-- ---------------------------------------------------------------------------
drop policy if exists "Allow public read access" on public.app_settings;
drop policy if exists app_settings_read on public.app_settings;
drop policy if exists app_settings_public_read on public.app_settings;

-- Drop whatever permissive select policy exists, whatever it is called.
do $$
declare p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'app_settings'
      and cmd = 'SELECT' and roles::text like '%anon%'
  loop
    execute format('drop policy %I on public.app_settings', p.policyname);
  end loop;
end $$;

-- A signed-in member may read operational settings. Credential-shaped keys are refused
-- even to them: nothing in a browser needs a token, and a table is the wrong place to
-- keep one.
drop policy if exists app_settings_member_read on public.app_settings;
create policy app_settings_member_read on public.app_settings
  for select to authenticated
  using (
    exists (select 1 from public.shop_members m where m.user_id = auth.uid())
    and key not ilike '%token%'
    and key not ilike '%secret%'
    and key not ilike '%password%'
    and key not ilike '%api_key%'
    and key not ilike '%access_key%'
  );

-- ---------------------------------------------------------------------------
-- The credentials come out of the table
-- ---------------------------------------------------------------------------
delete from public.app_settings
where key in ('WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID');

-- ---------------------------------------------------------------------------
-- A member may read their own shop's agent state, so a dashboard with no server
-- behind it can show whether the store PC is alive.
-- ---------------------------------------------------------------------------
drop policy if exists agent_devices_member_read on public.agent_devices;
create policy agent_devices_member_read on public.agent_devices
  for select to authenticated
  using (shop_id in (select public.current_user_shop_ids()));

drop policy if exists agent_jobs_member_read on public.agent_jobs;
create policy agent_jobs_member_read on public.agent_jobs
  for select to authenticated
  using (shop_id in (select public.current_user_shop_ids()));

-- Reads only. Enrolling, approving and queueing work all go through the edge function,
-- which checks a device token or a member's JWT and runs as service_role. A browser
-- session can therefore never write a job or alter a device.

commit;
