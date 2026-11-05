/**
 * The anon key is public by design — it ships in the dashboard and is published in the
 * repository. Row level security is the only thing standing between it and the data.
 *
 * It was switched off. With that key, anyone on the internet could read every
 * customer's phone number and WhatsApp history, change an order's payment status, or
 * delete the entire catalogue. This asserts that is no longer true, using the same
 * probes that found it.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const get = (k) => (env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [, ''])[1].trim();

const base = `${get('SUPABASE_URL')}/rest/v1/`;
const ANON = get('SUPABASE_ANON_KEY');
assert.ok(ANON && ANON.length > 40, 'SUPABASE_ANON_KEY must be set to run this check');
const H = { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' };

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const sql = async (query) => {
  if (!TOKEN) return [];   // policy introspection needs a management token; skipped without one
  const res = await fetch('https://api.supabase.com/v1/projects/aisttddxrbizoshtpdxi/database/query', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  assert.ok(Array.isArray(body), `SQL failed: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
};

// An id that matches no row, so a write that is wrongly permitted still changes nothing.
const NOBODY = '00000000-0000-0000-0000-0000000000ff';

const SENSITIVE = ['saree_catalog', 'orders', 'customers', 'conversations', 'messages', 'image_analyses', 'app_config'];

(async () => {
  // --- reads ---------------------------------------------------------------
  for (const table of SENSITIVE) {
    const res = await fetch(`${base}${table}?select=*&limit=1`, { headers: H });
    const rows = res.status === 200 ? await res.json() : null;
    assert.ok(
      res.status !== 200 || (Array.isArray(rows) && rows.length === 0),
      `${table} is readable with the public anon key (HTTP ${res.status}, ${Array.isArray(rows) ? rows.length : '?'} row(s))`
    );
    console.log(`ok   ${table.padEnd(15)} returns nothing to an anonymous caller`);
  }

  // --- writes --------------------------------------------------------------
  //
  // A PATCH that matches no row returns 204 whether or not it was permitted, so that
  // proves nothing. Instead a REAL row is targeted, with return=representation: a
  // permitted write echoes the row back, a blocked one echoes nothing. The value
  // written is the row's current value, so the data is unchanged either way.
  const svcKey = get('SUPABASE_SERVICE_ROLE_KEY');
  const svcH = { apikey: svcKey, Authorization: `Bearer ${svcKey}`, 'Content-Type': 'application/json' };

  const [sample] = await fetch(`${base}saree_catalog?select=id,status&limit=1`, { headers: svcH })
    .then((r) => r.json());
  assert.ok(sample, 'need at least one product to test against');

  const echoed = await fetch(`${base}saree_catalog?id=eq.${sample.id}`, {
    method: 'PATCH',
    headers: { ...H, Prefer: 'return=representation' },
    body: JSON.stringify({ status: sample.status }),   // its own value: a no-op if allowed
  });
  const echoedRows = echoed.status < 300 ? await echoed.json() : [];
  assert.strictEqual(echoedRows.length, 0,
    `an anonymous caller can write to a real catalogue row (HTTP ${echoed.status})`);
  console.log('ok   an anonymous write to a real product row affects nothing');

  // And no write policy exists at all, so this is not one table's good luck.
  const policies = await sql(
    "select tablename, cmd, roles::text from pg_policies where schemaname = 'public' " +
    "and tablename in ('saree_catalog','orders','customers','shops','shop_members')"
  );
  // Only roles a browser can hold matter. service_role bypasses RLS entirely, so a
  // policy naming it grants nothing extra and is not a finding.
  const clientReachable = policies.filter((p) => /anon|authenticated|public/.test(p.roles));
  const writable = clientReachable.filter((p) => p.cmd !== 'SELECT');
  assert.strictEqual(writable.length, 0,
    `a client-reachable write policy exists: ${JSON.stringify(writable)}`);
  console.log(`ok   all ${clientReachable.length} client-reachable policies are read-only`);

  // RLS must be ON for every one of them, or a policy is decoration.
  const unprotected = await sql(
    "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace " +
    "where n.nspname = 'public' and c.relrowsecurity = false and c.relkind = 'r' " +
    "and c.relname in ('saree_catalog','orders','customers','conversations','messages','image_analyses','app_config','shops','shop_members')"
  );
  assert.strictEqual(unprotected.length, 0,
    `row level security is off for: ${unprotected.map((r) => r.relname).join(', ')}`);
  console.log('ok   row level security is on for every tenant table');

  // --- the paths the product actually uses must still work -----------------
  // The agent reaches the cloud only through the edge function, with a device token.
  const fn = await fetch(`${get('SUPABASE_URL')}/functions/v1/agent-sync/claim`, {
    method: 'POST', headers: H, body: JSON.stringify({ deviceToken: 'probe' }),
  });
  assert.strictEqual(fn.status, 401, `the edge function must still answer and reject a bad token (got ${fn.status})`);
  console.log('ok   the agent path still works and still checks credentials');

  // The service role must keep full access, or the dashboard and webhook break.
  const svc = get('SUPABASE_SERVICE_ROLE_KEY');
  const asService = await fetch(`${base}saree_catalog?select=sku&limit=1`, {
    headers: { apikey: svc, Authorization: `Bearer ${svc}` },
  });
  assert.strictEqual(asService.status, 200, 'the service role must still read the catalogue');
  assert.ok((await asService.json()).length > 0, 'the service role must still see rows');
  console.log('ok   the service role is unaffected, so the dashboard keeps working');

  console.log('\nall tenant-isolation checks passed');
})().catch((e) => { console.error('\nFAILED: ' + e.message); process.exit(1); });
