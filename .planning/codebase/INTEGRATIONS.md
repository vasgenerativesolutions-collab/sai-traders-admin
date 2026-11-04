# System Integrations — Sai Traders Saree Bot

Details regarding external services, APIs, database integrations, authentication mechanisms, and protocols.

---

## 1. Meta WhatsApp Business Cloud API

- **API Version**: Graph API `v21.0`
- **Base URL**: `https://graph.facebook.com/v21.0/`
- **Endpoints Used**:
  - `POST /{WHATSAPP_PHONE_NUMBER_ID}/messages`: Send text, image catalog cards, interactive button replies, and delivery updates.
  - `GET /{WHATSAPP_PHONE_NUMBER_ID}`: Health verification of WhatsApp Business account and token quality rating.
  - `POST /{WHATSAPP_PHONE_NUMBER_ID}/messages` (status: `read`): Mark received customer messages as read (blue ticks).
- **Authentication**: System user bearer token (`WHATSAPP_ACCESS_TOKEN`).
- **Webhook Ingress**:
  - Verification: `GET` webhook challenge validation with `WHATSAPP_VERIFY_TOKEN`.
  - Event Handling: `POST` payload containing customer messages (text, image media IDs, interactive button taps).
  - Media Retrieval: Media IDs are queried via Graph API to obtain temporary CDN download URLs for saree image processing.

---

## 2. Google Gemini AI (Multimodal & Embeddings)

- **Provider**: Google AI Studio API (`v1beta`)
- **Key Models**:
  - `gemini-2.5-flash` / `gemini-1.5-flash`: Vision inspection of customer saree photos; extraction of structured JSON attributes (fabric, weave, color, pattern, border, pallu, occasion, estimated retail price).
  - `text-embedding-004`: Vector generation (768 dimensions) for saree catalog items and natural language customer search queries.
- **Authentication**: `GEMINI_API_KEY` passed as a query parameter or bearer header.
- **Failover & Resilience**:
  - Automatic fallback between flash models if rate limits or quota errors occur.
  - Structured output prompt enforcement with strict JSON sanitization to handle model formatting variations.

---

## 3. Supabase Ecosystem

- **PostgreSQL Database**:
  - Tables: `saree_catalog`, `customers`, `conversations`, `messages`, `orders`, `image_analyses`, `app_config`.
  - Extension `vector`: Enables `vector(768)` columns for semantic similarity.
  - Extension `pgcrypto` & `uuid-ossp`: For secure token/UUID generation.
  - HNSW Indexing: `idx_saree_catalog_embedding` using `vector_cosine_ops` for fast nearest-neighbor search.
  - Stored Procedures: `match_sarees(query_embedding, match_threshold, match_count)` computing cosine distance and stock availability filter.
- **Supabase Storage**:
  - Bucket: `saree-catalog-images` (public read, authenticated write).
  - Stores high-resolution saree photos for catalog browsing and WhatsApp media links.
- **Supabase Edge Functions**:
  - `whatsapp-webhook`: Main stateful bot conversation controller.
  - `catalog-manage`: Product CRUD with automated vector embedding generation.
  - `generate-embeddings`: Batch vector generation utility for unindexed items.

---

## 4. TallyPrime ERP Integration

- **Communication Protocol**: Local XML over HTTP (`http://127.0.0.1:9000` or configured host:port).
- **Architecture Rationale**: Tally runs on a desktop Windows machine inside the physical store/office. Because cloud edge functions cannot directly access private LAN IPs, the Node.js agent (`agent/index.js`) runs locally as a bridge.
- **Operations Supported**:
  1. **Stock Summary Export**:
     - Sends XML `<REPORTNAME>Stock Summary</REPORTNAME>` export request.
     - Parses `<DSPDISPNAME>`, `<DSPSTKCL>`, and rate information to synchronize closing balances with Supabase `saree_catalog`.
  2. **Sales Voucher Creation (Stock Deduction)**:
     - On order confirmation in WhatsApp, agent generates a Tally `<VOUCHER VCHTYPE="Sales" ACTION="Create">` payload.
     - Creates ledger entries: Debit Sundry Debtor (Customer), Credit Sales Account, Debit/Credit GST Ledgers (CGST/SGST 2.5% each for textile 5% slab).
     - Deducts inventory batch/quantity directly in TallyPrime.
  3. **Order Status Reconciliation**:
     - Marks order in Supabase with `TALLY_SYNCED_VCH_{ORDER_NUMBER}`.
