# 🧵 Sai Traders — WhatsApp Saree Intelligence Bot

An AI-powered WhatsApp Commerce & Visual Search bot built with **Supabase**, **Google Gemini 2.5 Flash**, **pgvector**, and **Meta WhatsApp Business Cloud API**.

---

## 🌟 How It Works

1. **Customer sends a photo** of any saree they liked (from Pinterest, Instagram, or a wedding).
2. **Sai AI analyzes the photo**:
   - Fabric identification (Pure Silk, Katan Silk, Georgette, Organza, Chanderi, etc.)
   - Weave & Craft style (Kanjivaram, Banarasi, Bandhani, Patola, etc.)
   - Color palette & accents (Primary, Secondary, Gold/Silver Zari)
   - Pattern & Motifs (Peacock butis, Shikargah, Floral jaal, Bandhej dots)
   - Border & Pallu craftsmanship (Temple borders, Cutwork, Gota patti)
   - Occasion suitability & estimated retail price in INR
3. **pgvector similarity search** queries the `saree_catalog` using 768-dimensional embeddings to find the closest matching sarees in stock.
4. **Interactive WhatsApp catalog cards** are sent back with photos, prices, stock status, and select buttons.
5. **Full conversational order placement**: Customer selects a saree → provides delivery address → receives confirmed order number (`SAI-1001`) with delivery tracking.

---

## 📁 Repository Structure

```
c:\sai_traders\
├── .env.example                               # All environment variables template
├── README.md                                  # Setup & deployment guide
├── scripts/
│   └── simulate_saree_flow.js                 # Local simulation script
└── supabase/
    ├── config.toml                            # Supabase CLI configuration
    ├── migrations/
    │   └── 20260928060239_init_saree_bot.sql  # Complete schema, pgvector, seed sarees
    └── functions/
        ├── _shared/
        │   ├── supabase-client.ts             # Admin Supabase client helper
        │   ├── whatsapp.ts                    # Meta Cloud API (Text, Image, Buttons, Media)
        │   └── gemini.ts                      # Gemini 2.5 Flash Vision & text-embedding-004
        ├── whatsapp-webhook/                  # Main WhatsApp webhook handler
        │   └── index.ts
        ├── catalog-manage/                    # Saree catalog CRUD with auto-embeddings
        │   └── index.ts
        └── generate-embeddings/               # Batch vector embedding utility
            └── index.ts
```

---

## 🚀 Setup & Deployment Guide

### 1. Database Setup (Supabase)

1. Go to your [Supabase Dashboard](https://supabase.com/dashboard) and create a new project (e.g. `sai-traders-saree-bot`).
2. Navigate to **SQL Editor** in your Supabase dashboard.
3. Open and run the migration script:
   [`supabase/migrations/20260928060239_init_saree_bot.sql`](file:///c:/sai_traders/supabase/migrations/20260928060239_init_saree_bot.sql)
   - This enables `vector`, `uuid-ossp`, and `pgcrypto`.
   - Creates `saree_catalog`, `customers`, `conversations`, `messages`, `orders`, `image_analyses`, and `app_config`.
   - Creates the `match_sarees` cosine similarity search function.
   - Creates the `saree-catalog-images` public storage bucket.
   - Inserts 6 authentic seed sarees (Kanjivaram, Banarasi, Bandhani, Chanderi, Organza, Patola).

Alternatively, if you link your project via Supabase CLI:
```powershell
supabase login
supabase link --project-ref <your-project-ref>
supabase db push
```

---

### 2. Configure Environment Secrets

In Supabase Dashboard -> **Project Settings** -> **Edge Functions** (or via `supabase secrets set`):

```bash
supabase secrets set \
  SUPABASE_URL="https://your-project.supabase.co" \
  SUPABASE_SERVICE_ROLE_KEY="your-service-role-key" \
  WHATSAPP_ACCESS_TOKEN="your-meta-system-user-access-token" \
  WHATSAPP_PHONE_NUMBER_ID="your-whatsapp-phone-number-id" \
  WHATSAPP_APP_SECRET="your-meta-app-secret" \
  WHATSAPP_VERIFY_TOKEN="sai_traders_webhook_secret_2026" \
  GEMINI_API_KEY="your-google-ai-studio-gemini-key" \
  GEMINI_MODEL="gemini-2.5-flash"
```

---

### 3. Deploy Edge Functions

Deploy the three functions to your Supabase project:

```powershell
supabase functions deploy whatsapp-webhook --no-verify-jwt
supabase functions deploy catalog-manage --no-verify-jwt
supabase functions deploy generate-embeddings --no-verify-jwt
```

---

### 4. Generate Initial Catalog Embeddings

Once deployed, generate the vector embeddings for the 6 initial seed sarees with one HTTP GET request:

```powershell
curl -X GET "https://your-project.supabase.co/functions/v1/generate-embeddings" \
  -H "Authorization: Bearer YOUR_SUPABASE_SERVICE_ROLE_KEY"
```

This will run each saree through Gemini's `text-embedding-004` and save the 768-dimensional vectors directly into the `embedding` column of `saree_catalog`.

---

### 5. Configure Meta WhatsApp Webhook

1. Go to [developers.facebook.com](https://developers.facebook.com/) -> Your WhatsApp Business App.
2. Under **WhatsApp** -> **Configuration**:
   - **Callback URL**: `https://<your-project-ref>.supabase.co/functions/v1/whatsapp-webhook`
   - **Verify Token**: `sai_traders_webhook_secret_2026` (matching your `WHATSAPP_VERIFY_TOKEN`)
3. Click **Verify and Save**.
4. In Webhook Fields, subscribe to **`messages`**.

---

## 💬 WhatsApp Conversation State Machine

```mermaid
stateDiagram-v2
    [*] --> idle: Customer starts chat
    idle --> analyzing_image: Customer sends photo
    idle --> browsing: Customer searches via text ("show me silk sarees")
    idle --> checking_order: Customer types "Track SAI-1001"

    analyzing_image --> showing_results: Gemini extracts attributes & finds matches
    analyzing_image --> no_match: No matching saree in stock

    showing_results --> product_detail: Customer selects Option #1 or #2
    product_detail --> collecting_address: Customer taps "Buy Now" (new address)
    product_detail --> order_placed: Customer taps "Buy Now" (address on file)

    collecting_address --> order_placed: Customer sends address text
    order_placed --> idle: Confirmation sent with Order #
```

---

## 🧪 Testing Locally

Run the end-to-end conversation simulator:

```powershell
node scripts/simulate_saree_flow.js
```
