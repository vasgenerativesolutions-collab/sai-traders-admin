-- ==============================================================================
-- Sai Traders — Phase 1 Database Migration (v3)
-- Additive Schema, Stock Accounting, Dual Embeddings & Admin Master Data
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Saree Catalog Additive Extensions
-- ------------------------------------------------------------------------------

-- 1.1 Product lifecycle status
ALTER TABLE saree_catalog
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'listed'
    CHECK (status IN ('pending_listing', 'listed', 'unlisted'));

-- Backfill existing rows as 'listed'
UPDATE saree_catalog SET status = 'listed' WHERE status IS NULL OR status = 'listed';

-- Now alter default so future imports (Tally sync) land as 'pending_listing'
ALTER TABLE saree_catalog ALTER COLUMN status SET DEFAULT 'pending_listing';

-- 1.2 Canonical product code = Tally Part Number
ALTER TABLE saree_catalog
  ADD COLUMN IF NOT EXISTS tally_part_number text;

-- Provisionally backfill from sku where not set
UPDATE saree_catalog SET tally_part_number = sku WHERE tally_part_number IS NULL;

-- Enforce unique index on canonical product code
CREATE UNIQUE INDEX IF NOT EXISTS idx_saree_catalog_tally_part_number
  ON saree_catalog(tally_part_number) WHERE tally_part_number IS NOT NULL;

-- 1.3 Side-by-side embedding_v2 column (gemini-embedding-2)
ALTER TABLE saree_catalog
  ADD COLUMN IF NOT EXISTS embedding_v2 vector(768);

CREATE INDEX IF NOT EXISTS idx_saree_catalog_embedding_v2
  ON saree_catalog USING hnsw (embedding_v2 vector_cosine_ops);

-- 1.4 Embedding provenance columns
ALTER TABLE saree_catalog
  ADD COLUMN IF NOT EXISTS embedding_model text,
  ADD COLUMN IF NOT EXISTS embedding_dim integer;

CREATE INDEX IF NOT EXISTS idx_saree_catalog_status ON saree_catalog(status);

-- ------------------------------------------------------------------------------
-- 2. Customers Table Extensions
-- ------------------------------------------------------------------------------

-- Ensure unique record per phone number
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_phone_unique ON customers(phone_number);

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS source_channel text DEFAULT 'whatsapp'
    CHECK (source_channel IN ('whatsapp', 'web')),
  ADD COLUMN IF NOT EXISTS wa_optin_status text DEFAULT 'implicit'
    CHECK (wa_optin_status IN ('implicit', 'explicit', 'opted_out')),
  ADD COLUMN IF NOT EXISTS wa_optin_at timestamptz,
  ADD COLUMN IF NOT EXISTS wa_optin_source text,
  ADD COLUMN IF NOT EXISTS phone_verified boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz;

-- ------------------------------------------------------------------------------
-- 3. Orders Table Extensions & Status Expansion
-- ------------------------------------------------------------------------------

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS channel text DEFAULT 'whatsapp'
    CHECK (channel IN ('whatsapp', 'web')),
  ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS wa_optin_at_checkout timestamptz;

-- Recreate orders_status_check constraint with complete lifecycle statuses
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;

ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN (
    'pending',                -- draft / order initiated
    'confirmed',              -- legacy / direct order confirmed
    'packed',                 -- packed in store
    'shipped',                -- handed to logistics
    'delivered',              -- delivered to customer
    'cancelled',              -- cancelled prior to payment
    'paid_pending_approval',  -- payment verified, awaiting owner batch approval
    'approved',               -- owner approved, queued for Tally voucher push
    'rejected',               -- owner rejected, queued for automated refund
    'posted_to_tally',        -- XML Sales Voucher committed to TallyPrime
    'post_failed',            -- Tally voucher push failed; retryable
    'dispatched'              -- handed over to local/express courier
  ));

