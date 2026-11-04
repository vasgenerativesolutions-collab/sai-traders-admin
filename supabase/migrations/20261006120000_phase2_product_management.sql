-- ==============================================================================
-- Phase 2 — Product Management, Tally Write-Back & Offline Safety
-- Additive on Phase 1 (20261005120000_phase1_v3.sql)
-- ==============================================================================

-- 1. Drop Phase 1 trigger (references video_record directly, not video_item)
DROP TRIGGER IF EXISTS trg_saree_catalog_listing_guard ON saree_catalog;

-- 2. Backup statuses (only if not already backed up — idempotent)
ALTER TABLE saree_catalog ADD COLUMN IF NOT EXISTS legacy_status_backup text;
UPDATE saree_catalog SET legacy_status_backup = status WHERE legacy_status_backup IS NULL;

-- 3. Expand status constraint
ALTER TABLE saree_catalog DROP CONSTRAINT IF EXISTS saree_catalog_status_check;
DO $$ BEGIN
  ALTER TABLE saree_catalog DROP CONSTRAINT IF EXISTS saree_catalog_status_check1;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE saree_catalog ADD CONSTRAINT saree_catalog_status_check
  CHECK (status IN (
    'draft', 'pending_tally', 'pending_review', 'listed', 'unlisted',
    'code_changed', 'missing_in_tally', 'archived'
  ));

-- Legacy rows: all become 'unlisted'. NOT confirmed in Tally.
UPDATE saree_catalog SET status = 'unlisted'
WHERE status IN ('listed', 'unlisted', 'pending_listing');
ALTER TABLE saree_catalog ALTER COLUMN status SET DEFAULT 'draft';

-- 4. New columns
ALTER TABLE saree_catalog
  ADD COLUMN IF NOT EXISTS created_by text,
  ADD COLUMN IF NOT EXISTS cost_rate numeric(10,2),
  ADD COLUMN IF NOT EXISTS tally_rate numeric(10,2),
  ADD COLUMN IF NOT EXISTS tally_master_id text,
  ADD COLUMN IF NOT EXISTS tally_created_at timestamptz,
  ADD COLUMN IF NOT EXISTS tally_last_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS item_created_in_tally boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stock_added_in_tally boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS inward_voucher_type text,
  ADD COLUMN IF NOT EXISTS listing_notes text,
  ADD COLUMN IF NOT EXISTS design_family_id uuid;

CREATE INDEX IF NOT EXISTS idx_saree_tally_master_id
  ON saree_catalog(tally_master_id) WHERE tally_master_id IS NOT NULL;

-- 5. UNIQUE constraint on tally_part_number (for video_item FK)
DO $$ BEGIN
  ALTER TABLE saree_catalog
    ADD CONSTRAINT saree_catalog_tally_part_number_unique UNIQUE (tally_part_number);
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
END $$;

-- 6. code_reservation
CREATE TABLE IF NOT EXISTS code_reservation (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_code    text        NOT NULL UNIQUE,
  saree_id        uuid        REFERENCES saree_catalog(id) ON DELETE RESTRICT,
  reserved_at     timestamptz NOT NULL DEFAULT now(),
  reserved_by     text        NOT NULL,
  status          text        NOT NULL DEFAULT 'reserved'
                              CHECK (status IN ('reserved', 'confirmed', 'voided')),
  voided_reason   text,
  voided_at       timestamptz
);

-- 7. Sequences
CREATE SEQUENCE IF NOT EXISTS product_code_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS online_voucher_seq START WITH 1 INCREMENT BY 1;

-- Seed from catalog (Tally max set by pre-flight at runtime)
DO $$
DECLARE v_max integer;
BEGIN
  SELECT COALESCE(MAX(
    CASE WHEN tally_part_number ~ '^SAI-[0-9]+$'
         THEN substring(tally_part_number FROM 5)::integer
         ELSE 0
    END
  ), 0) INTO v_max FROM saree_catalog;
  IF v_max > 0 THEN
    PERFORM setval('product_code_seq', v_max);
  END IF;
END $$;

-- RPC: advance only (never goes backward)
CREATE OR REPLACE FUNCTION setval_product_code_seq(p_val integer)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_current bigint;
BEGIN
  SELECT last_value INTO v_current FROM product_code_seq;
  IF p_val > v_current THEN
    PERFORM setval('product_code_seq', p_val);
  END IF;
END;
$$;

-- Reserve function reads prefix/pad from code_config
CREATE OR REPLACE FUNCTION reserve_next_product_code(p_reserved_by text)
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v_next integer; v_code text; v_config jsonb;
BEGIN
  SELECT value INTO v_config FROM app_config WHERE key = 'code_config';
  v_next := nextval('product_code_seq');
  v_code := COALESCE(v_config->>'prefix', 'SAI-') ||
            lpad(v_next::text, COALESCE((v_config->>'pad_length')::integer, 4), '0');
  INSERT INTO code_reservation (product_code, reserved_by, status)
  VALUES (v_code, p_reserved_by, 'reserved');
  RETURN v_code;
