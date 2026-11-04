# Technology Stack — Sai Traders Saree Bot

Comprehensive overview of technologies, runtimes, frameworks, libraries, and tools utilized across the Sai Traders repository.

---

## 1. Core Languages & Runtimes

| Layer / Component | Technology | Version | Purpose |
|:---|:---|:---|:---|
| **Edge Functions** | TypeScript / Deno | Deno 1.x (Supabase runtime) | WhatsApp webhook processing, visual AI analysis, catalog embeddings |
| **Local Services** | JavaScript (Node.js) | Node.js v18+ / v20+ | Tally inventory polling agent, Admin web server, automation scripts |
| **Database** | PostgreSQL + pgvector | Postgres 15+ / pgvector 0.7+ | Relational data store, vector embeddings (768-dim), semantic search |
| **Frontend UI** | HTML5, Vanilla JS, CSS3 | Modern ECMAScript (ES2022) | Premium responsive admin dashboard, single-page UI without framework bloat |
| **Scripts & CLI** | Node.js & PowerShell | Windows PowerShell 5.1 / 7+ | Operational batch files (`.bat`), seeding scripts, health checks |

---

## 2. Infrastructure & Cloud Platforms

| Service | Provider | Purpose |
|:---|:---|:---|
| **Database & Auth** | Supabase | Managed PostgreSQL, database extensions, row-level security |
| **Serverless Runtime** | Supabase Edge Functions | Deno-powered edge handlers with sub-100ms cold starts |
| **Object Storage** | Supabase Storage | `saree-catalog-images` bucket for catalog photos and customer uploads |
| **Messaging Channel** | Meta WhatsApp Cloud API | Official Cloud API v21.0 for messaging, media, and interactive buttons |
| **Generative AI** | Google AI Studio (Gemini) | Gemini 2.5/1.5 Flash Vision, `text-embedding-004` (768 dimensions) |
| **Accounting / ERP** | TallyPrime | Desktop ERP (port 9000) for stock management and Sales Vouchers |

---

## 3. Key Dependencies & Libraries

### Node.js Packages (`package.json`)
```json
{
  "dependencies": {
    "express": "^5.2.1"
  }
}
```
*Note: The Node.js agent and admin dashboard are designed with minimal external dependencies, relying on native `fetch` (Node 18+), native `http`, and native `fs` for high reliability, zero bloat, and fast startup.*

### Deno / Edge Function Imports
- `@supabase/supabase-js` (v2): Supabase client for edge database queries and storage manipulation.
- Standard Deno Library (`std/http`): Request and response handling for serverless endpoints.

---

## 4. Development & Operational Tooling

- **Supabase CLI (`supabase`)**: Local migration management, edge function testing, and secrets deployment.
- **npm / npx**: Package management and script running (`npm run agent`, `npm run admin`, `npm test`).
- **Batch Automations**:
  - `agent/start_agent.bat`: Launches the autonomous Tally inventory agent in a dedicated console.
  - `admin/start_admin.bat`: Launches the Express admin dashboard server and opens localhost:3000.