-- ------------------------------------------------------------------------------
-- 4. Stock Pool & Centralized Availability View
-- ------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS stock_pool (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_code            text        NOT NULL UNIQUE, -- matches tally_part_number
  saree_id                uuid        REFERENCES saree_catalog(id) ON DELETE SET NULL,
  online_quantity         integer     NOT NULL DEFAULT 0,
  held_quantity           integer     NOT NULL DEFAULT 0,
  sold_pending_quantity   integer     NOT NULL DEFAULT 0,
  -- sold_pending_quantity: units in orders with status IN ('paid_pending_approval', 'approved', 'post_failed')
  -- prevents the morning Tally fetch from re-exposing sarees sold online but not yet posted to Tally

  source                  text        NOT NULL DEFAULT 'tally_godown'
                                      CHECK (source IN ('tally_godown', 'admin_entered')),
  tally_godown            text        DEFAULT 'Online',
  last_synced_at          timestamptz,
  sync_clamp_warning      boolean     DEFAULT false,
  -- Clamping: If Tally's count drops below (held + sold_pending), sync clamps and sets warning true.
  -- NO hard CHECK (online_quantity >= held_quantity) to prevent sync crashes.

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_pool_saree_id ON stock_pool(saree_id);

-- Seed stock_pool from current saree_catalog if empty
INSERT INTO stock_pool (product_code, saree_id, online_quantity, held_quantity, sold_pending_quantity)
SELECT
  sc.tally_part_number,
  sc.id,
  COALESCE(sc.stock_quantity, 0),
  0,
  0
FROM saree_catalog sc
WHERE sc.tally_part_number IS NOT NULL
ON CONFLICT (product_code) DO NOTHING;

-- Centralized availability view: Single Source of Truth for WhatsApp, Website & Admin
CREATE OR REPLACE VIEW available_stock AS
SELECT
  sp.product_code,
  sp.saree_id,
  sp.online_quantity,
  sp.held_quantity,
  sp.sold_pending_quantity,
  GREATEST(0, sp.online_quantity - sp.held_quantity - sp.sold_pending_quantity) AS available_quantity,
  CASE
    WHEN (sp.online_quantity - sp.held_quantity - sp.sold_pending_quantity) > 0 THEN 'in_stock'
    WHEN sp.held_quantity > 0 AND (sp.online_quantity - sp.sold_pending_quantity) > 0 THEN 'being_booked'
    ELSE 'out_of_stock'
  END AS availability_status,
  sp.source,
  sp.tally_godown,
  sp.sync_clamp_warning,
  sp.last_synced_at,
  sc.name,
  sc.price,
  sc.status AS listing_status,
  sc.image_urls
FROM stock_pool sp
LEFT JOIN saree_catalog sc ON sc.tally_part_number = sp.product_code;

-- ------------------------------------------------------------------------------
-- 5. Cross-Channel Hold Table
-- ------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS hold (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_code    text        NOT NULL,
  saree_id        uuid        REFERENCES saree_catalog(id) ON DELETE SET NULL,
  customer_id     uuid        REFERENCES customers(id) ON DELETE CASCADE,
  quantity        integer     NOT NULL DEFAULT 1,
  state           text        NOT NULL DEFAULT 'held'
                              CHECK (state IN ('held', 'paid', 'released', 'expired')),
  channel         text        NOT NULL DEFAULT 'whatsapp'
                              CHECK (channel IN ('whatsapp', 'web')),
  expires_at      timestamptz NOT NULL, -- now() + 10 mins
  grace_until     timestamptz NOT NULL, -- expires_at + 2 mins
  payment_ref     text,
  order_id        uuid        REFERENCES orders(id) ON DELETE SET NULL,
  idempotency_key text        UNIQUE,
  client_ip       text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  released_at     timestamptz,
  paid_at         timestamptz
);

CREATE INDEX IF NOT EXISTS idx_hold_lookup ON hold(product_code, state);
CREATE INDEX IF NOT EXISTS idx_hold_customer ON hold(customer_id, state);
CREATE INDEX IF NOT EXISTS idx_hold_expiry ON hold(expires_at) WHERE state = 'held';
CREATE INDEX IF NOT EXISTS idx_hold_client_ip ON hold(client_ip) WHERE state = 'held';

-- ------------------------------------------------------------------------------
-- 6. Video Records & Saree Frames (Dual Multimodal Embeddings)
-- ------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS video_record (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id                text        NOT NULL UNIQUE,
  product_code            text        NOT NULL, -- references saree_catalog.tally_part_number
  source                  text        CHECK (source IN ('instagram', 'youtube', 'studio', 'direct_upload')),
  source_url              text,
  saree                   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  distinguishing_features text[],
  confusable_with         text[],
  reference_frames        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  ignore_in_matching      text[],
  gemini_draft            jsonb,
  verified                boolean     NOT NULL DEFAULT false,
  verified_by             text,
  verified_at             timestamptz,
  review_notes            text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_video_record_product_code ON video_record(product_code);
CREATE INDEX IF NOT EXISTS idx_video_record_verified ON video_record(verified);

CREATE TABLE IF NOT EXISTS saree_frame (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id        text        NOT NULL REFERENCES video_record(video_id) ON DELETE CASCADE,
  product_code    text        NOT NULL,
  timestamp_sec   float,
  crop_box        jsonb,
  attrs           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  image_emb       vector(768),
  text_emb        vector(768),
  embedding_model text        DEFAULT 'gemini-embedding-2',
  embedding_dim   integer     DEFAULT 768,
  verified        boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_saree_frame_image_emb ON saree_frame USING hnsw (image_emb vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_saree_frame_text_emb ON saree_frame USING hnsw (text_emb vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_saree_frame_product ON saree_frame(product_code);

-- ------------------------------------------------------------------------------
-- 7. Refund Queue (Financial Integrity: ON DELETE RESTRICT)
-- ------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS refund_queue (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid        NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  -- MUST FIX #6: Deleting an order must NEVER delete a financial record
  amount          numeric(10,2) NOT NULL,
  payment_ref     text,
  reason          text        NOT NULL, -- 'owner_rejected', 'out_of_stock_clamped', 'customer_cancelled'
  status          text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  razorpay_refund_id text,
  error_message   text,
  resolved_by     text,
  resolved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refund_queue_status ON refund_queue(status);
CREATE INDEX IF NOT EXISTS idx_refund_queue_order ON refund_queue(order_id);

-- ------------------------------------------------------------------------------
-- 8. Handoff Queue, Audit Logging & Tally Sync Logs
-- ------------------------------------------------------------------------------

-- Handoff Queue (Captures human-intervention cases)
CREATE TABLE IF NOT EXISTS handoff_queue (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     uuid        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  conversation_id uuid        REFERENCES conversations(id) ON DELETE SET NULL,
  channel         text        NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'web')),
  reason          text        NOT NULL, -- 'direct_order_flag_off', 'low_confidence', 'bulk_buyer', 'customer_request'
  context         jsonb       DEFAULT '{}'::jsonb,
  status          text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'assigned', 'resolved')),
  assigned_to     text,
  resolved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_handoff_queue_status ON handoff_queue(status);

-- Audit Log Table & Helper Function
CREATE TABLE IF NOT EXISTS audit_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor           text        NOT NULL, -- 'admin:<user>', 'system', 'agent', 'webhook'
  action          text        NOT NULL, -- 'verify_video', 'list_product', 'change_stock_source', 'order_approved'
  entity_type     text        NOT NULL, -- 'video_record', 'saree_catalog', 'stock_pool', 'orders'
  entity_id       text,
  old_values      jsonb,
  new_values      jsonb,
  metadata        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);

CREATE OR REPLACE FUNCTION write_audit_log(
  p_actor text,
  p_action text,
  p_entity_type text,
  p_entity_id text DEFAULT NULL,
  p_old_values jsonb DEFAULT NULL,
  p_new_values jsonb DEFAULT NULL,
  p_metadata jsonb DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO audit_log (actor, action, entity_type, entity_id, old_values, new_values, metadata)
  VALUES (p_actor, p_action, p_entity_type, p_entity_id, p_old_values, p_new_values, p_metadata)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Tally Sync Log
CREATE TABLE IF NOT EXISTS tally_sync_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  direction       text        NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  entity_type     text        NOT NULL, -- 'stock_summary', 'sales_voucher'
  entity_ref      text,
  payload_hash    text,
  result          text        NOT NULL CHECK (result IN ('success', 'error', 'clamped')),
  error_message   text,
  raw_request     text,
  raw_response    text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tally_sync_log_result ON tally_sync_log(result, created_at DESC);

-- ------------------------------------------------------------------------------
-- 9. Admin Option Lists & Web Policies
-- ------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS option_lists (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  category      text        NOT NULL,
  value         text        NOT NULL,
  display_order integer     DEFAULT 0,
  is_active     boolean     DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE(category, value)
);
CREATE INDEX IF NOT EXISTS idx_option_lists_cat ON option_lists(category, display_order) WHERE is_active = true;

-- Seed initial master option lists (Starter set — reviewable by owner)
INSERT INTO option_lists (category, value, display_order) VALUES
  ('fabric', 'Pure Mulberry Silk', 1),
  ('fabric', 'Katan Silk', 2),
  ('fabric', 'Pure Georgette', 3),
  ('fabric', 'Chanderi Silk Cotton', 4),
  ('fabric', 'Pure Organza Silk', 5),
  ('fabric', 'Tussar Silk', 6),
  ('fabric', 'Linen', 7),
  ('fabric', 'Crepe', 8),
  ('fabric', 'Chiffon', 9),
  ('fabric', 'Pure Cotton', 10),
  ('weave_style', 'Kanjivaram', 1),
  ('weave_style', 'Banarasi', 2),
  ('weave_style', 'Bandhani', 3),
  ('weave_style', 'Chanderi', 4),
  ('weave_style', 'Patola', 5),
  ('weave_style', 'Paithani', 6),
  ('weave_style', 'Pochampally Ikat', 7),
  ('weave_style', 'Chikankari', 8),
  ('weave_style', 'Designer Modern', 9),
  ('color', 'Crimson Red', 1),
  ('color', 'Royal Blue', 2),
  ('color', 'Mustard Yellow', 3),
  ('color', 'Emerald Green', 4),
  ('color', 'Blush Pink', 5),
  ('color', 'Deep Maroon', 6),
  ('color', 'Mint Green', 7),
  ('color', 'Navy Blue', 8),
  ('color', 'Ivory White', 9),
  ('color', 'Antique Gold', 10),
  ('color', 'Silver', 11),
  ('color', 'Rose Gold', 12),
  ('color', 'Peacock Teal', 13),
  ('color', 'Lavender', 14),
  ('color', 'Coral', 15),
  ('border', 'Broad Zari Temple Border', 1),
  ('border', 'Fine Zari Border with Floral Vines', 2),
  ('border', 'Gota Patti & Zari Contrast Border', 3),
  ('border', 'Sleek Silver Zari Border', 4),
  ('border', 'Scalloped Cutwork Border', 5),
  ('border', 'Traditional Contrast Border', 6),
  ('border', 'Thread Work Border', 7),
  ('pattern', 'Traditional Peacock & Floral Buta', 1),
  ('pattern', 'Floral Jaal', 2),
  ('pattern', 'Hand-tied Bandhej Dots', 3),
  ('pattern', 'Delicate Ashrafi Butis', 4),
  ('pattern', 'Handpainted Florals', 5),
  ('pattern', 'Geometric', 6),
  ('pattern', 'Stripes', 7),
  ('pattern', 'Checks', 8),
  ('pattern', 'Plain/Solid', 9),
  ('work_type', 'Zari Work', 1),
  ('work_type', 'Meenakari', 2),
  ('work_type', 'Gota Patti', 3),
  ('work_type', 'Chikankari', 4),
  ('work_type', 'Aari/Zardozi', 5),
  ('work_type', 'Handpainted', 6),
  ('work_type', 'Block Print', 7),
  ('work_type', 'Sequin/Mirror', 8),
  ('work_type', 'Thread Embroidery', 9),
  ('occasion', 'Wedding', 1),
  ('occasion', 'Bridal', 2),
  ('occasion', 'Festive', 3),
  ('occasion', 'Reception', 4),
  ('occasion', 'Party', 5),
  ('occasion', 'Casual', 6),
  ('occasion', 'Office', 7),
  ('occasion', 'Engagement', 8),
  ('occasion', 'Haldi', 9),
  ('occasion', 'Puja', 10)
ON CONFLICT (category, value) DO NOTHING;

-- Web policies editable from admin
CREATE TABLE IF NOT EXISTS web_policies (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_key    text        NOT NULL UNIQUE, -- 'refund_exchange', 'privacy', 'terms', 'cookies'
  title         text        NOT NULL,
  content_html  text        NOT NULL,
  version       integer     NOT NULL DEFAULT 1,
  updated_by    text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO web_policies (policy_key, title, content_html) VALUES
  ('refund_exchange', 'Refund and Exchange Policy', '<p>Sai Traders offers refunds on pre-authorized cancellations and human-verified order rejections within 7 business days.</p>'),
  ('privacy', 'Privacy Policy', '<p>We protect customer phone numbers, delivery addresses, and WhatsApp conversation state under strict confidentiality.</p>'),
  ('terms', 'Terms of Service', '<p>Orders placed via WhatsApp or Website are subject to inventory verification and confirmation before dispatch.</p>'),
  ('cookies', 'Cookie Policy', '<p>Our website uses necessary session cookies for checkout cart and hold state.</p>')
ON CONFLICT (policy_key) DO NOTHING;

-- ------------------------------------------------------------------------------
-- 10. WhatsApp Template Registry
-- ------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS wa_template_registry (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  template_name    text        NOT NULL UNIQUE,
  purpose          text        NOT NULL, -- 'rejection_apology', 'refund_processed', 'delivery_update', 'bulk_followup'
  language         text        NOT NULL DEFAULT 'en',
  category         text        NOT NULL DEFAULT 'UTILITY',
  approval_status  text        NOT NULL DEFAULT 'draft' CHECK (approval_status IN ('draft', 'submitted', 'approved', 'rejected')),
  meta_template_id text,
  template_body    text        NOT NULL,
  variables        text[],
  fallback_action  text        DEFAULT 'alert_human',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

INSERT INTO wa_template_registry (template_name, purpose, language, category, template_body, fallback_action) VALUES
  ('sai_rejection_apology', 'rejection_apology', 'en', 'UTILITY', 
   'Dear {{1}}, we apologize that Saree {{2}} in order {{3}} is currently unavailable. A full refund of ₹{{4}} has been initiated.', 'alert_human'),
  ('sai_refund_processed', 'refund_processed', 'en', 'UTILITY',
   'Hello {{1}}, your refund of ₹{{2}} for order {{3}} has been processed. Transaction reference: {{4}}.', 'alert_human'),
  ('sai_delivery_update', 'delivery_update', 'en', 'UTILITY',
   'Namaste {{1}}! Your saree order {{2}} has been dispatched via {{3}}. Tracking link: {{4}}.', 'alert_human'),
  ('sai_bulk_followup', 'bulk_followup', 'en', 'UTILITY',
   'Hello {{1}}, thank you for your bulk inquiry with Sai Traders. Our merchant specialist will assist you on this chat shortly.', 'alert_human'),
  ('sai_order_received', 'order_confirmation', 'en', 'UTILITY',
   'Namaste {{1}}! We have received your order {{2}} for ₹{{3}}. Our master stylist is reviewing your selection.', 'alert_human')
ON CONFLICT (template_name) DO NOTHING;

-- ------------------------------------------------------------------------------
-- 11. Vector Similarity Match Function (v2)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION match_sarees_v2(
  query_embedding vector(768),
  match_threshold float DEFAULT 0.25, -- preserves existing threshold default
  match_count int DEFAULT 4,
  filter_listed boolean DEFAULT true
)
RETURNS TABLE (
  id uuid, sku text, name text, fabric text, weave_style text,
  color_primary text, color_secondary text, pattern text, border_type text,
  pallu_design text, occasion text[], price numeric(10,2), mrp numeric(10,2),
  stock_quantity integer, description text, image_urls text[],
  attributes_json jsonb, tally_part_number text, similarity float
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.id, s.sku, s.name, s.fabric, s.weave_style,
    s.color_primary, s.color_secondary, s.pattern, s.border_type,
    s.pallu_design, s.occasion, s.price, s.mrp,
    s.stock_quantity, s.description, s.image_urls,
    s.attributes_json, s.tally_part_number,
    (1 - (s.embedding_v2 <=> query_embedding))::float AS similarity
  FROM saree_catalog s
  WHERE s.embedding_v2 IS NOT NULL
    AND (NOT filter_listed OR (s.is_active = true AND s.status = 'listed'))
    AND (1 - (s.embedding_v2 <=> query_embedding)) >= match_threshold
  ORDER BY s.embedding_v2 <=> query_embedding ASC
  LIMIT match_count;
END;
$$;

-- ------------------------------------------------------------------------------
-- 12. Listing Gatekeeper Function & Database Trigger
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION check_can_list_product(p_saree_id uuid)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_saree RECORD;
  v_has_photo boolean;
  v_has_price boolean;
  v_has_name boolean;
  v_has_verified_video boolean;
  v_can_list boolean;
  v_reasons text[] := '{}';
BEGIN
  SELECT * INTO v_saree FROM saree_catalog WHERE id = p_saree_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('can_list', false, 'reasons', ARRAY['Product not found']);
  END IF;

  v_has_name := v_saree.name IS NOT NULL AND trim(v_saree.name) != '';
  v_has_price := v_saree.price IS NOT NULL AND v_saree.price > 0;
  v_has_photo := v_saree.image_urls IS NOT NULL AND array_length(v_saree.image_urls, 1) > 0;

  SELECT EXISTS(
    SELECT 1 FROM video_record
    WHERE product_code = v_saree.tally_part_number AND verified = true
  ) INTO v_has_verified_video;

  v_can_list := v_has_name AND v_has_price AND v_has_photo AND v_has_verified_video;

  IF NOT v_has_name THEN v_reasons := array_append(v_reasons, 'Missing product name'); END IF;
  IF NOT v_has_price THEN v_reasons := array_append(v_reasons, 'Missing retail price'); END IF;
  IF NOT v_has_photo THEN v_reasons := array_append(v_reasons, 'Missing high-resolution photos'); END IF;
  IF NOT v_has_verified_video THEN v_reasons := array_append(v_reasons, 'No verified video record'); END IF;

  RETURN jsonb_build_object('can_list', v_can_list, 'reasons', v_reasons);
END;
$$;

-- Trigger enforcing listing rules on UPDATE of status
CREATE OR REPLACE FUNCTION trg_enforce_listing_rules()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_check jsonb;
BEGIN
  IF NEW.status = 'listed' AND (OLD.status IS DISTINCT FROM 'listed') THEN
    v_check := check_can_list_product(NEW.id);
    IF NOT (v_check->>'can_list')::boolean THEN
      RAISE EXCEPTION 'Cannot list product %: %', NEW.sku, v_check->>'reasons';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_saree_catalog_listing_guard ON saree_catalog;

CREATE TRIGGER trg_saree_catalog_listing_guard
  BEFORE UPDATE OF status ON saree_catalog
  FOR EACH ROW
  EXECUTE FUNCTION trg_enforce_listing_rules();

-- ------------------------------------------------------------------------------
-- 13. System Configuration Entries in app_config
-- ------------------------------------------------------------------------------

INSERT INTO app_config (key, value) VALUES
  ('feature_flags', '{
    "direct_order_enabled": false,
    "approval_flow_enabled": false,
    "payment_enabled": false
  }'::jsonb),

  ('embedding_config', '{
    "active_model": "gemini-embedding-001",
    "active_column": "embedding",
    "v2_model": "gemini-embedding-2",
    "v2_column": "embedding_v2",
    "dimension": 768,
    "task_type_document": "RETRIEVAL_DOCUMENT",
    "task_type_query": "RETRIEVAL_QUERY",
    "migration_status": "pending",
    "notes": "Switch active_model/active_column to v2 after re-embedding verification"
  }'::jsonb),

  ('stock_config', '{
    "source": "tally_godown",
    "tally_godown_name": "Online",
    "notes": "Reads closing balance of Online godown as online pool"
  }'::jsonb),

  ('matching_thresholds', '{
    "image_match_threshold": 0.25,
    "text_match_threshold": 0.22,
    "similar_saree_threshold": 0.15,
    "image_weight": 0.6,
    "text_weight": 0.4,
    "calibration_status": "UNCALIBRATED",
    "notes": "All thresholds are placeholders. Must not go live until eval set calibrates them."
  }'::jsonb),

  ('abuse_limits', '{
    "max_active_holds_per_customer": 2,
    "max_active_holds_per_ip": 2,
    "hold_duration_minutes": 10,
    "hold_grace_minutes": 2,
    "rate_limit_holds_per_minute": 3
  }'::jsonb),

  ('go_live_gates', '{
    "eval_set_calibrated": false,
    "tally_part_numbers_verified": false,
    "embedding_v2_migrated": false,
    "wa_templates_approved": false,
    "razorpay_linked": false,
    "owner_final_approval": false
  }'::jsonb)

ON CONFLICT (key) DO NOTHING;

-- ------------------------------------------------------------------------------
-- 14. Row Level Security (RLS) Enforcements
-- ------------------------------------------------------------------------------

ALTER TABLE stock_pool ENABLE ROW LEVEL SECURITY;
ALTER TABLE hold ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE saree_frame ENABLE ROW LEVEL SECURITY;
ALTER TABLE refund_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_sync_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE handoff_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE option_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE web_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_template_registry ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS by default.
-- Anonymous and Authenticated users have read access only to public option lists & published web policies.
DROP POLICY IF EXISTS "Public read active option lists" ON option_lists;
CREATE POLICY "Public read active option lists" ON option_lists
  FOR SELECT TO anon, authenticated USING (is_active = true);

DROP POLICY IF EXISTS "Public read published policies" ON web_policies;
CREATE POLICY "Public read published policies" ON web_policies
  FOR SELECT TO anon, authenticated USING (true);
