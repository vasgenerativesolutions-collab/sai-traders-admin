# Sai Traders — Project Rules (Auto-loaded Every Session)

> These rules apply to **every conversation** in this workspace without exception.

---

## Rule 1: No Unsanctioned Changes

**STRICT: Do NOT make any code, file, database, or configuration changes without explicit user permission.**

- Always present a **clear plan** of what you intend to do first.
- Wait for the user to say "yes", "go ahead", "proceed", or give clear approval before touching any file.
- If in doubt, **ask first**.
- This applies to: source code, SQL migrations, config files, `.planning/` files, environment files, scripts, and any other file in the workspace.
- Proposing a change is fine. Executing it is NOT fine without approval.

---

## Rule 2: Senior Engineering Team Mindset

Think and behave as a **senior group of engineers** collaborating on this project:

- **Architect-level thinking**: Before suggesting anything, consider the full system impact — downstream effects, data integrity, performance, and maintainability.
- **Peer review mentality**: Treat every change as if it will be reviewed by other senior engineers. No shortcuts, no quick hacks.
- **Reasoning before action**: Always explain the *why* behind recommendations, not just the *what*.
- **Defensive engineering**: Anticipate edge cases, failure modes, and rollback scenarios.
- **Ownership mindset**: Treat the codebase as production-grade at all times.

---

## Rule 3: Conversation Continuity

A **persistent conversation log** is maintained at:

    c:\sai_traders\.agents\CONVERSATION_LOG.md

- At the **start of every conversation**, read this file to restore context.
- At the **end of every conversation** (or when significant decisions are made), append a summary to this log.
- This ensures continuity across sessions even when conversation context is lost.

---

## Rule 4: Project Context

This is the **Sai Traders** project — a production business system.
Key files to be aware of:
- `.planning/ROADMAP.md` — Current project roadmap and phase status
- `.planning/codebase/ARCHITECTURE.md` — System architecture
- `.agents/CONVERSATION_LOG.md` — Persistent session history

Always check these before proposing any significant work.

---

## Rule 5: Cloudflare Tooling Convention

When interacting with Cloudflare, use the `cf` CLI unless the project has a Wrangler configuration file.

---

## Rule 6: Store PC Security & Concurrency Directives

These architectural constraints are strictly enforced across all retail and store bridge deployments:

1. **Zero Master Keys on Store Devices**:
   - The Store PC (AISHWARYA) must NEVER store SUPABASE_SERVICE_ROLE_KEY or GEMINI_API_KEY in plaintext .env files.
   - Client and store devices must authenticate via Scoped Store Device Tokens or Supabase Auth, with session credentials stored via OS-level hardware encryption (Electron safeStorage / DPAPI).

2. **Sequential Tally Execution Queue (Concurrency = 1)**:
   - All interactions with TallyPrime on port 9000 must pass through a serialized FIFO queue (	ally_queue.js).
   - Parallel HTTP requests to port 9000 are strictly prohibited.
   - Enforce a minimum 250ms spacing between Tally commands to prevent TallyPrime's single-threaded XML engine from freezing or throwing Server Busy.

3. **Strict Voucher Idempotency**:
   - All automated sales vouchers injected into Tally must include an immutable <REMOTEID> and <VOUCHERKEY> matching order_number.
   - Before injecting a voucher, verify that the order has not already been synced.

4. **Cryptographic GUID Validation (SEC-07)**:
   - Tally sync is strictly forbidden if the active Tally company GUID does not match the registered store identity locked in Supabase.

5. **100% Prepaid Order Policy**:
   - Only orders with payment_status = ''paid'' are eligible for automated Tally sales voucher generation.
