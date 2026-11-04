# Coding Conventions & Standards — Sai Traders Saree Bot

Standards and engineering guidelines observed across the codebase.

---

## 1. Code Style & Architecture Conventions

- **JavaScript / Node.js**:
  - CommonJS (`require` / `module.exports`) used for local Node runtime consistency across Windows scripts and services.
  - Native standard library preferred over heavy NPM dependencies (uses native `fetch`, `http`, `fs`, `path`).
  - Async/await used everywhere with structured `try/catch` and explicit error logging.
  - Explicit console logging with timestamp prefixes and descriptive emojis for easy monitoring in PowerShell console windows.
- **TypeScript / Deno (Supabase Edge Functions)**:
  - Standard ES Modules (`import ... from "..."`).
  - Type-safe payload parsing and JSON responses with proper CORS headers.
  - Fail-safe response pattern: Webhooks always return HTTP `200 OK` promptly to Meta to avoid delivery retry loops, while processing asynchronous tasks via background handling or resilient execution.
- **Database & SQL**:
  - Snake_case naming for tables, columns, indexes, and RPC functions (`saree_catalog`, `match_sarees`, `stock_quantity`).
  - Explicit index creation for all filtered and joined foreign keys (`phone_number`, `is_active`, `price`).
  - Vector cosine operations using HNSW indexing for sub-millisecond similarity lookups.

---

## 2. Environment Variables & Secret Handling

- **Local Development / Node**:
  - Environment variables stored in `.env`.
  - Manual, zero-dependency parser reads `.env` lines in `admin/server.js` and `scripts/*.js` to ensure portability without requiring external dotenv packages.
  - Sensitive files like `.env` must never be checked into version control.
- **Supabase Cloud**:
  - Managed via `supabase secrets set` or the Supabase Project Dashboard.
  - Secrets:
    - `SUPABASE_URL`
    - `SUPABASE_SERVICE_ROLE_KEY`
    - `WHATSAPP_ACCESS_TOKEN`
    - `WHATSAPP_PHONE_NUMBER_ID`
    - `WHATSAPP_APP_SECRET`
    - `WHATSAPP_VERIFY_TOKEN`
    - `GEMINI_API_KEY`
    - `GEMINI_MODEL`

---

## 3. Order ID & SKU Conventions

- **Order Identification**:
  - Prefix: `SAI-XXXX` (e.g., `SAI-1001`, `SAI-1042`).
  - Human-friendly format displayed to WhatsApp customers and synchronized to Tally sales voucher reference fields.
- **Stock Keeping Unit (SKU)**:
  - Standardized identifier matching physical inventory in TallyPrime (e.g., `KANJI-RED-01`, `BANAR-GLD-02`).
  - Strictly unique in `saree_catalog.sku` to prevent inventory miscounts.
