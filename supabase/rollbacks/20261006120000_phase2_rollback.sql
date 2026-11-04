-- ==============================================================================
-- Phase 2 ROLLBACK — Restores Phase 1 state
-- ==============================================================================

-- Disable RLS on Phase 2 tables
ALTER TABLE IF EXISTS checkout_record DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS code_reservation DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS video_item DISABLE ROW LEVEL SECURITY;

-- Drop Phase 2 trigger
DROP TRIGGER IF EXISTS trg_saree_catalog_listing_guard ON saree_catalog;

-- Drop checkout_record
DROP TABLE IF EXISTS checkout_record;

-- Revert tally_sync_log
ALTER TABLE tally_sync_log DROP CONSTRAINT IF EXISTS tally_sync_log_operation_type_check;
ALTER TABLE tally_sync_log DROP COLUMN IF EXISTS operation_type;
ALTER TABLE tally_sync_log DROP COLUMN IF EXISTS payload_hash;
ALTER TABLE tally_sync_log DROP CONSTRAINT IF EXISTS tally_sync_log_direction_check;
ALTER TABLE tally_sync_log ADD CONSTRAINT tally_sync_log_direction_check
  CHECK (direction IN ('inbound', 'outbound'));

-- Revert saree_frame
ALTER TABLE saree_frame DROP COLUMN IF EXISTS video_item_id;
ALTER TABLE saree_frame DROP COLUMN IF EXISTS multi_saree_frame;

-- Drop video_item
DROP TABLE IF EXISTS video_item;

-- Revert video_record
ALTER TABLE video_record DROP COLUMN IF EXISTS is_multi_saree;
ALTER TABLE video_record DROP COLUMN IF EXISTS is_active;
-- Restore NOT NULL on product_code (requires backfill of NULLs first)
UPDATE video_record SET product_code = 'UNKNOWN' WHERE product_code IS NULL;
ALTER TABLE video_record ALTER COLUMN product_code SET NOT NULL;

-- Drop sequences and code_reservation
DROP SEQUENCE IF EXISTS online_voucher_seq;
DROP FUNCTION IF EXISTS reserve_next_product_code(text);
DROP FUNCTION IF EXISTS setval_product_code_seq(integer);
DROP SEQUENCE IF EXISTS product_code_seq;
DROP TABLE IF EXISTS code_reservation;

-- Drop UNIQUE constraint on tally_part_number
ALTER TABLE saree_catalog DROP CONSTRAINT IF EXISTS saree_catalog_tally_part_number_unique;

-- Drop new columns (EXCEPT legacy_status_backup — needed for restore)
ALTER TABLE saree_catalog
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS cost_rate,
  DROP COLUMN IF EXISTS tally_rate,
  DROP COLUMN IF EXISTS tally_master_id,
  DROP COLUMN IF EXISTS tally_created_at,
  DROP COLUMN IF EXISTS tally_last_seen_at,
  DROP COLUMN IF EXISTS item_created_in_tally,
  DROP COLUMN IF EXISTS stock_added_in_tally,
  DROP COLUMN IF EXISTS inward_voucher_type,
  DROP COLUMN IF EXISTS listing_notes,
  DROP COLUMN IF EXISTS design_family_id;

-- Restore statuses: DROP constraint FIRST, then restore from backup, then re-add Phase 1 constraint
ALTER TABLE saree_catalog DROP CONSTRAINT IF EXISTS saree_catalog_status_check;

-- Set non-Phase-1 statuses to 'unlisted' (safe fallback)
UPDATE saree_catalog SET status = 'unlisted'
WHERE status IN ('draft', 'archived', 'code_changed', 'missing_in_tally', 'pending_tally', 'pending_review');

-- Restore original status from backup
UPDATE saree_catalog SET status = legacy_status_backup
WHERE legacy_status_backup IS NOT NULL
  AND legacy_status_backup IN ('pending_listing', 'listed', 'unlisted');

-- Re-add Phase 1 constraint
ALTER TABLE saree_catalog ADD CONSTRAINT saree_catalog_status_check
  CHECK (status IN ('pending_listing', 'listed', 'unlisted'));
ALTER TABLE saree_catalog ALTER COLUMN status SET DEFAULT 'pending_listing';

-- Now drop the backup column
ALTER TABLE saree_catalog DROP COLUMN IF EXISTS legacy_status_backup;

-- Restore Phase 1 gatekeeper (references video_record.verified directly)
DROP FUNCTION IF EXISTS check_can_list_product(uuid);
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
    SELECT 1 FROM video_record
    WHERE product_code = v_s.tally_part_number AND verified = true
  ) THEN
    v_r := array_append(v_r, 'No verified video');
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
DECLARE v_check jsonb;
BEGIN
  IF NEW.status = 'listed' AND OLD.status IS DISTINCT FROM 'listed' THEN
    v_check := check_can_list_product(NEW.id);
    IF NOT (v_check->>'can_list')::boolean THEN
      RAISE EXCEPTION 'Cannot list: %', v_check->>'reasons';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_saree_catalog_listing_guard
  BEFORE UPDATE OF status ON saree_catalog
  FOR EACH ROW
  EXECUTE FUNCTION trg_enforce_listing_rules();

-- Revert app_config
DELETE FROM app_config WHERE key IN ('ledger_config', 'gst_config', 'code_config', 'voucher_series_config');
UPDATE app_config
SET value = value - 'default_inward_voucher_type' - 'allowed_inward_voucher_types' - 'unit' - 'stock_group'
WHERE key = 'stock_config';
UPDATE app_config
SET value = value - 'xml_tested' - 'gst_set_by_accountant' - 'online_voucher_types_created'
WHERE key = 'go_live_gates';

-- Log rollback
INSERT INTO audit_log (actor, action, entity_type, metadata)
VALUES ('system', 'phase2_rollback_applied', 'schema',
        jsonb_build_object('rollback_from', 'phase2_product_management'));