END;
$$;

-- 8. video_record changes
ALTER TABLE video_record ALTER COLUMN product_code DROP NOT NULL;
ALTER TABLE video_record
  ADD COLUMN IF NOT EXISTS is_multi_saree boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

-- 9. video_item
CREATE TABLE IF NOT EXISTS video_item (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id        text        NOT NULL REFERENCES video_record(video_id) ON DELETE CASCADE,
  product_code    text        NOT NULL REFERENCES saree_catalog(tally_part_number)
                              ON DELETE RESTRICT,
  start_sec       float,
  end_sec         float,
  sort_order      integer     NOT NULL DEFAULT 0,
  attrs           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  crop_box        jsonb,
  confusable_with text[],
  verified        boolean     NOT NULL DEFAULT false,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(video_id, product_code)
);

CREATE INDEX IF NOT EXISTS idx_video_item_product ON video_item(product_code);
CREATE INDEX IF NOT EXISTS idx_video_item_video ON video_item(video_id);

-- 10. Backfill video_item from video_record (skip orphan codes)
INSERT INTO video_item (video_id, product_code, sort_order, verified)
SELECT vr.video_id, vr.product_code, 0, vr.verified
FROM video_record vr
WHERE vr.product_code IS NOT NULL
  AND EXISTS (SELECT 1 FROM saree_catalog sc WHERE sc.tally_part_number = vr.product_code)
ON CONFLICT (video_id, product_code) DO NOTHING;

-- Log orphan video codes
DO $$
DECLARE v_orphans text[];
BEGIN
  SELECT array_agg(DISTINCT vr.product_code) INTO v_orphans
  FROM video_record vr
  WHERE vr.product_code IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM saree_catalog sc WHERE sc.tally_part_number = vr.product_code);
  IF v_orphans IS NOT NULL AND array_length(v_orphans, 1) > 0 THEN
    INSERT INTO audit_log (actor, action, entity_type, metadata)
    VALUES ('system', 'phase2_migration_orphan_videos', 'video_record',
            jsonb_build_object('orphan_codes', v_orphans));
    RAISE NOTICE 'Orphan video codes (not in catalog): %', v_orphans;
  END IF;
END $$;

-- 11. saree_frame additions
ALTER TABLE saree_frame
  ADD COLUMN IF NOT EXISTS video_item_id uuid REFERENCES video_item(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS multi_saree_frame boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_saree_frame_video_item ON saree_frame(video_item_id);

-- Backfill saree_frame.video_item_id
UPDATE saree_frame sf SET video_item_id = vi.id
FROM video_item vi
WHERE vi.video_id = sf.video_id AND vi.product_code = sf.product_code;

-- 12. tally_sync_log additions
ALTER TABLE tally_sync_log
  ADD COLUMN IF NOT EXISTS operation_type text,
  ADD COLUMN IF NOT EXISTS payload_hash text;

ALTER TABLE tally_sync_log DROP CONSTRAINT IF EXISTS tally_sync_log_direction_check;
ALTER TABLE tally_sync_log ADD CONSTRAINT tally_sync_log_direction_check
  CHECK (direction IN ('inbound', 'outbound'));

ALTER TABLE tally_sync_log DROP CONSTRAINT IF EXISTS tally_sync_log_operation_type_check;
ALTER TABLE tally_sync_log ADD CONSTRAINT tally_sync_log_operation_type_check
  CHECK (operation_type IS NULL OR operation_type IN (
    'stock_summary', 'master_refresh', 'stock_item_create',
    'receipt_note', 'stock_journal', 'sales_voucher',
    'alias_check', 'collection_export', 'reconciliation'
  ));

CREATE INDEX IF NOT EXISTS idx_tally_sync_payload_hash
  ON tally_sync_log(payload_hash) WHERE payload_hash IS NOT NULL;

-- 13. checkout_record
CREATE TABLE IF NOT EXISTS checkout_record (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  hold_id             uuid        NOT NULL REFERENCES hold(id),
  phone               text        NOT NULL,
  channel             text        NOT NULL DEFAULT 'web'
                                  CHECK (channel IN ('web', 'whatsapp')),
  idempotency_key     text        NOT NULL UNIQUE,
  razorpay_order_id   text,
  razorpay_payment_id text        UNIQUE,
  status              text        NOT NULL DEFAULT 'awaiting_payment'
                                  CHECK (status IN (
                                    'awaiting_payment', 'paid', 'expired',
                                    'cancelled', 'refund_queued', 'refunded'
                                  )),
  amount_paise        integer     NOT NULL,
  consent_terms       boolean     NOT NULL DEFAULT false,
  consent_marketing   boolean     NOT NULL DEFAULT false,
  consent_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  paid_at             timestamptz,
  expired_at          timestamptz
);

CREATE INDEX IF NOT EXISTS idx_checkout_razorpay
  ON checkout_record(razorpay_order_id) WHERE razorpay_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_checkout_hold ON checkout_record(hold_id);
CREATE INDEX IF NOT EXISTS idx_checkout_refund
  ON checkout_record(status) WHERE status = 'refund_queued';

-- 14. Phase 2 gatekeeper functions + trigger (inlined)
CREATE OR REPLACE FUNCTION check_can_list_product(p_saree_id uuid)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_s RECORD;
  v_r text[] := '{}';
BEGIN
  SELECT * INTO v_s FROM saree_catalog WHERE id = p_saree_id;
  IF NOT FOUND THEN
    RETURN '{"can_list": false, "reasons": ["Not found"]}'::jsonb;
  END IF;

  IF v_s.name IS NULL OR trim(v_s.name) = '' THEN
    v_r := array_append(v_r, 'Missing name');
  END IF;
  IF v_s.price IS NULL OR v_s.price <= 0 THEN
    v_r := array_append(v_r, 'Missing price');
  END IF;
  IF v_s.image_urls IS NULL OR array_length(v_s.image_urls, 1) < 1 THEN
    v_r := array_append(v_r, 'Missing photos');
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM video_item vi
    JOIN video_record vr ON vr.video_id = vi.video_id
    WHERE vi.product_code = v_s.tally_part_number
      AND vi.verified = true AND vr.is_active = true
  ) THEN
    v_r := array_append(v_r, 'No verified video');
  END IF;
  IF NOT v_s.item_created_in_tally OR NOT v_s.stock_added_in_tally THEN
    v_r := array_append(v_r, 'Not confirmed in Tally');
  END IF;

  RETURN jsonb_build_object(
    'can_list', array_length(v_r, 1) IS NULL OR array_length(v_r, 1) = 0,
    'reasons', v_r
  );
