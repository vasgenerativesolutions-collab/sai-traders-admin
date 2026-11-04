# Directory & Codebase Structure — Sai Traders Saree Bot

File organization, directory responsibilities, and key modules.

---

## 1. Directory Tree

```
c:\sai_traders\
├── .env                                  # Active environment credentials (local)
├── .env.example                          # Template for environment configuration
├── package.json                          # Node project dependencies and npm scripts
├── README.md                             # Quickstart and deployment guide
├── QUOTATION_KalpaCodes_SaiTraders.md    # Commercial proposal and feature specifications
├── admin/                                # Admin Web Dashboard application
│   ├── public/                           # Client-side SPA assets
│   │   ├── app.js                        # Admin UI controller, state & event handlers
│   │   ├── index.html                    # Admin dashboard layout & components
│   │   └── style.css                     # Custom dark/light responsive CSS styling
│   ├── server.js                         # Express backend serving APIs and static files
│   └── start_admin.bat                   # Windows batch script to launch Admin Dashboard
├── agent/                                # Autonomous Tally Inventory Agent
│   ├── config.js                         # Agent configuration & polling intervals
│   ├── index.js                          # Main polling loop for orders & stock sync
│   ├── stock_service.js                  # Tally stock export parser and catalog updater
│   ├── tally_client.js                   # Low-level XML HTTP client for TallyPrime :9000
│   ├── voucher_service.js                # XML Sales Voucher builder and poster
│   └── start_agent.bat                   # Windows batch script to run Tally Agent
├── assets/                               # Static images, branding logos, icons
├── scripts/                              # Verification, seeding & automation scripts
│   ├── add_products_to_tally.js          # Helper to push catalog items into Tally
│   ├── add_sr_1042_saree.js              # Catalog seed script for specific saree SKU
│   ├── add_user_sarees.js                # Bulk import utility for store saree inventory
│   ├── build_quotation_html.js           # Generates HTML quotation documentation
│   ├── populate_catalog_embeddings.js    # Batch generates Gemini 768-d embeddings
│   ├── process_logo.js                   # Asset transformation script
│   ├── simulate_saree_flow.js            # Mock conversation flow for WhatsApp bot
│   ├── test_env_and_services.js          # Comprehensive health check for all 4 external APIs
│   ├── test_live_gemini.js               # Tests Gemini Vision with live sample images
│   └── test_tally_flow.js                # Validates Tally connectivity and voucher generation
└── supabase/                             # Supabase backend definitions
    ├── config.toml                       # Supabase CLI project configuration
    ├── migrations/
    │   └── 20260928060239_init_saree_bot.sql # Master DB schema, pgvector, HNSW, seeds
    └── functions/                        # Serverless Deno Edge Functions
        ├── _shared/
        │   ├── gemini.ts                 # Gemini API helper (vision analysis & embeddings)
        │   ├── supabase-client.ts        # Supabase service role client wrapper
        │   └── whatsapp.ts               # Meta Cloud API message/card/media sender
        ├── catalog-manage/               # Product CRUD REST endpoint
        ├── generate-embeddings/          # Edge endpoint for embedding generation
        └── whatsapp-webhook/             # Primary webhook handler for WhatsApp messages
```

---

## 2. Component Roles & Boundaries

| Directory | Execution Context | Network Exposure | Primary Responsibility |
|:---|:---|:---|:---|
| `supabase/functions/` | Deno (Supabase Edge) | Public HTTPS (Webhook) | Instant webhook responses, customer AI interactions, catalog queries |
| `agent/` | Node.js (Windows Host) | Localhost / Private LAN | Bridges private TallyPrime XML port (9000) with cloud Supabase |
| `admin/` | Node.js (Windows Host) | Localhost (Port 3000) | Business owner UI for monitoring orders, catalog management, and logs |
| `scripts/` | Node.js CLI (Ad-hoc) | Outbound HTTPS / Local | Verification suites, mock simulations, data seeding |
