# Project State — Sai Traders Saree Bot

**Current Status**: Phase 4 Active — Codebase Onboarded & Initialized  
**Last Updated**: 2026-10-05  

---

## 1. Current Phase & Health

| Metric | Status | Notes |
|:---|:---|:---|
| **Active Milestone** | Phase 4: Catalog Population & Operational Go-Live | In progress |
| **System Health** | Ready for verification | Run `npm run check-env` to test active keys |
| **Cloud Infrastructure** | Complete | Supabase DB schema, functions, and storage bucket defined |
| **Local Services** | Complete | Tally Agent & Admin Dashboard tested and runnable via `.bat` |

---

## 2. Key Architecture Decisions

- **Hybrid Cloud / Desktop Architecture**:
  - Webhooks and AI matching execute on Supabase Edge & Google AI Cloud.
  - Tally integration runs locally on the shop PC via a Node.js polling daemon (`agent/index.js`), completely avoiding firewall/port-forwarding risks.
- **HNSW Vector Indexing**:
  - Embeddings are generated with Google `text-embedding-004` (768 dims) and indexed with PostgreSQL `hnsw` using cosine distance for fast visual similarity search.
- **Zero-Dependency Native Node Runtime**:
  - `agent/` and `admin/` use native `fetch`, `http`, and `fs` without third-party ORMs or heavy build tools, ensuring fast Windows startup and stability.

---

## 3. Immediate Next Steps

1. Run `npm run check-env` to verify external API keys (Meta WhatsApp, Gemini AI, Supabase, Tally).
2. Start the local Admin Dashboard with `npm run admin` or `admin/start_admin.bat`.
3. Ingest store saree products or run `node scripts/add_user_sarees.js` followed by `node scripts/populate_catalog_embeddings.js`.
4. Launch the local Tally inventory sync agent using `npm run agent` or `agent/start_agent.bat`.
