-- Enable required extensions
create extension if not exists vector;
create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. Saree Catalog Table
-- ----------------------------------------------------------------------------
create table if not exists saree_catalog (
  id uuid primary key default gen_random_uuid(),
  sku text unique not null,
  name text not null,
  fabric text not null,
  weave_style text,
  color_primary text not null,
  color_secondary text,
  pattern text,
  border_type text,
  pallu_design text,
  occasion text[] default '{}',
  price numeric(10,2) not null,
  mrp numeric(10,2),
  stock_quantity integer not null default 1,
  description text,
  image_urls text[] default '{}',
  attributes_json jsonb default '{}'::jsonb,
  embedding vector(768),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Indexes for Saree Catalog
create index if not exists idx_saree_catalog_fabric on saree_catalog(fabric);
create index if not exists idx_saree_catalog_weave_style on saree_catalog(weave_style);
create index if not exists idx_saree_catalog_color_primary on saree_catalog(color_primary);
create index if not exists idx_saree_catalog_is_active on saree_catalog(is_active);
create index if not exists idx_saree_catalog_price on saree_catalog(price);

-- HNSW Vector Index for Cosine Similarity (Cosine distance ops)
create index if not exists idx_saree_catalog_embedding on saree_catalog using hnsw (embedding vector_cosine_ops);

-- ----------------------------------------------------------------------------
-- 2. Customers Table
-- ----------------------------------------------------------------------------
create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  phone_number text unique not null,
  name text,
  wa_id text,
  language text default 'en',
  address jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  last_active_at timestamptz not null default now()
);

create index if not exists idx_customers_phone on customers(phone_number);
create index if not exists idx_customers_wa_id on customers(wa_id);

-- ----------------------------------------------------------------------------
-- 3. Conversations Table
-- ----------------------------------------------------------------------------
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  state text not null default 'idle',
  context jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_conversations_customer_id on conversations(customer_id);
create index if not exists idx_conversations_state on conversations(state);

-- ----------------------------------------------------------------------------
-- 4. Messages Table
-- ----------------------------------------------------------------------------
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound')),
  message_type text not null default 'text',
  content text,
  media_url text,
  wa_message_id text unique,
  gemini_analysis jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_messages_conversation on messages(conversation_id);
create index if not exists idx_messages_wa_id on messages(wa_message_id);

-- ----------------------------------------------------------------------------
-- 5. Orders Table & Order Number Sequence
-- ----------------------------------------------------------------------------
create sequence if not exists order_number_seq start with 1001;

create or replace function generate_order_number()
returns text as $$
begin
  return 'SAI-' || nextval('order_number_seq')::text;
end;
$$ language plpgsql;

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  order_number text unique not null default generate_order_number(),
  customer_id uuid not null references customers(id),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled')),
  items jsonb not null default '[]'::jsonb,
  total_amount numeric(10,2) not null default 0.00,
  payment_status text not null default 'pending' check (payment_status in ('pending', 'paid', 'refunded')),
  payment_link text,
  shipping_address jsonb default '{}'::jsonb,
  tracking_number text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_orders_customer on orders(customer_id);
create index if not exists idx_orders_number on orders(order_number);
create index if not exists idx_orders_status on orders(status);

-- ----------------------------------------------------------------------------
-- 6. Image Analyses History Table
-- ----------------------------------------------------------------------------
create table if not exists image_analyses (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id),
  image_url text,
  gemini_response jsonb,
  extracted_attributes jsonb,
  embedding vector(768),
  matched_saree_ids uuid[] default '{}',
  created_at timestamptz not null default now()
);

create index if not exists idx_image_analyses_customer on image_analyses(customer_id);

-- ----------------------------------------------------------------------------
-- 7. App Config Table
-- ----------------------------------------------------------------------------
create table if not exists app_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Default configuration values
insert into app_config (key, value) values
  ('business_profile', '{
    "store_name": "Sai Traders",
    "tagline": "Exclusive Handcrafted & Designer Sarees",
    "contact_phone": "+91 98765 43210",
    "currency": "INR",
    "default_welcome_message": "Welcome to Sai Traders! 🌸\nWe are pleased to assist you with our exclusive collection of authentic sarees.\n\n✨ Send a photo of any saree you love, and I will find matching designs from our collection!\n✨ Or type what you are looking for (e.g., \"Banarasi silk sarees under ₹6000\")."
  }'::jsonb),
  ('whatsapp_settings', '{
    "auto_reply": true,
    "similarity_threshold": 0.35,
    "max_recommendations": 3
  }'::jsonb)
on conflict (key) do nothing;

