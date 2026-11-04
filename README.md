# Sai Traders — WhatsApp Commerce + TallyPrime Bridge

A retail platform for saree shops. Customers shop over WhatsApp using photos instead of search terms; every confirmed sale lands in the shop's existing **TallyPrime** books as a GST-compliant voucher, with no double entry.

Built by [KalpaCodes](https://github.com/vasgenerativesolutions-collab) for Shree Sai Traders, Tumakuru.

---

## The problem it solves

A saree shop already runs on Tally. Putting it online usually means a second inventory that drifts from the first, and staff re-typing every web order into the accounts. This keeps Tally as the single source of truth and treats the web as another counter.

Two hard parts, both solved here:

- **Tally has no cloud API.** It listens on `localhost:9000` inside the shop, behind a consumer router. Covered in [the bridge](#2-the-store-pc-bridge).
- **Online and walk-in sales share one rack.** Sell the same saree twice and someone is disappointed. Covered by [godown isolation](#godown-isolation).

---

## Architecture

Three planes. Only the middle one lives in the shop.

```
   CUSTOMER                      CLOUD                         IN THE SHOP
 ┌──────────┐          ┌──────────────────────┐          ┌──────────────────┐
 │ WhatsApp │─photo──▶ │  Supabase Edge Fn    │          │   Store PC       │
 │          │          │  whatsapp-webhook    │          │                  │
 │          │◀─cards───│         │            │          │  ┌────────────┐  │
 └──────────┘          │         ▼            │          │  │ supervisor │  │
                       │  Gemini 2.5 Flash    │          │  │  ├ server  │  │
 ┌──────────┐          │  vision + embeddings │          │  │  ├ agent   │  │
 │  Web     │──HTTP──▶ │         │            │          │  │  └ tunnel  │  │
 │ storefront│         │         ▼            │          │  └─────┬──────┘  │
 └──────────┘          │  Postgres + pgvector │◀─polls───┼────────┘         │
                       │  22 tables, RLS      │──jobs───▶│        │         │
 ┌──────────┐          │                      │          │        ▼         │
 │  Admin   │──HTTPS─▶ │  Storage / R2 images │          │  TallyPrime      │
 │ dashboard│          └──────────────────────┘          │  XML :9000       │
 └──────────┘                                            └──────────────────┘
```

---

## 1. WhatsApp commerce

A customer photographs a saree — a wedding, a shop window, Instagram — and gets matches from live stock.

1. **Vision extraction** (Gemini 2.5 Flash): fabric, weave style, colour palette, motifs, border and pallu craftsmanship, occasion, estimated price.
2. **Vector match**: attributes become a 768-dimension embedding (`text-embedding-004`), searched against `saree_catalog` via pgvector HNSW cosine distance. Returns the closest 2–3 items **that are actually in stock**.
3. **Interactive cards**: image, price, MRP and "Select this saree" buttons.
4. **Conversational checkout**: name, address, phone → order number `SAI-XXXX`.
5. **Tracking**: "Track SAI-1042" returns live status.

Free-text works too — *"red silk sarees under ₹8000"* runs the same vector search.

Inbound webhooks are HMAC-SHA256 verified and deduplicated on Meta's message ID, so a retry can never double-reply.

## 2. The store PC bridge

Tally is a desktop application on `127.0.0.1:9000`. No cloud service can reach it, and port-forwarding a shop router is not an option. So the shop PC **reaches out** and never accepts inbound connections.

`scripts/store_supervisor.js` manages three children with auto-restart, log rotation and telemetry:

| Child | Role |
|---|---|
| `admin/server.js` | local API and dashboard |
| `agent/index.js` | polls Supabase for jobs, executes against Tally, writes results back via a SQLite outbox |
| `cloudflared` | optional tunnel for remote dashboard access |

**Why Tally integrations usually break, and what's done about it:**

- *Tally's XML engine is single-threaded.* Two concurrent requests and it freezes or returns `Server Busy`. All traffic passes through a leaky-bucket queue at **concurrency 1 with 250 ms spacing**, with exponential-backoff retry.
- *Network retries create duplicate invoices.* Every voucher carries an immutable `REMOTEID` and `VOUCHERKEY` derived from the order number, so a replay is a no-op rather than a second sale.
- *Writing into the wrong company destroys books.* The active Tally company's GUID is bound to the registered shop identity. A mismatch **refuses to sync** rather than guessing.
- *Only paid orders post.* Vouchers are raised exclusively for `payment_status = 'paid'`.

### Godown isolation

Online stock is quarantined to a dedicated Tally **godown** (warehouse location). The storefront can only sell what sits in that godown, so the counter and the website cannot sell the same physical saree. Billing terminals pair to a single godown and are refused if they request another.

## 3. The admin dashboard

Express + vanilla SPA, served on port `3000` locally or hosted centrally.

| View | What it does |
|---|---|
| **Inventory** | catalogue CRUD, images, prices, per-godown stock, variant grouping into design families |
| **Matcher** | upload a screenshot and see what the vector search returns — the AI debugging surface |
| **Stock Log** | Tally sync history, discrepancy review and approval workflow |
| **Analytics** | sales by period, order pipeline, customer directory |
| **Videos** | build listings from reels — keyframe extraction into `video_record` |

Plus system health tiles for WhatsApp, Supabase, Gemini and Tally, live stock polling, godown switching, and device management.

### Terminal pairing

A new billing PC shows a 6-character activation code (Zee5 style). An authenticated member enters it in the dashboard, names the terminal and picks its godown. The terminal is then locked to that godown. The device token identifies a terminal — it carries **no** owner authority, so a counter cannot delete products or adjust stock.

## 4. Storefront API

For an external web shop (Angular, Next.js, anything):

```
GET  /api/v1/store/products           catalogue, godown-scoped
GET  /api/v1/store/products/:sku      single item
POST /api/v1/store/orders             place an order
POST /api/v1/inventory/holds/acquire  reserve stock during checkout
POST /api/v1/inventory/holds/convert  hold → confirmed order
POST /api/v1/inventory/holds/release  release on abandonment
```

API-key authenticated with constant-time comparison, and the key list is comma-separated so it can be rotated with no downtime. **Order totals are computed server-side from catalogue prices** — a client-supplied amount that disagrees is rejected, so the price cannot be tampered with in transit.

---

## Repository layout

```
admin/
  server.js              Express API — catalogue, orders, Tally, godowns, devices
  public/                dashboard SPA (index.html, app-v2.js, style.css)
agent/
  index.js               job worker daemon
  poller.js              job dispatcher
  jobs/                  preflight, read_godown_balances
  tally_client.js        XML over HTTP to :9000
  tally_queue.js         concurrency-1 leaky bucket
  outbox.js              SQLite durability before cloud upload
  credentials.js         DPAPI-encrypted device credentials
desktop/
  main.js                Electron wrapper, safeStorage keychain
supabase/
  migrations/            schema: pgvector, RLS on 22 tables, multi-shop scaffolding
  functions/
    whatsapp-webhook/    Meta Graph API v21.0 handler
    _shared/             gemini.ts, whatsapp.ts, supabase-client.ts
scripts/
  store_supervisor.js    process supervisor + watchdog
  get_tunnel_url.js      tunnel discovery with reachability verification
  test_*.js              regression suites
  dangerous/             production-mutating utilities, excluded from store kits
store_install/           distribution kit for the shop PC
install_kit/             installer payload
```

---

## Setup

**Requirements:** Node.js 18+, a Supabase project, a Meta WhatsApp Business number, a Gemini API key, and TallyPrime with the XML server enabled on port 9000 (`F1 → Settings → Connectivity → acts as: Both`).

```bash
npm install
cp .env.example .env     # fill in every value — there are no defaults
npm run check-env        # verify every external service responds
npm run admin            # dashboard at http://localhost:3000
npm run agent            # Tally job worker
```

In a shop, run `START_STORE_PC.bat` instead — it starts the supervisor, which manages all three processes.

```bash
npm test                 # Tally flow
node scripts/test_unallocated_stock.js   # stock attribution + delta arithmetic
node scripts/test_auth_gates.js          # authorisation + output escaping
node scripts/test_tunnel_url.js          # LAN discovery
```

---

## Security notes

- **No secrets in source.** Every credential is read from the environment; the server refuses to start without `ADMIN_PIN`. `.env` files are gitignored.
- **RLS everywhere.** Writes are `service_role`-only across 22 tables. Public reads are limited to four non-sensitive tables.
- **Output escaping.** All untrusted values — notably WhatsApp profile names, which an outsider controls — are HTML-escaped before rendering.
- **Rate limiting.** Dependency-free fixed-window limiter: 10/min on auth, 60 on mutations, 300 on reads.
- **Deployment mode.** `DEPLOYMENT_MODE=hosted` requires every request to authenticate. `local` permits the loopback convenience path on the shop PC itself.
- **Store devices hold no master keys.** Credentials are DPAPI-encrypted via Electron `safeStorage`.

A known limitation: per-item, per-godown stock requires **Maintain Batch-wise details** enabled in Tally. Without it Tally's XML export reports godown totals and item totals but never the cross-tabulation, so items without a batch allocation cannot be placed in a godown.

---

## Licence

Proprietary. © KalpaCodes.
