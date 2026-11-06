/**
 * Getting a saree from Tally to on sale.
 *
 * Five conditions are enforced in the database before a saree can be sold online: a
 * name, a selling price, at least one photo, a verified video, and confirmation in
 * Tally. They are satisfied at different moments by different people, so the question
 * that matters is whether the LAST one to arrive puts the saree on sale — checking only
 * while editing left a ready saree sitting unlisted because nothing looked again.
 *
 * This walks the conditions one at a time against the live project and asserts the
 * saree goes on sale exactly when the set is complete, then puts everything back.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const get = (k) => (env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [, ''])[1].trim();
const base = get('SUPABASE_URL');
const KEY = get('SUPABASE_SERVICE_ROLE_KEY');
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const api = (p, o) => fetch(`${base}/rest/v1/${p}`, { headers: H, ...o });

const SKU = 'ZZ-LISTING-CHECK';
let shopId = null;
let createdVideo = false;

async function state() {
  const [row] = await api(`saree_catalog?select=status,is_active,name,price,image_urls&sku=eq.${SKU}`).then((r) => r.json());
  return row;
}

async function tryList() {
  // Mirrors what the server does: ask the database to list it and see whether the
  // guard allows it. Using the real trigger is the point — a reimplementation of the
  // rule proves nothing about the rule.
  const res = await api(`saree_catalog?sku=eq.${SKU}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'listed', is_active: true }),
  });
  if (res.ok) return { listed: true };
  const body = await res.text();
  // The message names the saree: "Cannot list ZZ-LISTING-CHECK: missing selling price".
  const why = (body.match(/Cannot list [^:]*: ([^"\\]+)/) || [, body.slice(0, 80)])[1];
  return { listed: false, why: why.trim() };
}

(async () => {
  const [shop] = await api('shops?select=id&limit=1').then((r) => r.json());
  shopId = shop.id;

  await api(`saree_catalog?sku=eq.${SKU}`, { method: 'DELETE' });

  // --- a saree as the agent drafts it from Tally ----------------------------
  const created = await api('saree_catalog', {
    method: 'POST',
    headers: { ...H, Prefer: 'return=representation' },
    body: JSON.stringify([{
      shop_id: shopId,
      sku: SKU,
      tally_part_number: SKU,
      name: SKU,                 // named by its stock code, which is all Tally has
      fabric: 'Unspecified',
      color_primary: 'Unspecified',
      price: 0,
      stock_quantity: 4,
      is_active: false,
      status: 'pending_review',
      item_created_in_tally: true,
      stock_added_in_tally: true,
      created_by: 'agent',
    }]),
  }).then((r) => r.json());
  assert.ok(created[0] && created[0].id, `could not create the test saree: ${JSON.stringify(created).slice(0, 200)}`);
  console.log('ok   drafted from Tally: named by its stock code, no price, not on sale');

  // A saree still carrying its stock code has not been named for anyone to read.
  let r = await tryList();
  assert.strictEqual(r.listed, false, 'a saree named after its Tally code must not be listed');
  assert.match(r.why, /named after its Tally code/i, `expected the name to be what is missing, got: ${r.why}`);
  console.log(`ok   refused, and says why: ${r.why}`);

  // --- a real name ----------------------------------------------------------
  await api(`saree_catalog?sku=eq.${SKU}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'Royal Green Kanjivaram Silk Saree' }),
  });
  r = await tryList();
  assert.strictEqual(r.listed, false, 'a saree with no price must not be listed');
  assert.match(r.why, /price/i, `expected the price to be what is missing, got: ${r.why}`);
  console.log(`ok   named, still refused: ${r.why}`);

  // --- a price --------------------------------------------------------------
  await api(`saree_catalog?sku=eq.${SKU}`, { method: 'PATCH', body: JSON.stringify({ price: 10000 }) });
  r = await tryList();
  assert.strictEqual(r.listed, false, 'a saree with no photo must not be listed');
  assert.match(r.why, /photo/i, `expected photos to be what is missing, got: ${r.why}`);
  console.log(`ok   priced, still refused: ${r.why}`);

  // --- a photo --------------------------------------------------------------
  await api(`saree_catalog?sku=eq.${SKU}`, {
    method: 'PATCH',
    body: JSON.stringify({ image_urls: ['https://example.invalid/not-a-real-photo.jpg'] }),
  });
  r = await tryList();
  assert.strictEqual(r.listed, false, 'a saree with no verified video must not be listed');
  assert.match(r.why, /video/i, `expected the video to be what is missing, got: ${r.why}`);
  console.log(`ok   photographed, still refused: ${r.why}`);

  // --- a verified video -----------------------------------------------------
  const vidId = `vid_${SKU.toLowerCase()}_check`;
  await api('video_record', {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{ video_id: vidId, product_code: SKU, is_active: true }]),
  });
  await api('video_item', {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{ video_id: vidId, product_code: SKU, verified: true }]),
  });
  createdVideo = true;

  r = await tryList();
  assert.strictEqual(r.listed, true, `the saree met every condition but was still refused: ${r.why}`);
  console.log('ok   with a verified video, it goes on sale');

  const live = await state();
  assert.strictEqual(live.status, 'listed');
  assert.strictEqual(live.is_active, true);
  console.log('ok   it is listed and active');

  // --- and Tally confirmation is genuinely required -------------------------
  await api(`saree_catalog?sku=eq.${SKU}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'pending_review', is_active: false, stock_added_in_tally: false }),
  });
  r = await tryList();
  assert.strictEqual(r.listed, false, 'a saree not confirmed in Tally must not be listed');
  assert.match(r.why, /tally/i, `expected Tally confirmation to be what is missing, got: ${r.why}`);
  console.log(`ok   without Tally confirmation it is refused: ${r.why}`);

  // --- the server calls this from every path that can complete the set ------
  const src = fs.readFileSync(path.join(ROOT, 'admin', 'server.js'), 'utf8');
  for (const route of ["app.patch('/api/products/:id'", "app.post('/api/upload-photo'", "app.post('/api/videos'"]) {
    const at = src.indexOf(route);
    assert.ok(at > 0, `${route} not found`);
    const body = src.slice(at, at + 6000);
    assert.ok(body.includes('tryListProduct'),
      `${route} can complete the set but never looks again, so a ready saree would sit unlisted`);
  }
  console.log('ok   editing, photo upload and video all re-check the conditions');

  console.log('\nall listing-path checks passed');
})()
  .catch((e) => { console.error('\nFAILED: ' + e.message); process.exitCode = 1; })
  .finally(async () => {
    await api(`saree_catalog?sku=eq.${SKU}`, { method: 'DELETE' });
    if (createdVideo) {
      await api(`video_item?product_code=eq.${SKU}`, { method: 'DELETE' });
      await api(`video_record?product_code=eq.${SKU}`, { method: 'DELETE' });
    }
    console.log('cleaned up the test saree and its video');
  });
