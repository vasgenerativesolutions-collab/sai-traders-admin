# Testing Strategy & Verification Guide — Sai Traders Saree Bot

Testing workflows, automated scripts, and manual verification procedures.

---

## 1. Automated Scripts & Health Checks

Sai Traders includes dedicated testing scripts located in `scripts/`:

| Script | Command | Purpose | Verification Scope |
|:---|:---|:---|:---|
| **System Health Check** | `npm run check-env` (`node scripts/test_env_and_services.js`) | Validates all 4 external credentials | WhatsApp API validity, Gemini Vision API active test, Supabase DB connection & tables, TallyPrime HTTP port 9000 status |
| **Tally Integration Flow** | `npm test` (`node scripts/test_tally_flow.js`) | Tests end-to-end Tally voucher & inventory cycle | Queries Tally stock summary, constructs test voucher XML, verifies Tally response code |
| **Live Gemini Multimodal** | `node scripts/test_live_gemini.js` | Sends test saree images to Gemini Vision | Validates attribute extraction JSON schema (fabric, weave, color, price) |
| **WhatsApp Flow Simulator** | `node scripts/simulate_saree_flow.js` | Simulates customer conversation locally | Simulates greeting, sending photo, receiving catalog cards, selecting SKU, placing order |

---

## 2. End-to-End Verification Pipeline

### Phase 1: Environment Verification
```powershell
npm run check-env
```
Ensure all four components report `[PASS]` or `[ONLINE]`.

### Phase 2: Vector Search & AI Matching
1. Run `node scripts/test_live_gemini.js` to ensure Gemini model generates structured output.
2. In Supabase SQL editor or via REST, execute `match_sarees` with a sample 768-dim vector to ensure cosine distance indexing functions properly.

### Phase 3: TallyPrime Voucher Test
1. Start TallyPrime on the Windows workstation.
2. Ensure Tally is open at the **Gateway of Tally** and configured to listen on port `9000`.
3. Run:
```powershell
npm test
```
4. Verify that test vouchers appear in Tally DayBook or Stock Summary.

### Phase 4: WhatsApp Live Testing
1. Send an image of a saree to the business WhatsApp number.
2. Observe WhatsApp reply within 3–5 seconds containing 2–3 matching saree cards with interactive buttons.
3. Tap "Select" -> Enter delivery address -> Verify confirmation message with `SAI-XXXX` order code.
4. Verify the agent console (`node agent/index.js`) detects the new order and posts the Sales Voucher to Tally.
