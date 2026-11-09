-- Let a message record whether it actually reached the customer.
--
-- The shop replies to customers in 39 places and recorded none of them, so the database
-- held one side of every conversation: what was asked, never what was answered. The
-- morning check could see that a customer ordered but not what price they were quoted,
-- and a reply that never arrived — expired token, no internet, the 24-hour window
-- closed — left no trace at all. The customer simply met silence.
--
-- Recording what was COMPOSED would be worse than nothing, because it would be trusted.
-- These columns let a reply be recorded as what it actually was.

begin;

alter table public.messages
  add column if not exists status text not null default 'sent',
  add column if not exists error text;

-- Inbound messages are, by definition, received.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conrelid = 'public.messages'::regclass and conname = 'messages_status_check'
  ) then
    alter table public.messages
      add constraint messages_status_check check (status in ('sent', 'failed', 'received'));
  end if;
end $$;

update public.messages set status = 'received' where direction = 'inbound' and status = 'sent';

comment on column public.messages.status is
  'received for inbound; sent or failed for outbound, set after WhatsApp answers — never from what was composed.';
comment on column public.messages.error is
  'Why a reply did not reach the customer, in WhatsApp''s own words.';

-- Finding what went unanswered is the point, so make it cheap.
create index if not exists idx_messages_failed
  on public.messages (conversation_id, created_at)
  where status = 'failed';

commit;
