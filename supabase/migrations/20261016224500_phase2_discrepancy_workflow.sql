-- ==============================================================================
-- Sai Traders — Phase 2: New-Stock Detection & Discrepancy Workflow
-- Atomic resolution, new stock ingestion, draft product creation, RLS & APIs
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Discrepancy Resolution Function
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_discrepancy(
  p_discrepancy_id uuid,
  p_action text, -- 'accept_tally', 'keep_cloud', 'manual_count'
  p_verified_qty integer DEFAULT NULL,
  p_notes text DEFAULT '',
  p_resolved_by text DEFAULT 'admin'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_disc RECORD;
  v_stock RECORD;
  v_final_qty integer;
BEGIN
  -- 1. Validate action
  IF p_action NOT IN ('accept_tally', 'keep_cloud', 'manual_count') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid action. Must be accept_tally, keep_cloud, or manual_count');
  END IF;

  -- 2. Lock discrepancy record FOR UPDATE
  SELECT * INTO v_disc
  FROM public.discrepancies
  WHERE id = p_discrepancy_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Discrepancy record not found');
  END IF;

  IF v_disc.status = 'resolved' THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotent_replay', true,
      'discrepancy_id', p_discrepancy_id,
      'message', 'Discrepancy already resolved'
    );
  END IF;

  -- 3. Lock stock_pool record
  SELECT * INTO v_stock
  FROM public.stock_pool
  WHERE shop_id = v_disc.shop_id AND product_code = v_disc.product_code
  FOR UPDATE;

  -- 4. Compute target online quantity based on resolution strategy
  IF p_action = 'accept_tally' THEN
    v_final_qty := v_disc.actual_qty;
  ELSIF p_action = 'keep_cloud' THEN
    v_final_qty := v_disc.expected_qty;
  ELSIF p_action = 'manual_count' THEN
    IF p_verified_qty IS NULL OR p_verified_qty < 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'p_verified_qty must be a non-negative integer for manual_count');
    END IF;
    v_final_qty := p_verified_qty;
  END IF;

  -- 5. Apply quantity update to stock_pool and saree_catalog
  IF v_stock.id IS NOT NULL THEN
    UPDATE public.stock_pool
    SET online_quantity = v_final_qty,
        source = CASE WHEN p_action = 'accept_tally' THEN 'tally_godown' ELSE 'admin_entered' END,
        updated_at = now()
    WHERE id = v_stock.id;

    IF v_stock.saree_id IS NOT NULL THEN
      UPDATE public.saree_catalog
      SET stock_quantity = GREATEST(0, v_final_qty - v_stock.held_quantity - v_stock.sold_pending_quantity),
          updated_at = now()
      WHERE id = v_stock.saree_id;
    END IF;
  END IF;

  -- 6. Update discrepancy record to resolved
  UPDATE public.discrepancies
  SET status = 'resolved',
      resolved_by = p_resolved_by,
      resolved_at = now(),
      resolution_notes = COALESCE(p_notes, '') || ' [Action: ' || p_action || ', Set Qty: ' || v_final_qty || ']'
  WHERE id = v_disc.id;

  -- 7. Audit log
  PERFORM public.write_audit_log(
    p_resolved_by,
    'resolve_discrepancy',
    'discrepancies',
    p_discrepancy_id::text,
    jsonb_build_object('expected_qty', v_disc.expected_qty, 'actual_qty', v_disc.actual_qty, 'status', 'open'),
    jsonb_build_object('final_qty', v_final_qty, 'action', p_action, 'status', 'resolved'),
    jsonb_build_object('product_code', v_disc.product_code, 'notes', p_notes)
  );

  RETURN jsonb_build_object(
    'success', true,
    'discrepancy_id', p_discrepancy_id,
    'status', 'resolved',
    'product_code', v_disc.product_code,
    'action', p_action,
    'final_quantity', v_final_qty
  );
END;
$$;

