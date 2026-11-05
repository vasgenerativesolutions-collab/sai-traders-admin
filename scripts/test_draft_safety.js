/**
 * A product auto-created from a Tally item must never be sellable.
 *
 * The shop enters stock in Tally, so the agent creates the missing product itself.
 * That product has no price, no photos and no description — offering it to a customer
 * would be worse than the invisible stock it replaces. This asserts, against the
 * live database, that every path a customer can reach excludes it.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
const get = (k) => (env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [, ''])[1].trim();
const base = get('SUPABASE_URL');
const KEY = get('SUPABASE_SERVICE_ROLE_KEY');
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

const sql = async (query) => {
  assert.ok(TOKEN, 'set SUPABASE_ACCESS_TOKEN to run this check');
  const res = await fetch('https://api.supabase.com/v1/projects/aisttddxrbizoshtpdxi/database/query', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  assert.ok(Array.isArray(body), `SQL failed: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
};

(async () => {
  // --- 1. the shape the function writes ------------------------------------
  const src = fs.readFileSync(path.join(root, 'supabase', 'functions', 'agent-sync', 'index.ts'), 'utf8');
  const block = src.slice(src.indexOf('let drafted = 0;'), src.indexOf('if (!error) drafted'));
  assert.ok(block, 'the drafting block was not found');
  assert.match(block, /is_active: false/, 'a drafted product must not be active');
  assert.match(block, /status: 'pending_review'/, 'a drafted product must be marked for review, not left as the default draft');
  assert.ok(block.includes('price: rate > 0 ? rate : 0'),
    'a drafted price must come from Tally or stay zero, never be invented');
  assert.match(block, /onConflict: 'sku', ignoreDuplicates: true/, 'drafting must never overwrite an edited product');
  console.log('ok   the agent writes drafts that are inactive, unlisted and unpriced');

  // --- 2. every customer-facing path excludes it ---------------------------
  const fns = await sql(
    "select p.proname, pg_get_functiondef(p.oid) as def from pg_proc p " +
    "join pg_namespace n on n.oid = p.pronamespace " +
    "where n.nspname = 'public' and p.proname like 'match_sarees%'"
  );
  assert.ok(fns.length >= 1, 'the customer search functions must exist');
  for (const f of fns) {
    const guards = /is_active = true/.test(f.def);
    const needsEmbedding = /embedding(_v2)? IS NOT NULL/i.test(f.def);
    assert.ok(guards, `${f.proname} must require is_active`);
    assert.ok(needsEmbedding, `${f.proname} must require an embedding, which a new draft has none of`);
    console.log(`ok   ${f.proname} excludes a draft (is_active and embedding both required)`);
  }

  // --- 3. nothing already drafted is reachable -----------------------------
  const leaked = await sql(
    "select sku, status, is_active, price from saree_catalog " +
    "where created_by = 'agent' and (is_active = true or status = 'listed' or embedding is not null)"
  );
  assert.strictEqual(leaked.length, 0,
    `agent-created products must stay unlisted until a human lists them: ${JSON.stringify(leaked)}`);
  console.log('ok   no agent-created product is live in the database right now');

  // --- 4. uniqueness, so a repeated reading cannot duplicate ---------------
  const idx = await sql("select indexdef from pg_indexes where tablename = 'saree_catalog'");
  const defs = idx.map((r) => r.indexdef).join('\n');
  assert.match(defs, /UNIQUE INDEX \w+ ON public\.saree_catalog USING btree \(sku\)/, 'sku must be unique');
  console.log('ok   sku is unique, so a repeated reading cannot duplicate a product');

  console.log('\nall draft-safety checks passed');
})().catch((e) => { console.error('\nFAILED: ' + e.message); process.exit(1); });
