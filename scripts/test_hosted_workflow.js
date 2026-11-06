/**
 * The whole saree workflow, from a browser with no store server behind it.
 *
 * The hosted dashboard is static files. Every /api call used to reach the host and come
 * back as its 404 page, so the first thing anyone saw after signing in was an error
 * about a screen needing the store server. These are the actions the documented workflow
 * depends on, exercised exactly as the browser does: reads straight from Supabase under
 * the member's own session, writes through the edge function.
 *
 * It creates its own saree, drives it to on-sale, and removes it.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const get = (k) => (env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [, ''])[1].trim();

const base = get('SUPABASE_URL');
const ANON = get('SUPABASE_ANON_KEY');
const SERVICE = get('SUPABASE_SERVICE_ROLE_KEY');
const SVC = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };

const SKU = 'ZZ-HOSTED-CHECK';
const EMAIL = 'hosted-check@saitraders.invalid';
const PASSWORD = process.argv[2] || 'Hosted-check-pw-2611';

let userId = null;
let token = null;

const svc = (p, o) => fetch(`${base}/rest/v1/${p}`, { headers: SVC, ...o });
const asMember = (p) => fetch(`${base}/rest/v1/${p}`, {
  headers: { apikey: ANON, Authorization: `Bearer ${token}` },
}).then((r) => r.json());
const fn = (action, body) => fetch(`${base}/functions/v1/agent-sync/${action}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
}).then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) }));

(async () => {
  const [shop] = await svc('shops?select=id,settings&limit=1').then((r) => r.json());

  // --- a member to act as --------------------------------------------------
  const existing = await fetch(`${base}/auth/v1/admin/users?per_page=200`, { headers: SVC }).then((r) => r.json());
  for (const u of existing.users || []) {
    if (u.email === EMAIL) await fetch(`${base}/auth/v1/admin/users/${u.id}`, { method: 'DELETE', headers: SVC });
  }
  const created = await fetch(`${base}/auth/v1/admin/users`, {
    method: 'POST', headers: SVC,
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, email_confirm: true }),
  }).then((r) => r.json());
  assert.ok(created.id, `could not create a test member: ${JSON.stringify(created).slice(0, 200)}`);
  userId = created.id;
  await svc('shop_members', { method: 'POST', body: JSON.stringify([{ user_id: userId, shop_id: shop.id, role: 'staff' }]) });

  const session = await fetch(`${base}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  }).then((r) => r.json());
  assert.ok(session.access_token, `sign-in failed: ${JSON.stringify(session).slice(0, 200)}`);
  token = session.access_token;
  console.log('ok   signed in as a shop member');

  // --- a saree as the agent drafts it --------------------------------------
  await svc(`saree_catalog?sku=eq.${SKU}`, { method: 'DELETE' });
  await svc('saree_catalog', {
    method: 'POST',
    body: JSON.stringify([{
      shop_id: shop.id, sku: SKU, tally_part_number: SKU, name: SKU,
      fabric: 'Unspecified', color_primary: 'Unspecified', price: 0, stock_quantity: 3,
      is_active: false, status: 'pending_review',
      item_created_in_tally: true, stock_added_in_tally: true, created_by: 'agent',
    }]),
  });

  // --- the reads the dashboard makes on load -------------------------------
  const shops = await asMember('shops?select=name,settings');
  assert.strictEqual(shops.length, 1, 'the dashboard must see exactly one shop');

  const godownSettings = await asMember('app_settings?select=value&key=eq.tally_godown_stock_matrix');
  assert.strictEqual(godownSettings.length, 1, 'the godown list needs the stock matrix');
  console.log(`ok   it can read the shop and the godown "${shops[0].settings.online_godown}"`);

  const drafts = await asMember('saree_catalog?select=sku&status=in.(pending_review,draft)&is_active=eq.false');
  assert.ok(drafts.some((d) => d.sku === SKU), 'the new saree must appear in the drafts list');
  console.log(`ok   it appears in the list of sarees needing details (${drafts.length} waiting)`);

  // --- name and price ------------------------------------------------------
  let r = await fn('update-product', { code: SKU, name: 'Hosted Check Silk Saree', price: 7500, fabric: 'Pure Silk' });
  assert.ok(r.ok, `naming it failed: ${JSON.stringify(r.body).slice(0, 200)}`);
  assert.strictEqual(r.body.listed, false, 'it cannot be on sale with no photo or video');
  assert.ok(r.body.needs.includes('at least one photo'), `expected photos to be outstanding: ${r.body.needs}`);
  console.log(`ok   named and priced from the browser; still needs: ${r.body.needs.join(', ')}`);

  // --- a photo, uploaded by the member and attached ------------------------
  // The smallest valid PNG, so storage has something real to accept.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64'
  );
  const objectPath = `${SKU}/${Date.now()}.png`;
  const put = await fetch(`${base}/storage/v1/object/saree-catalog-images/${objectPath}`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'image/png', 'x-upsert': 'true' },
    body: png,
  });
  assert.ok(put.ok, `a member could not upload a photo: HTTP ${put.status} ${(await put.text()).slice(0, 160)}`);
  console.log('ok   a member can upload a photo straight to storage');

  const photoUrl = `${base}/storage/v1/object/public/saree-catalog-images/${objectPath}`;
  r = await fn('attach-photo', { code: SKU, url: photoUrl });
  assert.ok(r.ok, `attaching the photo failed: ${JSON.stringify(r.body).slice(0, 200)}`);
  assert.ok(r.body.needs.includes('a verified video'), `expected the video to be outstanding: ${r.body.needs}`);
  console.log(`ok   photo attached; still needs: ${r.body.needs.join(', ')}`);

  // A photo from anywhere else must be refused, or a browser could point a product at
  // any image on the internet.
  const foreign = await fn('attach-photo', { code: SKU, url: 'https://example.invalid/someone-elses.jpg' });
  assert.strictEqual(foreign.status, 400, 'a photo URL outside the catalogue bucket must be refused');
  console.log('ok   a photo URL from outside the catalogue bucket is refused');

  // --- the video, which completes the set ----------------------------------
  // This saree does not exist in Tally, so a live reading correctly marks it as not
  // confirmed there — the agent is right and the test is the odd one out. Re-assert the
  // confirmation immediately before the last step, which is what the agent would be
  // doing for a real saree.
  await svc(`saree_catalog?sku=eq.${SKU}`, {
    method: 'PATCH',
    body: JSON.stringify({ item_created_in_tally: true, stock_added_in_tally: true }),
  });

  r = await fn('add-video', { product_code: SKU, notes: 'hosted workflow check' });
  assert.ok(r.ok, `adding the video failed: ${JSON.stringify(r.body).slice(0, 200)}`);
  assert.strictEqual(r.body.listed, true, `it should be on sale now: still needs ${r.body.needs}`);
  console.log('ok   the video completed the set and it went on sale by itself');

  const live = await svc(`saree_catalog?select=status,is_active&sku=eq.${SKU}`).then((x) => x.json());
  assert.strictEqual(live[0].status, 'listed');
  assert.strictEqual(live[0].is_active, true);
  console.log('ok   listed and active in the database');

  // --- withdrawing it and putting it back ----------------------------------
  r = await fn('set-off-sale', { code: SKU });
  assert.ok(r.ok && r.body.offSale, `withdrawing it failed: ${JSON.stringify(r.body).slice(0, 200)}`);
  const off = await svc(`saree_catalog?select=status,is_active&sku=eq.${SKU}`).then((x) => x.json());
  assert.strictEqual(off[0].is_active, false, 'a withdrawn saree must not be active');
  console.log('ok   withdrawn from sale from the browser');

  r = await fn('set-off-sale', { code: SKU, restore: true });
  assert.ok(r.ok, `putting it back failed: ${JSON.stringify(r.body).slice(0, 200)}`);
  assert.strictEqual(r.body.listed, true, 'it met every condition, so it should be back on sale');
  console.log('ok   put back on sale');

  // --- and none of it works without a session ------------------------------
  const saved = token;
  token = ANON;
  for (const action of ['update-product', 'set-off-sale', 'add-video', 'attach-photo']) {
    const res = await fn(action, { code: SKU });
    assert.strictEqual(res.status, 401, `${action} accepted a caller with no session`);
  }
  token = saved;
  console.log('ok   every one of them refuses a caller with no session');

  console.log('\nall hosted workflow checks passed');
})()
  .catch((e) => { console.error('\nFAILED: ' + e.message); process.exitCode = 1; })
  .finally(async () => {
    await svc(`saree_catalog?sku=eq.${SKU}`, { method: 'DELETE' });
    await svc(`video_item?product_code=eq.${SKU}`, { method: 'DELETE' });
    await svc(`video_record?product_code=eq.${SKU}`, { method: 'DELETE' });
    if (userId) {
      await svc(`shop_members?user_id=eq.${userId}`, { method: 'DELETE' });
      await fetch(`${base}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: SVC });
    }
    console.log('cleaned up the test saree, its media and the test member');
  });
