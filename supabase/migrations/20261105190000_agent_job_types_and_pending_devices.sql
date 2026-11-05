-- Widen what the agent is allowed to be asked to do, and let a device legitimately be
-- "awaiting approval".
--
-- Two constraints were written when the agent only read balances:
--
--   agent_jobs.type     allowed only preflight, read_godown_balances, post_voucher, so
--                       every write operation the agent now performs was rejected at
--                       insert time.
--   agent_devices.status allowed only active and revoked, with no way to express a
--                       machine that has enrolled but not yet been approved. That was
--                       being worked around by storing 'revoked' plus a live enrollment
--                       code, which reads as a revocation to anyone inspecting the row.

ALTER TABLE public.agent_jobs DROP CONSTRAINT IF EXISTS agent_jobs_type_check;
ALTER TABLE public.agent_jobs ADD CONSTRAINT agent_jobs_type_check
  CHECK (type IN (
    -- read
    'preflight',
    'read_godown_balances',
    'read_godowns',
    -- write to Tally
    'create_godown',
    'create_stock_item',
    'adjust_stock',
    'post_voucher',
    'post_sales_voucher'
  ));

ALTER TABLE public.agent_devices DROP CONSTRAINT IF EXISTS agent_devices_status_check;
ALTER TABLE public.agent_devices ADD CONSTRAINT agent_devices_status_check
  CHECK (status IN ('pending', 'active', 'revoked'));

-- Rows currently carrying 'revoked' only because they are awaiting approval are moved
-- onto the honest status. A genuine revocation always has revoked_at set.
UPDATE public.agent_devices
   SET status = 'pending'
 WHERE status = 'revoked'
   AND revoked_at IS NULL
   AND enrollment_code IS NOT NULL;

-- Claiming a job filters on shop and state and takes the oldest; without this index
-- that is a sequential scan on every poll, from every shop, every few seconds.
CREATE INDEX IF NOT EXISTS idx_agent_jobs_claim
  ON public.agent_jobs (shop_id, state, created_at ASC)
  WHERE state = 'pending';

-- A device is looked up by its credential hash on every single call it makes, so this
-- is the hottest lookup in the system.
CREATE INDEX IF NOT EXISTS idx_agent_devices_credential
  ON public.agent_devices (credential_hash);

-- An enrollment code is looked up while it is on screen, every few seconds.
CREATE INDEX IF NOT EXISTS idx_agent_devices_enrollment
  ON public.agent_devices (enrollment_code)
  WHERE enrollment_code IS NOT NULL;
