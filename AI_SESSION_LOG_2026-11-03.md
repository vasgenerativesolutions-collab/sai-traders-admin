# Sai Traders — AI Senior Engineering Session Log

| Field | Details |
|:---|:---|
| **Date** | November 2–3, 2026 |
| **Workspace** | `c:\sai_traders` |
| **Focus** | Godown stock attribution, Tally XML limits, store-PC connectivity, multi-writer safety |
| **Outcome** | 6 defects fixed and deployed; 1 blocked on a TallyPrime setting; 3 groups of known issues left open |

---

## 1. Session Start — Environment & Rules Discovery

- Confirmed model (Opus 5) and that the `ponytail` plugin (v4.8.4) is installed and active.
- MCP audit: **neither Supabase nor Cloudflare MCP was connected** for this project. A Supabase MCP existed but was scoped to `C:\Users\mithu\Downloads\Billing\admin` with a *different* project ref (`pahanghosyepfuwcfexg`); this repo uses `aisttddxrbizoshtpdxi`.
- Created `.vscode/mcp.json` (VS Code's native MCP location — no Cline/Roo extension is installed) with both servers using `${env:...}` token references, and added the two token placeholders to `.env.example`. Corrected two package names from the request: `@supabase/mcp-server` does not exist (it is `@supabase/mcp-server-supabase`), and `@cloudflare/mcp-server-cloudflare` is the legacy local server rather than the current remote one.
- **Rule discovery:** `.agents/rules/PROJECT_RULES.md` is headed *"Auto-loaded Every Session"* but **is not auto-loaded** — there is no `CLAUDE.md`, no `AGENTS.md`, and no `.claude/` directory. `.agents/rules/` is a Cline/Roo convention. Rules 1–6 therefore bind nothing by default.

---

## 2. Full Rules & Restrictions Audit

Delivered a complete analysis across five layers: agent process rules, session memory, coding standards, security posture, and hard runtime enforcement.

**Verified as genuinely enforced in code (Rule 6):** zero master keys on store devices via Electron `safeStorage`, Tally concurrency = 1 with 250 ms spacing (`agent/tally_queue.js`, `server.js:1325`), voucher idempotency, SEC-07 company-GUID validation, and the 100% prepaid gate (`status=in.(confirmed,delivered)&payment_status=eq.paid`).

**`SECURITY_AUDIT.md` is stale** — dated 2026-10-18, scoring 68/100 with all six findings marked "Open". SEC-01 through SEC-06 are in fact remediated, plus SEC-07/SEC-08 added since. The document understates the real posture by roughly 25 points.

**Live gaps found:**

| Issue | Detail |
|:---|:---|
| No rate limiting | SEC-05's remediation was half-done — the 60 MB to 1 MB body limit landed, `express-rate-limit` was never added |
| Hardcoded credentials | `ADMIN_PIN='sai2026'`, `ADMIN_SESSION_SECRET`, `STOREFRONT_API_KEY` as literal fallbacks in tracked source — and **identical to the live `.env` values** |
| `Clear-Site-Data` regression | Removed from the middleware per PERF-01, but survived at three route handlers (`:488`, `:494`, `:501`) |
| Wildcard CORS + cookie sessions | `Access-Control-Allow-Origin: *` alongside cookie-based admin auth |
| `scripts/check_constraints.js` | Mutates production by trial-and-error against a hardcoded live UUID using the service-role key |
| 3x duplicated `server.js` | Identical by md5, synced manually via `npm run package:store` |
| `package-lock.json` gitignored | Combined with `@latest` pins, store installs are not reproducible |

Mitigating factor: the repo had **0 commits and no remotes**, so no credential had actually leaked.

---

## 3. `store_install/` Kit Review

- **Rule 6.1 violated twice.** `store_install/.env` ships `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET` and `CLERK_SECRET_KEY` in plaintext. Worse, `scripts/store_supervisor.js:42` **hardcodes the live service-role JWT** (role `service_role`, expiring 2036) — present in **11 files**.
- **Tunnel published a dead URL and reported it as fresh.** Root-cause chain in section 6.
- **Supervisor never starts `agent/index.js`** — it manages only `admin/server.js` and `cloudflared.exe`, while `HOW_TO_RUN_IN_STORE.txt` claims it starts "the Tally synchronization engine". `agent_devices` was 3 h 51 m stale.
- **No firewall rule** — `lanUrl` was advertised in Supabase but had never once worked.
- `getLanIp()` returned the first non-internal IPv4, picking up `169.254.*` APIPA addresses.
- Destructive utilities (`DELETE_ALL_CUSTOM_GODOWNS.bat`, `FIX_GODOWN_TO_PRIMARY.bat`) sit shop-floor-accessible beside `START_SAI_TRADERS.bat`, unauthenticated.

**Correction issued:** an earlier claim that the store PC server had been down since 11:18 was wrong. Telemetry showed 8.7 h uptime with 0 restarts — *TallyPrime* was closed, and the heartbeat only publishes when `local.connected` is true.

---

## 4. The "Only 2 Items Showing" Investigation

The headline problem, chased to ground through several wrong turns that are recorded here deliberately.

**Observed:** 9 items in `saree_catalog`, all tagged `tally_godown = Online_saree`, but only `SAI_SILK_01` (15) and `SAI-SIK-03` (11) had non-zero stock. The UI buckets `stock_quantity <= 0` as out-of-stock (`app-v2.js:324`), so 7 items appeared to be missing.

**Hypotheses raised and discarded:**

1. *Stale snapshot shadowing live Tally* — a real bug, but not the cause of the zeros.
2. *`Sarees` is a sub-godown of `Online_saree`, hiding stock outside scope* — **wrong.** The Godown collection proved all 5 godowns have parent `Primary`; the hierarchy is flat.
3. *`Sarees` is a sub-godown of `Main Location`* — **also wrong.** `<PARENT>Sarees</PARENT>` on a STOCKITEM is its **stock group**, which coincidentally shares a name with a godown.
4. *Stock is in the wrong godown* — **wrong.** Godown Summary showed `Online_saree` holds 149 pcs; the stock was in the right place and simply unreadable.
5. *The matrix values 11/15 were app-written manual entries* — **wrong.** They were parsed from Tally batch rows all along.

**Actual root cause, proven by a self-publishing diagnostic that captured raw XML to `app_settings.tally_parse_diagnostic`:**

```xml
<PARENT TYPE="String">Sarees</PARENT>
<CLOSINGBALANCE TYPE="Quantity"> 99 Pcs</CLOSINGBALANCE>
<BATCHALLOCATIONS.LIST>     </BATCHALLOCATIONS.LIST>   <!-- present but EMPTY -->
```

A StockItem Collection with `<FETCH>BatchAllocations.*</FETCH>` returns the element with **no content**. No regex could ever extract a godown breakdown, because Tally never sent one. This is the signature of **"Maintain Batch-wise details" being disabled**.

**Exhaustive query matrix — every path tried for item-by-godown data:**

| Query | Result |
|:---|:---|
| StockItem Collection + `BatchAllocations.*` | empty element |
| + explicit `BatchAllocations.GodownName` | empty element |
| Godown Collection + `BatchAllocations` / `StockItem` / `GodownWiseDetails` | name only, no allocations |
| Stock Summary + `SVGODOWNNAME` / `SVGODOWN` / typed variant / `ISGODOWNWISE` | unfiltered company totals — identical output even for an empty godown |
| Godown Summary + `ISITEMWISE` / `SVSTOCKGROUPNAME` | godown and stock-group rows only, 6 flat rows |
| `Stock Query` report | `<ENVELOPE></ENVELOPE>` |
| `Location Summary` / `Godown Vouchers` / `Stock Item Godown Summary` / `Godownwise Stock Summary` | empty responses |

**Second correction issued:** a derived item-by-godown split was presented as "arithmetically forced". It was not — at least two fits satisfy the same totals (`Sarie01 80` versus `Jari 40 + Sai_silk_02 50 + Jari1 -10`). The uniqueness claim was withdrawn.

**What *is* established:** Main Location 80 · Online_saree 149 · Online_Warehouse 19 · Jari 0 · Sarees (godown) 0 — totalling 248, reconciling exactly with the item closing balances (40 − 10 + 9 + 25 + 50 + 99 + 20 + 15 = 248).

---

## 5. Defect: `OPENINGBALANCE` Read As Current Stock

The most consequential find, with live commercial impact.

Batch rows carry **`OPENINGBALANCE` only** — no closing figure. The parser's alternation accepted it, so the storefront was selling against opening balances:

| Item | System reported | Tally closing | Effect |
|:---|:---|:---|:---|
| `SAI-SIK-03` | 11 | 9 | overstated → **oversell risk** |
| `SAI_SILK_01` | 15 | 25 | understated → **lost sales** |

Wrong in both directions, and drifting further with every voucher.

**Fix:** batch rows determine *where*, the item's `CLOSINGBALANCE` determines *how much*. Single-godown items are now exact. Multi-godown items split proportionally by opening weight, with the last holder absorbing the rounding remainder so the parts always sum to the closing total; marked with a `ponytail:` comment naming the ceiling and the upgrade path.

Also **deleted `fetchGodownSummaryMatrix`** — a sweep built earlier in the same session on the assumption that Godown Summary returns item rows. It does not, so the sweep could never recover anything, while firing **5 serialized Tally queries every 12 seconds** against a single-threaded engine.

---

## 6. Connectivity: Three Independent Failures

**Firewall.** `ping 192.168.1.8` returned 5 ms with 0% loss on the same subnet — but ports 3000 and 9000 were both closed. `app.listen(PORT, cb)` binds all interfaces, so the code was never at fault. One LAN-scoped inbound rule fixed it. Measured afterwards: **LAN 0.07 s versus tunnel 1.25 s**.

**Tunnel publishing dead URLs.** Three compounding causes:

1. `tunnel.log` is append-only (`appendFileSync`, rotating only at 10 MB) and never truncated, so URLs from every past run persist.
2. `get_tunnel_url.js` took `matches[matches.length - 1]` and published it unverified, so a failed `cloudflared` silently fell back to a long-dead hostname.
3. The supervisor re-published it every 20 s with a fresh `updatedAt`, making the gateway look perpetually healthy. Observed directly: a non-resolving hostname written **1 second** earlier.

Fixes: truncate `tunnel.log` on each tunnel launch; walk candidates newest-first and return only one that answers `/api/status`, logging each dead one skipped; publish `lanUrl` alone when nothing is reachable; harden `getLanIp()` to skip `169.254.*` and prefer RFC1918.

**Self-inflicted note:** a `FETCH *` probe with malformed TDL (`<FORMULA NAME="fName">` instead of a `<fName>` tag) raised a TDL error dialog on the production Tally and caused a 502. Tally recovered on its own (6 ms latency, sync loop healthy). No further experimental TDL was sent.

---

## 7. Cache-Beats-Live, Twice

**Godown tier ordering.** `/api/admin/godowns/list` consulted the cached Supabase snapshot (tier 2) *before* the live gateway (tier 3), with tier 3 gated on `length === 0`. A non-empty cache therefore shadowed live Tally **indefinitely**, and `?refresh=true` only skipped the 20 s in-memory cache before refilling from the same stale row. Reordered to local → live gateway → cache → local retry, and all four gateway call sites now prefer `lanUrl` over `publicUrl`.

**Stock source precedence.** In `/api/products` and `/api/live-stock` the `stock_pool` branch ran first and set `hasGodownMatch`, short-circuiting the matrix entirely. Since `syncGodownStockTransition` had zeroed all 9 rows, a zeroed cache beat real Tally stock. Inverted: live matrix first, cache as fallback. An explicit Tally **zero** is authoritative and does not fall through — otherwise an emptied godown would resurrect stale stock.

---

## 8. Multi-Writer Safety

Inventory figures in Supabase are shared rows; every server instance writes the same keys and last writer wins. Only the machine with Tally attached can produce correct values. Evidenced in-session:

```
[Scheduler] Morning stock sync complete: 9 items updated.
[fetchTallyGodowns] Tally unreachable: ECONNREFUSED 127.0.0.1:9000
[syncGodownStockTransition] Switched active godown across 9 stock pool items.
```

Added `isStockWriter()` = `isTallyLocallyConnected && isTallyIdentityVerified`, gating `performMorningStockSync` and `syncGodownStockTransition`. `target_godown` still persists from any machine — only the quantity rewrite is refused, and the store PC repopulates from live Tally on its next cycle. Both paths log why they skipped.

Found while testing: `/api/sync-tally-stock` already delegates correctly (`remoteStore: true`), so it was never part of the problem. The guard is the backstop for the 08:00 scheduler and the godown switch.

---

## 9. Frontend Crash: `escapeHtml is not defined`

Used exactly once (`app-v2.js:2512`) and **defined nowhere** — `SECURITY_AUDIT.md` recommended creating it under SEC-03 and the call site was written without the function ever being added.

It threw *after* the stock write had already succeeded, so the UI reported "Failed to update stock" for writes that went through — meaning any retried update may have applied twice. Removed the call rather than adding the function: the `.replace(/[^a-zA-Z0-9_-]/g, '_')` immediately after already yields a safe DOM id, and escaping first would mangle `&` into `_amp_`. Bumped the `index.html` cache-buster to `v=20261103_stock_precedence_v4`.

---

## 10. Changes Shipped

| File | Change |
|:---|:---|
| `admin/server.js` | `closing_total` and `unallocated_qty`; closing-balance godown attribution; parse diagnostics; godown tier reorder; LAN-preferred gateway; stock source precedence; `isStockWriter()` gating; removed hardcoded `'online_saree'` literals (now 0 occurrences) and `fetchGodownSummaryMatrix` |
| `admin/public/app-v2.js`, `app.js` | tooltip no longer enumerates other godowns; "Needs allocation (N in Tally)" badge; live poller no longer clobbers it; `escapeHtml` call removed |
| `admin/public/index.html` | cache-buster bumped |
| `scripts/get_tunnel_url.js` | reachability verification; APIPA-safe `getLanIp()` |
| `scripts/store_supervisor.js` | truncate `tunnel.log` on tunnel launch |
| `scripts/test_unallocated_stock.js` | 24 assertions — unallocated rule, godown attribution, source precedence, writer gate |
| `scripts/test_tunnel_url.js` | 7 assertions — LAN IP selection |
| `.vscode/mcp.json`, `.env.example` | MCP server config and token placeholders |

All synced to `store_install/` and `install_kit/` via `npm run package:store`, md5-verified, and staged in `_share_storepc/`.

**Verified live on both machines:** `SAI-SIK-03` → 9 (later 10), `SAI_SILK_01` → 25, matching Tally's closing balances. Previously both read 0.

---

## 11. Open Items

**Blocked on Tally configuration** — 224 pcs across 5 items (`Sarie01` 99, `Sai_silk_02` 50, `Jari` 40, `Sarie03` 20, `Silk` 15) have no batch row, so no godown attribution is possible. Requires `F11` → Inventory Features → *Maintain Batch-wise details: Yes*, then a godown on each item's opening balance. **Not retroactive** — existing stock will not gain batch rows automatically.

**Security, unaddressed:**

- Live service-role JWT hardcoded in 11 files, including the shipped store kit
- `ADMIN_PIN` / `ADMIN_SESSION_SECRET` / `STOREFRONT_API_KEY` literals matching live `.env` values
- No rate limiting (SEC-05 incomplete)
- Wildcard CORS alongside cookie sessions; no CSP or HSTS
- `scripts/check_constraints.js` mutates production

**Operational, unaddressed:**

- Supervisor does not start `agent/index.js`
- `Clear-Site-Data` still set at three route handlers
- `/api/admin/godowns/summary` double-counts (`EXPLODEFLAG=Yes` emits each godown twice, giving `grandTotal: 496` instead of 248)
- `jari1` holds **-10 Pcs** in Tally
- `target_godown` is `Main Location`; the online catalogue needs it on `Online_saree`
- No `CLAUDE.md`, so `PROJECT_RULES.md` remains unloaded
- Destructive `.bat` utilities still in the store kit

**Approved but not executed** — the three fixes planned early in the session: `CLAUDE.md` creation, secret rotation with fail-fast on missing env vars, and removing the surviving `Clear-Site-Data` headers.
