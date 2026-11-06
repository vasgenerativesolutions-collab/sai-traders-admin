/**
 * The dashboard must work hosted on its own, with no store server anywhere.
 *
 * Hosted statically, every /api call returned the host's 404 page and the dashboard
 * showed nothing. The shop PC deliberately runs no server and accepts no inbound
 * connection, so there was nothing to point it at either.
 *
 * This signs in as a real member and exercises the paths the dashboard now uses:
 * reads straight from Supabase under row level security, writes through the edge
 * function. It also checks the things that must NOT work.
 *
 *   SAI_TEST_EMAIL=... SAI_TEST_PASSWORD=... node scripts/test_serverless_dashboard.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const get = (k) => (env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [, ''])[1].trim();

const URL_BASE = get('SUPABASE_URL');
const ANON = get('SUPABASE_ANON_KEY');
const EMAIL = process.env.SAI_TEST_EMAIL;
const PASSWORD = process.env.SAI_TEST_PASSWORD;

const rest = (token, p) => fetch(`${URL_BASE}/rest/v1/${p}`, {
  headers: { apikey: ANON, Authorization: `Bearer ${token}` },
});
const fn = (token, action, body) => fetch(`${URL_BASE}/functions/v1/agent-sync/${action}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${token}` },
  body: JSON.stringify(body || {}),
});

(async () => {
  // --- the parts that need no login -----------------------------------------
  // An anonymous visitor must get nothing, whatever the dashboard asks for.
  for (const table of ['saree_catalog', 'agent_devices', 'agent_jobs', 'shops', 'app_settings']) {
    const res = await rest(ANON, `${table}?select=*&limit=1`);
    const rows = res.status === 200 ? await res.json() : [];
    assert.strictEqual(rows.length, 0, `${table} leaks to a signed-out visitor`);
  }
  console.log('ok   a signed-out visitor sees nothing at all');

  // Writing a job must be impossible from a browser, signed in or not. That is why
  // set-stock exists on the edge function rather than as an RLS insert policy.
  const insert = await fetch(`${URL_BASE}/rest/v1/agent_jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${ANON}` },
    body: JSON.stringify([{ shop_id: '00000000-0000-0000-0000-000000000001', type: 'adjust_stock', state: 'pending', payload: {} }]),
  });
  assert.ok(insert.status >= 400, `a browser can queue a Tally job directly (HTTP ${insert.status})`);
  console.log('ok   a browser cannot queue work directly, only through the function');

  // set-stock must refuse a caller with no session.
  const noAuth = await fn(ANON, 'set-stock', { name: 'SAI-SIK-02', targetQuantity: 1 });
  assert.strictEqual(noAuth.status, 401, `set-stock accepted a request with no session (${noAuth.status})`);
  console.log('ok   set-stock refuses a caller with no session');

  if (!EMAIL || !PASSWORD) {
    console.log('\nskipped the signed-in checks: set SAI_TEST_EMAIL and SAI_TEST_PASSWORD to run them');
    console.log('all anonymous checks passed');
    return;
  }

  // --- signed in as a member -------------------------------------------------
  const signIn = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const session = await signIn.json();
  assert.ok(session.access_token, `sign-in failed: ${JSON.stringify(session).slice(0, 200)}`);
  const token = session.access_token;
  console.log(`ok   signed in as ${EMAIL}`);

  // Everything the dashboard's status panel needs.
  const devices = await (await rest(token, 'agent_devices?select=device_name,last_seen_at,tally_reachable,company_loaded,version&status=eq.active')).json();
  assert.ok(Array.isArray(devices) && devices.length >= 1, 'a member must see their own store PC');
  assert.ok(devices[0].device_name, 'the device row must carry a name');

  // Whether the agent is running right now decides what can be verified below. A
  // switched-off shop PC is not a defect in this code, and reporting it as one teaches
  // people to ignore the result.
  const agentAgeSec = (Date.now() - new Date(devices[0].last_seen_at).getTime()) / 1000;
  const agentLive = agentAgeSec < 180;
  console.log(`ok   the store PC is visible: ${devices[0].device_name}, last spoke ${Math.round(agentAgeSec)}s ago`);

  const shops = await (await rest(token, 'shops?select=name,settings')).json();
  assert.strictEqual(shops.length, 1, 'a member must see exactly their own shop');
  assert.ok(shops[0].settings.online_godown, 'the shop must have an online godown set');
  console.log(`ok   the shop is visible: ${shops[0].name}, godown ${shops[0].settings.online_godown}`);

  // The product grid.
  const products = await (await rest(token, 'saree_catalog?select=sku,price,stock_quantity,status&status=not.in.(archived,deleted)')).json();
  assert.ok(products.length > 0, 'a member must see their products');
  console.log(`ok   ${products.length} product(s) visible, archived excluded`);

  // The stock matrix the cards use for their godown breakdown.
  const settings = await (await rest(token, 'app_settings?select=key,value&key=eq.tally_godown_stock_matrix')).json();
  assert.strictEqual(settings.length, 1, 'a member must be able to read the stock matrix');
  console.log('ok   the Tally stock matrix is readable');

  // A credential must stay unreadable even to a signed-in member.
  const secrets = await (await rest(token, 'app_settings?select=key&key=ilike.*TOKEN*')).json();
  assert.strictEqual(secrets.length, 0, `a member can read credential keys: ${JSON.stringify(secrets)}`);
  console.log('ok   credential keys stay hidden from members too');

  // Setting stock, end to end, back to the figure it already holds so nothing moves.
  const subject = products.find((p) => p.sku === 'SAI-SIK-02') || products[0];
  const current = Number(subject.stock_quantity) || 0;
  const queued = await fn(token, 'set-stock', { name: subject.sku, targetQuantity: current });
  const queuedBody = await queued.json();
  assert.ok(queued.ok, `set-stock refused a member: ${JSON.stringify(queuedBody).slice(0, 200)}`);
  assert.ok(queuedBody.jobId, 'set-stock must return a job to watch');
  console.log(`ok   set-stock queued a job for ${queuedBody.item} in ${queuedBody.godown}`);

  // And the member can follow it. Only if the agent is actually running: with the shop
  // PC switched off the job correctly stays pending, which is the offline behaviour
  // working, not a failure.
  if (!agentLive) {
    console.log('skip  the job cannot complete while the store PC is switched off — it stays queued, which is correct');
    console.log('\nall checks that do not need a running store PC passed');
    return;
  }

  let state = 'pending';
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const check = await (await fn(token, 'job-status', { jobId: queuedBody.jobId })).json();
    state = check.state;
    if (state === 'completed' || state === 'failed') {
      assert.strictEqual(state, 'completed', `the job failed: ${check.error}`);
      console.log(`ok   the job completed: ${JSON.stringify(check.result)}`);
      break;
    }
  }
  assert.ok(state === 'completed', `the job never completed (last state: ${state})`);

  // A member must not be able to act on a shop they do not belong to.
  const foreign = await fn(token, 'set-stock', {
    name: subject.sku,
    targetQuantity: current,
    shopId: '00000000-0000-0000-0000-0000000000ff',
  });
  assert.strictEqual(foreign.status, 403, `a member reached another shop (HTTP ${foreign.status})`);
  console.log('ok   a member cannot set stock in a shop they do not belong to');

  console.log('\nall serverless dashboard checks passed');
})().catch((e) => { console.error('\nFAILED: ' + e.message); process.exit(1); });