END;
$$;

CREATE OR REPLACE FUNCTION trg_enforce_listing_rules()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'listed'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'listed')
  THEN
    IF NEW.name IS NULL OR trim(NEW.name) = '' THEN
      RAISE EXCEPTION 'Cannot list: missing name';
    END IF;
    IF NEW.price IS NULL OR NEW.price <= 0 THEN
      RAISE EXCEPTION 'Cannot list: missing selling price';
    END IF;
    IF NEW.image_urls IS NULL OR array_length(NEW.image_urls, 1) < 1 THEN
      RAISE EXCEPTION 'Cannot list: missing photos';
    END IF;
    IF NOT EXISTS(
      SELECT 1 FROM video_item vi
      JOIN video_record vr ON vr.video_id = vi.video_id
      WHERE vi.product_code = NEW.tally_part_number
        AND vi.verified = true AND vr.is_active = true
    ) THEN
      RAISE EXCEPTION 'Cannot list: no verified video item';
    END IF;
    IF NOT NEW.item_created_in_tally OR NOT NEW.stock_added_in_tally THEN
      RAISE EXCEPTION 'Cannot list: not confirmed in Tally';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_saree_catalog_listing_guard ON saree_catalog;
CREATE TRIGGER trg_saree_catalog_listing_guard
  BEFORE INSERT OR UPDATE OF status ON saree_catalog
  FOR EACH ROW
  EXECUTE FUNCTION trg_enforce_listing_rules();

-- 15. RLS
ALTER TABLE code_reservation ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkout_record ENABLE ROW LEVEL SECURITY;

-- 16. app_config (merge, not overwrite)
UPDATE app_config
SET value = value || '{
  "default_inward_voucher_type": "Receipt Note",
  "allowed_inward_voucher_types": ["Receipt Note", "Stock Journal"],
  "unit": "Nos",
  "stock_group": "Sarees"
}'::jsonb
WHERE key = 'stock_config';

INSERT INTO app_config (key, value) VALUES
  ('ledger_config', '{"cash_ledger": "Cash", "sales_ledger": "Sales Account"}'::jsonb),
  ('gst_config', '{"notes": "GST set by accountant in TallyPrime desktop. Agent cannot set via XML."}'::jsonb),
  ('code_config', '{"prefix": "SAI-", "pad_length": 4}'::jsonb),
  ('voucher_series_config', '{"mechanism": "separate_voucher_types", "types": {"receipt_note": "Online Receipt Note", "stock_journal": "Online Stock Journal", "sales": "Online Sales"}}'::jsonb)
ON CONFLICT (key) DO NOTHING;

UPDATE app_config
SET value = value || '{"xml_tested": true, "gst_set_by_accountant": false, "online_voucher_types_created": false}'::jsonb
WHERE key = 'go_live_gates';

-- Log the migration
INSERT INTO audit_log (actor, action, entity_type, metadata)
VALUES ('system', 'phase2_migration_applied', 'schema',
        jsonb_build_object(
          'migration', '20261006120000_phase2_product_management.sql',
          'phase1_applied', true,
          'legacy_rows_set_to_unlisted', true
        ));
