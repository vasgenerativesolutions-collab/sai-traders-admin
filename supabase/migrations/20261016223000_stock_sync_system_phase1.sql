-- ==============================================================================
-- Sai Traders — Stock Sync System Migration (Phase 1)
-- Multi-Shop Readiness (shop_id), Atomic Stock Functions,
-- Outbound Agent Tables, Reconciliation & Discrepancies, Downtime Safety
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Multi-Shop Tenant Infrastructure
-- ------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.shops (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  code        text        NOT NULL UNIQUE,
  is_active   boolean     NOT NULL DEFAULT true,
  settings    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Seed default flagship shop
INSERT INTO public.shops (id, name, code, settings)
VALUES (
  '00000000-0000-0000-0000-000000000001'::uuid,
  'Sai Traders — Tumakuru',
  'SAI',
  jsonb_build_object(
    'city', 'Tumakuru',
    'state', 'Karnataka',
    'online_godown', 'Online',
    'default_sync_time', '09:30'
  )
)
ON CONFLICT (code) DO NOTHING;

-- Add shop_id to existing core tables (default to flagship shop)
DO $$ BEGIN
  ALTER TABLE public.saree_catalog
    ADD COLUMN IF NOT EXISTS shop_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid REFERENCES public.shops(id);
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.stock_pool
    ADD COLUMN IF NOT EXISTS shop_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid REFERENCES public.shops(id);
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.hold
    ADD COLUMN IF NOT EXISTS shop_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid REFERENCES public.shops(id);
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.orders
    ADD COLUMN IF NOT EXISTS shop_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid REFERENCES public.shops(id);
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.customers
    ADD COLUMN IF NOT EXISTS shop_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid REFERENCES public.shops(id);
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.audit_log
    ADD COLUMN IF NOT EXISTS shop_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid REFERENCES public.shops(id);
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_saree_catalog_shop ON public.saree_catalog(shop_id);
CREATE INDEX IF NOT EXISTS idx_stock_pool_shop ON public.stock_pool(shop_id);
CREATE INDEX IF NOT EXISTS idx_hold_shop ON public.hold(shop_id);
CREATE INDEX IF NOT EXISTS idx_orders_shop ON public.orders(shop_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_shop ON public.audit_log(shop_id);

-- ------------------------------------------------------------------------------
-- 2. New Operational Tables
-- ------------------------------------------------------------------------------

-- 2.1 Sync Runs Table
CREATE TABLE IF NOT EXISTS public.sync_runs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         uuid        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid REFERENCES public.shops(id),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  status          text        NOT NULL DEFAULT 'running'
                              CHECK (status IN ('running', 'completed', 'completed_with_issues', 'failed')),
  step_log        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  triggered_by    text        NOT NULL DEFAULT 'cron'
                              CHECK (triggered_by IN ('cron', 'admin', 'retry', 'agent')),
  error_summary   text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_shop_created ON public.sync_runs(shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_runs_status ON public.sync_runs(status);

-- 2.2 Daily Stock Snapshots Table
CREATE TABLE IF NOT EXISTS public.stock_snapshots (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         uuid        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid REFERENCES public.shops(id),
  item_id         uuid        REFERENCES public.saree_catalog(id) ON DELETE SET NULL,
  product_code    text        NOT NULL,
  snapshot_date   date        NOT NULL DEFAULT CURRENT_DATE,
  tally_qty       integer     NOT NULL DEFAULT 0,
  cloud_qty       integer     NOT NULL DEFAULT 0,
  source_run_id   uuid        REFERENCES public.sync_runs(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(shop_id, product_code, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_stock_snapshots_date ON public.stock_snapshots(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_stock_snapshots_item ON public.stock_snapshots(product_code);

-- 2.3 Discrepancies Table
CREATE TABLE IF NOT EXISTS public.discrepancies (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         uuid        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid REFERENCES public.shops(id),
  item_id         uuid        REFERENCES public.saree_catalog(id) ON DELETE SET NULL,
  product_code    text        NOT NULL,
  run_id          uuid        REFERENCES public.sync_runs(id) ON DELETE CASCADE,
  expected_qty    integer     NOT NULL,
  actual_qty      integer     NOT NULL,
  delta           integer     GENERATED ALWAYS AS (actual_qty - expected_qty) STORED,
  explanation     text,
  status          text        NOT NULL DEFAULT 'open'
                              CHECK (status IN ('open', 'resolved')),
  resolved_by     text,
  resolved_at     timestamptz,
  resolution_notes text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_discrepancies_status ON public.discrepancies(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_discrepancies_product ON public.discrepancies(product_code);

-- 2.4 Item Aliases Table
CREATE TABLE IF NOT EXISTS public.item_aliases (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         uuid        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid REFERENCES public.shops(id),
  item_id         uuid        NOT NULL REFERENCES public.saree_catalog(id) ON DELETE CASCADE,
  alias           text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(shop_id, alias)
);
CREATE INDEX IF NOT EXISTS idx_item_aliases_alias ON public.item_aliases(alias);

-- Preserve legacy SR-1042-R mapping into item_aliases
INSERT INTO public.item_aliases (shop_id, item_id, alias)
SELECT sc.shop_id, sc.id, 'SR-1042-R'
FROM public.saree_catalog sc
WHERE sc.sku = 'SR-1042-R' OR sc.tally_part_number = 'SR-1042-R'
ON CONFLICT (shop_id, alias) DO NOTHING;

-- 2.5 Agent Devices Table (Enrollment, Revocation, Heartbeats)
CREATE TABLE IF NOT EXISTS public.agent_devices (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                 uuid        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid REFERENCES public.shops(id),
  device_name             text        NOT NULL DEFAULT 'Shop PC',
  credential_hash         text        NOT NULL,
  enrollment_code         text,
  enrollment_expires_at   timestamptz,
  status                  text        NOT NULL DEFAULT 'active'
                                      CHECK (status IN ('active', 'revoked')),
  version                 text,
  last_seen_at            timestamptz,
  tally_reachable         boolean     DEFAULT false,
  company_loaded          text,
  godown_exists           boolean     DEFAULT false,
  revoked_at              timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_devices_shop_status ON public.agent_devices(shop_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_devices_cred_hash ON public.agent_devices(credential_hash);

-- 2.6 Agent Jobs Queue Table (Preflight, Read Godown, Post Voucher)
CREATE TABLE IF NOT EXISTS public.agent_jobs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         uuid        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid REFERENCES public.shops(id),
  device_id       uuid        REFERENCES public.agent_devices(id) ON DELETE SET NULL,
  type            text        NOT NULL
                              CHECK (type IN ('preflight', 'read_godown_balances', 'post_voucher')),
  payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  state           text        NOT NULL DEFAULT 'pending'
                              CHECK (state IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
  attempts        integer     NOT NULL DEFAULT 0,
  max_attempts    integer     NOT NULL DEFAULT 3,
  result          jsonb,
  error           text,
  locked_at       timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_poll ON public.agent_jobs(shop_id, state, created_at ASC);

-- 2.7 Sales Posting Queue Table (Phase 3/4 Vouchers)
CREATE TABLE IF NOT EXISTS public.posting_queue (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         uuid        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid REFERENCES public.shops(id),
  order_id        uuid        NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  state           text        NOT NULL DEFAULT 'queued'
                              CHECK (state IN ('queued', 'in_progress', 'posted', 'failed', 'cancelled')),
  attempts        integer     NOT NULL DEFAULT 0,
  max_attempts    integer     NOT NULL DEFAULT 5,
  voucher_number  text,
  remote_id       text        NOT NULL, -- Fixed remote ID per order ensuring idempotency
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(shop_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_posting_queue_state ON public.posting_queue(state, created_at ASC);

-- ------------------------------------------------------------------------------
-- 3. Dynamic Sync Settings in app_settings
-- ------------------------------------------------------------------------------

INSERT INTO public.app_settings (key, value, description)
VALUES 
  ('sync_schedule_config', '{
    "time": "09:30",
    "timezone": "Asia/Kolkata",
    "retry_interval_minutes": 15,
    "cutoff_minutes": 90,
    "enabled": true
  }', 'Dynamic morning sync time and timeout policies'),
  ('sync_alert_config', '{
    "alert_on_downtime": true,
    "alert_channel": "in_app",
    "notify_emails": ["owner@saitraders.com"]
  }', 'Alert triggers for PC downtime or failed preflight'),
  ('downtime_policy', '{
    "allow_manual_stock_entry": true,
    "require_reason": true
  }', 'Enables manual stock modifications in admin during PC downtime')
ON CONFLICT (key) DO NOTHING;

-- ------------------------------------------------------------------------------
-- 4. Atomic Database Stock Functions (Zero direct writes by client code)
-- ------------------------------------------------------------------------------

-- 4.1 place_hold: Atomic inventory reservation with row-locking
CREATE OR REPLACE FUNCTION public.place_hold(
  p_shop_id uuid,
  p_product_code text,
  p_customer_id uuid,
  p_channel text DEFAULT 'web',
  p_idempotency_key text DEFAULT NULL,
  p_client_ip text DEFAULT NULL,
  p_duration_minutes integer DEFAULT 10
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_stock RECORD;
  v_existing_hold RECORD;
  v_hold_id uuid;
  v_expires_at timestamptz;
  v_grace_until timestamptz;
  v_avail integer;
BEGIN
  -- 1. Idempotency Check
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing_hold FROM public.hold
    WHERE idempotency_key = p_idempotency_key AND shop_id = p_shop_id;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'hold_id', v_existing_hold.id,
        'idempotent_replay', true,
        'state', v_existing_hold.state,
        'expires_at', v_existing_hold.expires_at
      );
    END IF;
  END IF;

  -- 2. Lock stock row FOR UPDATE (prevents race conditions between concurrent buyers)
  SELECT * INTO v_stock
  FROM public.stock_pool
  WHERE shop_id = p_shop_id AND product_code = p_product_code
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'product_not_found',
      'message', 'Product code does not exist in inventory pool'
    );
  END IF;

  -- 3. Calculate true real-time availability
  v_avail := GREATEST(0, v_stock.online_quantity - v_stock.held_quantity - v_stock.sold_pending_quantity);

  IF v_avail < 1 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'out_of_stock',
      'available_quantity', 0,
      'message', 'Selected item is currently sold out or being booked by another customer'
    );
  END IF;

  -- 4. Calculate hold expiration windows
  v_expires_at := now() + (COALESCE(p_duration_minutes, 10) || ' minutes')::interval;
  v_grace_until := v_expires_at + '2 minutes'::interval;

  -- 5. Atomically increment held_quantity in stock_pool
  UPDATE public.stock_pool
  SET held_quantity = held_quantity + 1,
      updated_at = now()
  WHERE id = v_stock.id;

  -- 6. Insert new hold record
  INSERT INTO public.hold (
    shop_id,
    product_code,
    saree_id,
    customer_id,
    quantity,
    state,
    channel,
    expires_at,
    grace_until,
    idempotency_key,
    client_ip
  ) VALUES (
    p_shop_id,
    p_product_code,
    v_stock.saree_id,
    p_customer_id,
    1,
    'held',
    COALESCE(p_channel, 'web'),
    v_expires_at,
    v_grace_until,
    p_idempotency_key,
    p_client_ip
  )
  RETURNING id INTO v_hold_id;

  -- 7. Audit log
  PERFORM public.write_audit_log(
    'system:hold',
    'place_hold',
    'stock_pool',
    v_stock.product_code,
    jsonb_build_object('held_quantity', v_stock.held_quantity),
    jsonb_build_object('held_quantity', v_stock.held_quantity + 1),
    jsonb_build_object('hold_id', v_hold_id, 'customer_id', p_customer_id, 'channel', p_channel)
  );

  RETURN jsonb_build_object(
    'success', true,
    'hold_id', v_hold_id,
    'product_code', p_product_code,
    'expires_at', v_expires_at,
    'grace_until', v_grace_until,
    'remaining_available', v_avail - 1
  );
END;
$$;

-- 4.2 release_hold: Restores held quantity when timer expires or user cancels
CREATE OR REPLACE FUNCTION public.release_hold(
  p_hold_id uuid,
  p_reason text DEFAULT 'expired'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_hold RECORD;
  v_stock RECORD;
BEGIN
  -- Lock hold record
  SELECT * INTO v_hold
  FROM public.hold
  WHERE id = p_hold_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'hold_not_found');
  END IF;

  IF v_hold.state != 'held' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'hold_already_transitioned',
      'current_state', v_hold.state
    );
  END IF;

  -- Lock stock record
  SELECT * INTO v_stock
  FROM public.stock_pool
  WHERE shop_id = v_hold.shop_id AND product_code = v_hold.product_code
  FOR UPDATE;

  IF FOUND THEN
    UPDATE public.stock_pool
    SET held_quantity = GREATEST(0, held_quantity - v_hold.quantity),
        updated_at = now()
    WHERE id = v_stock.id;
  END IF;

  UPDATE public.hold
  SET state = 'released',
      released_at = now()
  WHERE id = v_hold.id;

  -- Audit log
  PERFORM public.write_audit_log(
    'system:hold',
    'release_hold',
    'hold',
    v_hold.id::text,
    jsonb_build_object('state', 'held'),
    jsonb_build_object('state', 'released', 'reason', p_reason),
    jsonb_build_object('product_code', v_hold.product_code)
  );

  RETURN jsonb_build_object(
    'success', true,
    'hold_id', p_hold_id,
    'state', 'released',
    'released_quantity', v_hold.quantity
  );
END;
$$;

-- 4.3 confirm_order: Transitions hold -> sold_pending_quantity atomically
CREATE OR REPLACE FUNCTION public.confirm_order(
  p_shop_id uuid,
  p_hold_id uuid,
  p_order_id uuid,
  p_payment_ref text DEFAULT NULL,
  p_channel text DEFAULT 'web'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_hold RECORD;
  v_stock RECORD;
  v_remote_id text;
BEGIN
  -- Lock hold record
  SELECT * INTO v_hold
  FROM public.hold
  WHERE id = p_hold_id AND shop_id = p_shop_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'hold_not_found');
  END IF;

  IF v_hold.state = 'paid' AND v_hold.order_id = p_order_id THEN
    RETURN jsonb_build_object(
      'success', true,
      'order_id', p_order_id,
      'idempotent_replay', true,
      'status', 'already_confirmed'
    );
  END IF;

  -- Must be 'held' and within grace window
  IF v_hold.state != 'held' OR now() > v_hold.grace_until THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'hold_expired_or_invalid',
      'state', v_hold.state,
      'grace_until', v_hold.grace_until
    );
  END IF;

  -- Lock stock pool
  SELECT * INTO v_stock
  FROM public.stock_pool
  WHERE shop_id = p_shop_id AND product_code = v_hold.product_code
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'stock_pool_missing');
  END IF;

  -- Atomically move quantity from held_quantity -> sold_pending_quantity
  UPDATE public.stock_pool
  SET held_quantity = GREATEST(0, held_quantity - v_hold.quantity),
      sold_pending_quantity = sold_pending_quantity + v_hold.quantity,
      updated_at = now()
  WHERE id = v_stock.id;

  -- Mark hold as paid
  UPDATE public.hold
  SET state = 'paid',
      order_id = p_order_id,
      payment_ref = p_payment_ref,
      paid_at = now()
  WHERE id = v_hold.id;

  -- Update order status
  UPDATE public.orders
  SET status = 'paid_pending_approval',
      payment_status = 'paid',
      channel = p_channel,
      updated_at = now()
  WHERE id = p_order_id AND shop_id = p_shop_id;

  -- Fixed remote ID per order for idempotent voucher posting in Phase 3/4
  v_remote_id := 'SAI-ORD-' || p_order_id::text;

  INSERT INTO public.posting_queue (
    shop_id,
    order_id,
    state,
    remote_id
  ) VALUES (
    p_shop_id,
    p_order_id,
    'queued',
    v_remote_id
  )
  ON CONFLICT (shop_id, order_id) DO NOTHING;

  -- Audit log
  PERFORM public.write_audit_log(
    'order:confirm',
    'confirm_order',
    'orders',
    p_order_id::text,
    jsonb_build_object('hold_state', 'held'),
    jsonb_build_object('hold_state', 'paid', 'order_status', 'paid_pending_approval'),
    jsonb_build_object('product_code', v_hold.product_code, 'remote_id', v_remote_id)
  );

  RETURN jsonb_build_object(
    'success', true,
    'order_id', p_order_id,
    'product_code', v_hold.product_code,
    'status', 'paid_pending_approval',
    'remote_id', v_remote_id
  );
END;
$$;

-- 4.4 apply_sync_result: Reconciles Tally Online Godown balances during morning sync
CREATE OR REPLACE FUNCTION public.apply_sync_result(
  p_shop_id uuid,
  p_run_id uuid,
  p_tally_balances jsonb, -- Array of objects: [{"product_code": "SAI-0021", "tally_qty": 4, "rate": 5000}]
  p_actor text DEFAULT 'agent'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_item jsonb;
  v_code text;
  v_tally_qty integer;
  v_stock RECORD;
  v_expected_qty integer;
  v_disc_count integer := 0;
  v_updated_count integer := 0;
  v_clamped boolean := false;
BEGIN
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_tally_balances)
  LOOP
    v_code := v_item->>'product_code';
    v_tally_qty := COALESCE((v_item->>'tally_qty')::integer, 0);

    -- Find matching stock_pool record
    SELECT * INTO v_stock
    FROM public.stock_pool
    WHERE shop_id = p_shop_id AND product_code = v_code
    FOR UPDATE;

    IF FOUND THEN
      -- Record snapshot
      INSERT INTO public.stock_snapshots (
        shop_id,
        item_id,
        product_code,
        snapshot_date,
        tally_qty,
        cloud_qty,
        source_run_id
      ) VALUES (
        p_shop_id,
        v_stock.saree_id,
        v_code,
        CURRENT_DATE,
        v_tally_qty,
        v_stock.online_quantity,
        p_run_id
      )
      ON CONFLICT (shop_id, product_code, snapshot_date)
      DO UPDATE SET
        tally_qty = EXCLUDED.tally_qty,
        cloud_qty = EXCLUDED.cloud_qty,
        source_run_id = EXCLUDED.source_run_id;

      -- Calculate expected tally balance:
      -- Cloud online_quantity should match Tally if all posted orders have completed
      v_expected_qty := v_stock.online_quantity;

      -- Check for discrepancy
      IF v_tally_qty != v_expected_qty THEN
        v_disc_count := v_disc_count + 1;
        INSERT INTO public.discrepancies (
          shop_id,
          item_id,
          product_code,
          run_id,
          expected_qty,
          actual_qty,
          explanation,
          status
        ) VALUES (
          p_shop_id,
          v_stock.saree_id,
          v_code,
          p_run_id,
          v_expected_qty,
          v_tally_qty,
          CASE
            WHEN v_tally_qty > v_expected_qty THEN 'Tally stock is higher than cloud (possible physical inward transfer)'
            ELSE 'Tally stock is lower than cloud (unaccounted sale or physical damage)'
          END,
          'open'
        );
      END IF;

      -- Clamping safety: Tally count cannot drop below active held + unposted orders
      v_clamped := v_tally_qty < (v_stock.held_quantity + v_stock.sold_pending_quantity);

      -- Update stock pool
      UPDATE public.stock_pool
      SET online_quantity = v_tally_qty,
          last_synced_at = now(),
          sync_clamp_warning = v_clamped,
          source = 'tally_godown',
          updated_at = now()
      WHERE id = v_stock.id;

      -- Update saree_catalog
      UPDATE public.saree_catalog
      SET tally_last_seen_at = now(),
          stock_quantity = GREATEST(0, v_tally_qty - v_stock.held_quantity - v_stock.sold_pending_quantity),
          updated_at = now()
      WHERE id = v_stock.saree_id;

      v_updated_count := v_updated_count + 1;
    END IF;
  END LOOP;

  -- Update sync run state
  UPDATE public.sync_runs
  SET finished_at = now(),
      status = CASE WHEN v_disc_count > 0 THEN 'completed_with_issues' ELSE 'completed' END,
      step_log = step_log || jsonb_build_object(
        'step', 'reconciliation_complete',
        'items_synced', v_updated_count,
        'discrepancies_logged', v_disc_count,
        'completed_at', now()
      )
  WHERE id = p_run_id;

  RETURN jsonb_build_object(
    'success', true,
    'run_id', p_run_id,
    'items_synced', v_updated_count,
    'discrepancies_count', v_disc_count
  );
END;
$$;

-- 4.5 admin_manual_stock_entry: Downtime manual override
CREATE OR REPLACE FUNCTION public.admin_manual_stock_entry(
  p_shop_id uuid,
  p_product_code text,
  p_new_quantity integer,
  p_reason text,
  p_admin_user text DEFAULT 'admin'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_stock RECORD;
  v_old_qty integer;
BEGIN
  IF p_new_quantity < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Quantity cannot be negative');
  END IF;

  SELECT * INTO v_stock
  FROM public.stock_pool
  WHERE shop_id = p_shop_id AND product_code = p_product_code
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Product not found in stock pool');
  END IF;

  v_old_qty := v_stock.online_quantity;

  UPDATE public.stock_pool
  SET online_quantity = p_new_quantity,
      source = 'admin_entered',
      updated_at = now()
  WHERE id = v_stock.id;

  UPDATE public.saree_catalog
  SET stock_quantity = GREATEST(0, p_new_quantity - v_stock.held_quantity - v_stock.sold_pending_quantity),
      updated_at = now()
  WHERE id = v_stock.saree_id;

  PERFORM public.write_audit_log(
    p_admin_user,
    'manual_stock_entry_downtime',
    'stock_pool',
    p_product_code,
    jsonb_build_object('online_quantity', v_old_qty),
    jsonb_build_object('online_quantity', p_new_quantity, 'reason', p_reason),
    jsonb_build_object('source', 'admin_entered')
  );

  RETURN jsonb_build_object(
    'success', true,
    'product_code', p_product_code,
    'previous_quantity', v_old_qty,
    'new_quantity', p_new_quantity,
    'source', 'admin_entered'
  );
END;
$$;

-- ------------------------------------------------------------------------------
-- 5. Row Level Security (RLS)
-- ------------------------------------------------------------------------------

ALTER TABLE public.shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discrepancies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.item_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posting_queue ENABLE ROW LEVEL SECURITY;

-- Anonymous and Authenticated users have read access only to active public catalog & availability
DROP POLICY IF EXISTS "Public read available stock" ON public.stock_pool;
CREATE POLICY "Public read available stock" ON public.stock_pool
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Public read item aliases" ON public.item_aliases;
CREATE POLICY "Public read item aliases" ON public.item_aliases
  FOR SELECT TO anon, authenticated USING (true);

-- Service role bypasses RLS for Edge Functions and Admin APIs
DROP POLICY IF EXISTS "Service role full access on shops" ON public.shops;
CREATE POLICY "Service role full access on shops" ON public.shops
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on sync_runs" ON public.sync_runs;
CREATE POLICY "Service role full access on sync_runs" ON public.sync_runs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on stock_snapshots" ON public.stock_snapshots;
CREATE POLICY "Service role full access on stock_snapshots" ON public.stock_snapshots
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on discrepancies" ON public.discrepancies;
CREATE POLICY "Service role full access on discrepancies" ON public.discrepancies
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on item_aliases" ON public.item_aliases;
CREATE POLICY "Service role full access on item_aliases" ON public.item_aliases
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on agent_devices" ON public.agent_devices;
CREATE POLICY "Service role full access on agent_devices" ON public.agent_devices
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on agent_jobs" ON public.agent_jobs;
CREATE POLICY "Service role full access on agent_jobs" ON public.agent_jobs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on posting_queue" ON public.posting_queue;
CREATE POLICY "Service role full access on posting_queue" ON public.posting_queue
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Log migration execution
INSERT INTO public.audit_log (actor, action, entity_type, metadata)
VALUES (
  'system',
  'phase1_stock_sync_migration_applied',
  'schema',
  jsonb_build_object(
    'migration', '20261016223000_stock_sync_system_phase1.sql',
    'tables_created', ARRAY['shops', 'sync_runs', 'stock_snapshots', 'discrepancies', 'item_aliases', 'agent_devices', 'agent_jobs', 'posting_queue'],
    'functions_created', ARRAY['place_hold', 'release_hold', 'confirm_order', 'apply_sync_result', 'admin_manual_stock_entry']
  )
);