-- ------------------------------------------------------------------------------
-- 2. Enhanced Morning Sync Reconciliation with New-Stock & Draft Creation
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.apply_sync_result(
  p_shop_id uuid,
  p_run_id uuid,
  p_tally_balances jsonb, -- Array of [{ "product_code": "SAI-0021", "tally_qty": 4, "rate": 5000 }]
  p_actor text DEFAULT 'agent'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_item jsonb;
  v_raw_code text;
  v_code text;
  v_tally_qty integer;
  v_rate numeric;
  v_stock RECORD;
  v_alias RECORD;
  v_new_item_id uuid;
  v_expected_qty integer;
  v_disc_count integer := 0;
  v_new_stock_count integer := 0;
  v_new_drafts_count integer := 0;
  v_updated_count integer := 0;
  v_clamped boolean := false;
BEGIN
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_tally_balances)
  LOOP
    v_raw_code := trim(v_item->>'product_code');
    v_tally_qty := COALESCE((v_item->>'tally_qty')::integer, 0);
    v_rate := COALESCE((v_item->>'rate')::numeric, 0);

    -- Skip empty product names
    IF v_raw_code IS NULL OR v_raw_code = '' THEN
      CONTINUE;
    END IF;

    -- Check item_aliases for canonical product_code mapping
    SELECT * INTO v_alias
    FROM public.item_aliases
    WHERE shop_id = p_shop_id AND alias = v_raw_code;

    IF FOUND THEN
      -- Map to canonical tally_part_number
      SELECT tally_part_number INTO v_code
      FROM public.saree_catalog
      WHERE id = v_alias.item_id;

      IF v_code IS NULL THEN
        v_code := v_raw_code;
      END IF;
    ELSE
      v_code := v_raw_code;
    END IF;

    -- Look up stock_pool
    SELECT * INTO v_stock
    FROM public.stock_pool
    WHERE shop_id = p_shop_id AND product_code = v_code
    FOR UPDATE;

    IF FOUND THEN
      -- Existing Product in stock_pool
      v_expected_qty := v_stock.online_quantity;

      -- Check for New Stock Inward (Unexplained Rise) vs Discrepancy (Unexplained Drop)
      IF v_tally_qty > v_expected_qty THEN
        -- Accepted as NEW STOCK INWARD per business rule
        v_new_stock_count := v_new_stock_count + 1;

        PERFORM public.write_audit_log(
          p_actor,
          'new_stock_inward_detected',
          'stock_pool',
          v_code,
          jsonb_build_object('online_quantity', v_expected_qty),
          jsonb_build_object('online_quantity', v_tally_qty, 'inward_delta', v_tally_qty - v_expected_qty),
          jsonb_build_object('source_run_id', p_run_id, 'rate', v_rate)
        );

      ELSIF v_tally_qty < v_expected_qty THEN
        -- Unexplained drop -> MUST go to human in discrepancies
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
          'Tally Online Godown quantity (' || v_tally_qty || ') is lower than cloud expected balance (' || v_expected_qty || '). Delta: -' || (v_expected_qty - v_tally_qty),
          'open'
        );
      END IF;

      -- Clamping safety
      v_clamped := v_tally_qty < (v_stock.held_quantity + v_stock.sold_pending_quantity);

      -- Record Snapshot
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

      -- Update Stock Pool
      UPDATE public.stock_pool
      SET online_quantity = v_tally_qty,
          last_synced_at = now(),
          sync_clamp_warning = v_clamped,
          source = 'tally_godown',
          updated_at = now()
      WHERE id = v_stock.id;

      -- Update Saree Catalog
      IF v_stock.saree_id IS NOT NULL THEN
        UPDATE public.saree_catalog
        SET tally_last_seen_at = now(),
            stock_quantity = GREATEST(0, v_tally_qty - v_stock.held_quantity - v_stock.sold_pending_quantity),
            updated_at = now()
        WHERE id = v_stock.saree_id;
      END IF;

      v_updated_count := v_updated_count + 1;

    ELSE
      -- Brand New Unknown SKU in Tally -> Auto-create as DRAFT product
      v_new_drafts_count := v_new_drafts_count + 1;

      INSERT INTO public.saree_catalog (
        shop_id,
        sku,
        tally_part_number,
        name,
        fabric,
        color_primary,
        price,
        stock_quantity,
        status,
        item_created_in_tally,
        stock_added_in_tally,
        tally_rate,
        tally_last_seen_at,
        listing_notes
      ) VALUES (
        p_shop_id,
        v_code,
        v_code,
        'Draft Saree (' || v_code || ')',
        'Pure Silk',
        'Assorted',
        COALESCE(v_rate * 1.3, 5000), -- 30% margin default
        0,                            -- 0 until reviewed & listed
        'draft',
        true,
        v_tally_qty > 0,
        v_rate,
        now(),
        'Imported from Tally Online Godown during morning sync #' || p_run_id::text
      )
      RETURNING id INTO v_new_item_id;

      -- Add to stock_pool
      INSERT INTO public.stock_pool (
        shop_id,
        product_code,
        saree_id,
        online_quantity,
        held_quantity,
        sold_pending_quantity,
        source,
        tally_godown,
        last_synced_at
      ) VALUES (
        p_shop_id,
        v_code,
        v_new_item_id,
        v_tally_qty,
        0,
        0,
        'tally_godown',
        'Online',
        now()
      );

      -- Record Snapshot
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
        v_new_item_id,
        v_code,
        CURRENT_DATE,
        v_tally_qty,
        0,
        p_run_id
      )
      ON CONFLICT (shop_id, product_code, snapshot_date) DO NOTHING;

      -- Log in audit log
      PERFORM public.write_audit_log(
        p_actor,
        'auto_created_draft_from_tally',
        'saree_catalog',
        v_code,
        NULL,
        jsonb_build_object('product_code', v_code, 'tally_qty', v_tally_qty, 'status', 'draft'),
        jsonb_build_object('source_run_id', p_run_id, 'rate', v_rate)
      );

      v_updated_count := v_updated_count + 1;
    END IF;
  END LOOP;

  -- 8. Finalize Sync Run Status & Step Log
  UPDATE public.sync_runs
  SET finished_at = now(),
      status = CASE
        WHEN v_disc_count > 0 THEN 'completed_with_issues'
        ELSE 'completed'
      END,
      step_log = step_log || jsonb_build_object(
        'step', 'reconciliation_complete',
        'items_synced', v_updated_count,
        'new_stock_inwards', v_new_stock_count,
        'draft_items_created', v_new_drafts_count,
        'discrepancies_logged', v_disc_count,
        'completed_at', now()
      )
  WHERE id = p_run_id;

  RETURN jsonb_build_object(
    'success', true,
    'run_id', p_run_id,
    'items_synced', v_updated_count,
    'new_stock_inwards', v_new_stock_count,
    'draft_items_created', v_new_drafts_count,
    'discrepancies_count', v_disc_count
  );
END;
$$;

-- Log migration execution
INSERT INTO public.audit_log (actor, action, entity_type, metadata)
VALUES (
  'system',
  'phase2_discrepancy_workflow_migration_applied',
  'schema',
  jsonb_build_object(
    'migration', '20261016224500_phase2_discrepancy_workflow.sql',
    'functions_created', ARRAY['resolve_discrepancy', 'apply_sync_result']
  )
);
