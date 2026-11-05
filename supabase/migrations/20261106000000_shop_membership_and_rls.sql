-- Shop membership, and row level security that actually scopes to it.
--
-- Two problems, one cause: nothing tied a signed-in person to a shop, and the tables
-- holding shop data had RLS switched off entirely.
--
-- The consequence was not theoretical. With the project's anon key — which is published
-- in a public repository by design, because an anon key is meant to be public and
-- constrained by RLS — saree_catalog, orders, customers, conversations, messages,
-- image_analyses and app_config were all readable, and saree_catalog and orders were
-- writable AND deletable. Anyone could have read every customer's phone number and
-- WhatsApp history, altered an order's payment status, or emptied the catalogue.
--
-- Everything legitimate reaches these tables with the service-role key (the admin
-- server and all five edge functions), and service_role bypasses RLS. So switching RLS
-- on closes the hole without changing a single working path.
--
-- Membership is what makes "log in and see only this shop" true, rather than a filter
-- the application has to remember on every query — it forgot on roughly sixty of them.

begin;

-- ---------------------------------------------------------------------------
-- Who belongs to which shop
-- ---------------------------------------------------------------------------
create table if not exists public.shop_members (
  user_id    uuid not null references auth.users (id) on delete cascade,
  shop_id    uuid not null references public.shops (id) on delete cascade,
  role       text not null default 'staff' check (role in ('owner', 'staff')),
  created_at timestamptz not null default now(),
  primary key (user_id, shop_id)
);

comment on table public.shop_members is
  'Which signed-in users may see which shop. Every tenant policy is defined against this.';

alter table public.shop_members enable row level security;

-- A member may see their own memberships and nobody else's.
drop policy if exists shop_members_self_read on public.shop_members;
create policy shop_members_self_read on public.shop_members
  for select to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- The caller's shops.
--
-- SECURITY DEFINER so a policy on another table can consult shop_members without
-- recursing through that table's own policy. STABLE so it is evaluated once per
-- statement rather than per row.
-- ---------------------------------------------------------------------------
create or replace function public.current_user_shop_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select shop_id from public.shop_members where user_id = auth.uid();
$$;

revoke all on function public.current_user_shop_ids() from public;
grant execute on function public.current_user_shop_ids() to authenticated;

-- ---------------------------------------------------------------------------
-- Lock the tables that were open, and scope the ones that can be scoped.
-- ---------------------------------------------------------------------------
alter table public.saree_catalog   enable row level security;
alter table public.orders          enable row level security;
alter table public.customers       enable row level security;
alter table public.conversations   enable row level security;
alter table public.messages        enable row level security;
alter table public.image_analyses  enable row level security;
alter table public.app_config      enable row level security;

-- saree_catalog, orders and customers carry shop_id, so a member sees exactly their
-- shop. Reads only: every write still goes through the server or an edge function
-- under the service role, so a compromised browser session cannot change stock, prices
-- or payment status.
drop policy if exists saree_catalog_member_read on public.saree_catalog;
create policy saree_catalog_member_read on public.saree_catalog
  for select to authenticated
  using (shop_id in (select public.current_user_shop_ids()));

drop policy if exists orders_member_read on public.orders;
create policy orders_member_read on public.orders
  for select to authenticated
  using (shop_id in (select public.current_user_shop_ids()));

drop policy if exists customers_member_read on public.customers;
create policy customers_member_read on public.customers
  for select to authenticated
  using (shop_id in (select public.current_user_shop_ids()));

-- A member sees their own shop row, and no other shop's.
drop policy if exists shops_member_read on public.shops;
create policy shops_member_read on public.shops
  for select to authenticated
  using (id in (select public.current_user_shop_ids()));

-- conversations, messages, image_analyses and app_config have no shop column yet, so
-- they cannot be scoped correctly. They get NO policy, which denies every client while
-- the service role continues to work. Guessing a scope here would be worse than
-- withholding access: these hold customers' message history.

-- The device and agent tables are reachable only through the edge function, which
-- authenticates with a device token and runs as service_role. They keep deny-all.

-- ---------------------------------------------------------------------------
-- Seed the people who already use the dashboard, so nobody is locked out.
-- ---------------------------------------------------------------------------
insert into public.shop_members (user_id, shop_id, role)
select u.id, s.id, 'owner'
from auth.users u
cross join public.shops s
where u.email in ('admin@saitraders.com', 'mithunvas8695@gmail.com')
on conflict (user_id, shop_id) do nothing;

commit;