-- ----------------------------------------------------------------------------
-- 8. Vector Similarity Match Function
-- ----------------------------------------------------------------------------
create or replace function match_sarees(
  query_embedding vector(768),
  match_threshold float default 0.30,
  match_count int default 4,
  filter_active boolean default true
)
returns table (
  id uuid,
  sku text,
  name text,
  fabric text,
  weave_style text,
  color_primary text,
  color_secondary text,
  pattern text,
  border_type text,
  pallu_design text,
  occasion text[],
  price numeric(10,2),
  mrp numeric(10,2),
  stock_quantity integer,
  description text,
  image_urls text[],
  attributes_json jsonb,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    s.id,
    s.sku,
    s.name,
    s.fabric,
    s.weave_style,
    s.color_primary,
    s.color_secondary,
    s.pattern,
    s.border_type,
    s.pallu_design,
    s.occasion,
    s.price,
    s.mrp,
    s.stock_quantity,
    s.description,
    s.image_urls,
    s.attributes_json,
    (1 - (s.embedding <=> query_embedding))::float as similarity
  from saree_catalog s
  where (not filter_active or s.is_active = true)
    and s.embedding is not null
    and (1 - (s.embedding <=> query_embedding)) >= match_threshold
  order by s.embedding <=> query_embedding asc
  limit match_count;
end;
$$;

-- ----------------------------------------------------------------------------
-- 9. Storage Buckets Setup
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('saree-catalog-images', 'saree-catalog-images', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('customer-media', 'customer-media', false)
on conflict (id) do nothing;

-- Storage public read policy for catalog images
create policy "Catalog images are publicly accessible"
  on storage.objects for select
  using (bucket_id = 'saree-catalog-images');

-- ----------------------------------------------------------------------------
-- 10. Initial Seed Catalog Data
-- ----------------------------------------------------------------------------
insert into saree_catalog (
  sku, name, fabric, weave_style, color_primary, color_secondary, pattern,
  border_type, pallu_design, occasion, price, mrp, stock_quantity, description,
  image_urls, attributes_json
) values
(
  'SAI-KANJ-01',
  'Crimson Regal Kanjivaram Silk Saree',
  'Pure Mulberry Silk',
  'Kanjivaram',
  'Crimson Red',
  'Antique Gold',
  'Traditional Peacock & Floral Buta',
  'Broad Zari Temple Border',
  'Heavy Gold Zari Pallu with intricate Mayil (peacock) and Rudraksha motifs',
  ARRAY['wedding', 'bridal', 'festive'],
  12500.00,
  15999.00,
  4,
  'Authentic handwoven Kanchipuram pure silk saree in radiant crimson red with rich pure gold zari work. Comes with unstitched contrast brocade blouse piece.',
  ARRAY['https://images.unsplash.com/photo-1610030469983-98e550d6193c?auto=format&fit=crop&w=800&q=80'],
  '{
    "fabric": "Pure Mulberry Silk",
    "weave_style": "Kanjivaram",
    "color_primary": "Crimson Red",
    "color_secondary": "Antique Gold",
    "pattern": "Traditional Peacock & Floral Buta",
    "border_type": "Broad Zari Temple Border",
    "pallu_design": "Heavy Gold Zari Pallu with Mayil and Rudraksha motifs",
    "occasion": ["wedding", "bridal", "festive"],
    "blouse_included": true
  }'::jsonb
),
(
  'SAI-BAN-02',
  'Royal Sapphire Banarasi Katan Silk Saree',
  'Katan Silk',
  'Banarasi',
  'Royal Blue',
  'Gold Zari',
  'Intricate Floral Jaal with Meenakari accents',
  'Fine Zari Border with Floral Vines',
  'Elaborate Shikargah style zari pallu with rich meenakari work',
  ARRAY['wedding', 'reception', 'party', 'festive'],
  8999.00,
  11500.00,
  5,
  'Exquisite Banarasi Katan pure silk saree featuring all-over Kadwa gold zari floral jaal with delicate meenakari highlights. Luxurious sheen and royal drape.',
  ARRAY['https://images.unsplash.com/photo-1617627143750-d86bc21e42bb?auto=format&fit=crop&w=800&q=80'],
  '{
    "fabric": "Katan Silk",
    "weave_style": "Banarasi",
    "color_primary": "Royal Blue",
    "color_secondary": "Gold Zari",
    "pattern": "Intricate Floral Jaal with Meenakari accents",
    "border_type": "Fine Zari Border with Floral Vines",
    "pallu_design": "Elaborate Shikargah style zari pallu",
    "occasion": ["wedding", "reception", "party", "festive"],
    "blouse_included": true
  }'::jsonb
),
(
  'SAI-BAN-03',
  'Marigold Sunburst Bandhani Georgette Saree',
  'Pure Georgette',
  'Bandhani',
  'Mustard Yellow',
  'Vermilion Red',
  'Hand-tied Traditional Bandhej Dots',
  'Gota Patti & Zari Contrast Border',
  'Heavy Bandhej Pallu with Gota Patti craft work',
  ARRAY['festive', 'haldi', 'puja', 'casual festive'],
  4750.00,
  6200.00,
  8,
  'Authentic handcrafted Rajasthani Bandhani saree on pure breathable georgette. Vibrant haldi mustard hue with traditional Gharchola borders and hand-knotted motifs.',
  ARRAY['https://images.unsplash.com/photo-1583391733956-3750e0ff4e8b?auto=format&fit=crop&w=800&q=80'],
  '{
    "fabric": "Pure Georgette",
    "weave_style": "Bandhani",
    "color_primary": "Mustard Yellow",
    "color_secondary": "Vermilion Red",
    "pattern": "Hand-tied Traditional Bandhej Dots",
    "border_type": "Gota Patti & Zari Contrast Border",
    "pallu_design": "Heavy Bandhej Pallu with Gota Patti craft work",
    "occasion": ["festive", "haldi", "puja", "casual festive"],
    "blouse_included": true
  }'::jsonb
),
(
  'SAI-CHAN-04',
  'Pastel Mint Whisper Chanderi Silk Cotton Saree',
  'Chanderi Silk Cotton',
  'Chanderi',
  'Mint Green',
  'Silver Zari',
  'Delicate Ashrafi Butis',
  'Sleek Silver Zari Border',
  'Striped Silver Zari Pallu with Floral Fringes',
  ARRAY['office', 'casual', 'day events', 'festive'],
  3200.00,
  4500.00,
  10,
  'Ultra-lightweight handwoven Chanderi saree blending fine silk and cotton. Subtle mint green tone with soft silver zari butis, ideal for daytime elegance and summer festivities.',
  ARRAY['https://images.unsplash.com/photo-1609357605129-26f69add5d6e?auto=format&fit=crop&w=800&q=80'],
  '{
    "fabric": "Chanderi Silk Cotton",
    "weave_style": "Chanderi",
    "color_primary": "Mint Green",
    "color_secondary": "Silver Zari",
    "pattern": "Delicate Ashrafi Butis",
    "border_type": "Sleek Silver Zari Border",
    "pallu_design": "Striped Silver Zari Pallu with Floral Fringes",
    "occasion": ["office", "casual", "day events", "festive"],
    "blouse_included": true
  }'::jsonb
),
(
  'SAI-ORG-05',
  'Blush Rose Handpainted Organza Silk Saree',
  'Pure Organza Silk',
  'Designer Modern',
  'Blush Pink',
  'Rose Gold',
  'Handpainted French Floral Peonies',
  'Scalloped Cutwork Border with Pearl Embroidery',
  'Fluid Sheer Organza Pallu with handpainted blossoms',
  ARRAY['cocktail', 'party', 'engagement', 'day wedding'],
  5600.00,
  7400.00,
  6,
  'Ethereal pure organza saree in blush pink, adorned with artistic handpainted floral blooms and scalloped zari and thread borders with subtle pearl highlights.',
  ARRAY['https://images.unsplash.com/photo-1594744803329-e58b31de8bf5?auto=format&fit=crop&w=800&q=80'],
  '{
    "fabric": "Pure Organza Silk",
    "weave_style": "Designer Modern",
    "color_primary": "Blush Pink",
    "color_secondary": "Rose Gold",
    "pattern": "Handpainted French Floral Peonies",
    "border_type": "Scalloped Cutwork Border with Pearl Embroidery",
    "pallu_design": "Fluid Sheer Organza Pallu with handpainted blossoms",
    "occasion": ["cocktail", "party", "engagement", "day wedding"],
    "blouse_included": true
  }'::jsonb
),
(
  'SAI-PAT-06',
  'Heritage Double Ikat Patola Silk Saree',
  'Pure Mulberry Silk',
  'Patan Patola',
  'Deep Maroon',
  'Emerald Green',
  'Geometric Shikari Vow (Elephants, Parrots, & Florals)',
  'Traditional Red Contrast Border with Zari Pinstripes',
  'Elaborate Patola Weave Pallu with Traditional Motifs',
  ARRAY['wedding', 'heritage', 'festive', 'traditional'],
  14800.00,
  18500.00,
  3,
  'Masterpiece double ikat Patola saree crafted by master weavers. Features timeless geometric motifs of elephants, peacocks, and floral chakras in rich crimson maroon and emerald green.',
  ARRAY['https://images.unsplash.com/photo-1610030469668-932ec596e7fa?auto=format&fit=crop&w=800&q=80'],
  '{
    "fabric": "Pure Mulberry Silk",
    "weave_style": "Patan Patola",
    "color_primary": "Deep Maroon",
    "color_secondary": "Emerald Green",
    "pattern": "Geometric Shikari Vow",
    "border_type": "Traditional Red Contrast Border with Zari Pinstripes",
    "pallu_design": "Elaborate Patola Weave Pallu with Traditional Motifs",
    "occasion": ["wedding", "heritage", "festive", "traditional"],
    "blouse_included": true
  }'::jsonb
)
on conflict (sku) do nothing;
