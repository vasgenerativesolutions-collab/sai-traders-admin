# Project Requirements — Sai Traders Saree Bot

Specification of functional and non-functional requirements based on the system scope and commercial contract.

---

## 1. Functional Requirements

### A. WhatsApp Conversational AI
- **REQ-WA-01: AI Visual Saree Search**: Customer uploads saree photo; system processes image via Gemini Vision to detect fabric, weave, color palette, pattern, border, pallu, occasion, and estimated market price.
- **REQ-WA-02: Semantic Vector Similarity Search**: Using 768-dimensional embeddings (`text-embedding-004` and `pgvector`), retrieve top 2-3 most similar sarees currently in stock.
- **REQ-WA-03: Interactive Product Cards**: Format responses as WhatsApp media cards with saree image, title, price, MRP, and interactive buttons ("Select Saree #1", "Select Saree #2").
- **REQ-WA-04: Natural Language Querying**: Customer can query in free-text (e.g. "show me Banarasi silk sarees under ₹12000") and receive vector-matched recommendations.
- **REQ-WA-05: Conversational Ordering Flow**: Guided checkout flow collecting customer name, address, and mobile number, generating order ID `SAI-XXXX`.
- **REQ-WA-06: Order Status Tracking**: Customer can type "Track SAI-XXXX" to receive real-time order status and shipping details.
- **REQ-WA-07: Intent Classification**: Robust intent routing handling greetings, search queries, confirmations, and address submissions with graceful fallbacks.
- **REQ-WA-08: Webhook Deduplication**: Enforce idempotency on Meta message IDs to prevent double replies on retry events.
- **REQ-WA-09: Read Receipts**: Automatically mark incoming WhatsApp messages as read (`status: read`).

### B. TallyPrime ERP Integration
- **REQ-TAL-01: Automated Sales Voucher Push**: Automatically construct and push XML `<VOUCHER VCHTYPE="Sales">` to TallyPrime (port 9000) when an order is confirmed.
- **REQ-TAL-02: Inventory Deduction**: Decrement corresponding SKU stock quantities inside Tally upon voucher creation.
- **REQ-TAL-03: Bidirectional Stock Sync**: Periodically pull Tally's `Stock Summary` via XML and update `saree_catalog.stock_quantity` in Supabase.
- **REQ-TAL-04: Customer Ledger Mapping**: Create or map customer profiles to Tally Sundry Debtors ledgers.
- **REQ-TAL-05: GST Tax Compliance**: Support textile GST slabs (2.5% CGST + 2.5% SGST) in voucher line items.

### C. Admin Web Dashboard
- **REQ-ADM-01: System Status Monitor**: Real-time health check tiles for WhatsApp API, Supabase DB, Gemini AI, and TallyPrime XML Server.
- **REQ-ADM-02: Catalog CRUD**: Interface to view, add, edit, or disable sarees, including image previews and inventory counts.
- **REQ-ADM-03: Order Management**: View all orders, filter by status (`pending`, `confirmed`, `packed`, `shipped`, `delivered`), and inspect Tally sync notes.
- **REQ-ADM-04: Customer Directory**: View registered WhatsApp customers, saved addresses, and historical order volumes.
- **REQ-ADM-05: Vision Analysis Log**: View history of photos submitted by customers with extracted AI tags and returned matches.
- **REQ-ADM-06: Manual Re-Sync Controls**: Buttons to trigger immediate Tally inventory sync and voucher re-processing.

---

## 2. Non-Functional Requirements

- **NFR-PERF-01**: WhatsApp image search response latency must remain under 4.5 seconds under normal network conditions.
- **NFR-REL-01**: Tally Agent must run autonomously as a background service with automatic retry on temporary Tally disconnects.
- **NFR-SEC-01**: All sensitive API keys and secrets must reside in `.env` locally and Supabase encrypted secrets in cloud.
- **NFR-ROB-01**: Bot must provide graceful fallback messages if an uploaded image is blurry, corrupted, or unsupported.
