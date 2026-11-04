# Known Concerns, Technical Debt & Risk Analysis — Sai Traders Saree Bot

Audit of technical debt, architectural constraints, security considerations, and potential failure modes.

---

## 1. Network & Deployment Boundaries

- **TallyPrime Local Port Dependency**:
  - TallyPrime operates as a desktop Windows application listening on `http://127.0.0.1:9000`.
  - Supabase Edge Functions in the cloud cannot directly connect to private LAN addresses.
  - *Mitigation*: The current polling agent (`agent/index.js`) bridges this gap effectively. However, if the local machine is powered off, loses internet connection, or Tally is minimized without XML server running, orders will accumulate in Supabase with status `pending`. Once the agent reconnects, backlog processing executes automatically.

---

## 2. API Quotas, Latency & Rate Limits

- **Meta WhatsApp Cloud API**:
  - Unverified Meta Business accounts have a messaging tier limit (typically 250 unique business-initiated conversations/24h), though customer-initiated service windows are 24h free.
  - Meta CDN media URLs expire after a short duration; images must be downloaded immediately by the edge function or stored directly in Supabase Storage.
- **Google Gemini API**:
  - Vision processing latency can vary between 1.5s to 3.5s per image.
  - Rate limit limits on free tier Google AI Studio keys may cause temporary HTTP 429 errors during sudden spikes.
  - *Recommendation*: Ensure fallback to alternative flash models or cache frequent visual search embeddings.

---

## 3. Order Deduplication & Concurrency

- **Webhook Duplicate Retries**:
  - Meta WhatsApp Webhooks retry delivery if the endpoint takes longer than 15-20 seconds to respond or returns non-200 status codes.
  - *Current Protection*: Database tracking in `messages` and `conversations` prevents repeated processing of identical `message_id`s.
- **Concurrent Stock Deduction**:
  - If two customers attempt to purchase the final unit of a single saree simultaneously, optimistic concurrency or atomic decrement via Postgres transactions is advised to avoid negative inventory.

---

## 4. Security & Access Control

- **Service Role Key Exposure**:
  - `.env` contains `SUPABASE_SERVICE_ROLE_KEY`. This key bypasses Row Level Security (RLS) and must be safeguarded.
  - Never commit `.env` into git repositories.
- **Admin Dashboard Authentication**:
  - Currently, `admin/server.js` serves the admin dashboard on `localhost:3000` without mandatory session authentication since it is designed for local store use.
  - *Recommendation*: If exposed over a public domain or tunnel (e.g. Cloudflare Tunnels / Ngrok), implement session auth or basic HTTP credentials.
