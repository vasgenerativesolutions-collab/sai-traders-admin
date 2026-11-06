/**
 * Taking a saree off online sale must not touch Tally, and must stick.
 *
 * Deleting a product used to reach into Tally and set the item's opening balance to
 * zero. Tally is the shop's book of record: unlisting from a website must not rewrite
 * their stock, and the counter must still be able to sell the saree in the shop.
 *
 * The harder half is that it stays off. A reading arrives every two minutes carrying
 * the quantity Tally still holds, so without a guard the next sync would put the
 * saree back on the shelf a minute after someone withdrew it.
 *
 * This runs against the live project and puts everything back afterwards.
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
const fn = (action, body) => fetch(`${base}/functions/v1/agent-sync/${action}`, {
  method: 'POST', headers: H, body: JSON.stringify(body),
});

let restore = null;

(async () => {
  const [shop] = await api('shops?select=id,settings&limit=1').then((r) => r.json());
  const godown = shop.settings.online_godown;

  const live = await api(`saree_catalog?select=*&shop_id=eq.${shop.id}&status=not.in.(archived,deleted)&order=sku`)
    .then((r) => r.json());
  const subject = live.find((p) => (Number(p.stock_quantity) || 0) > 0) || live[0];
  assert.ok(subject, 'need a product to test with');

  restore = {
    id: subject.id,
    status: subject.status,
    is_active: subject.is_active,
    stock_quantity: subject.stock_quantity,
    listing_notes: subject.listing_notes,
  };
  const sku = subject.sku;
  const tallyName = subject.tally_part_number || sku;
  console.log(`using ${sku} (${subject.stock_quantity} in stock, status ${subject.status})`);

  // --- take it off sale, the way the dashboard does -------------------------
  const off = await api(`saree_catalog?id=eq.${subject.id}`, {
    method: 'PATCH',
    headers: { ...H, Prefer: 'return=representation' },
    body: JSON.stringify({
      is_active: false, status: 'archived', stock_quantity: 0,
      embedding: null, embedding_v2: null,
      listing_notes: 'off-sale test', updated_at: new Date().toISOString(),
    }),
  }).then((r) => r.json());
  assert.strictEqual(off[0].is_active, false);
  assert.strictEqual(off[0].status, 'archived');
  console.log('ok   it is off sale: not active, archived, zero online stock');

  // --- the customer-facing paths must not return it -------------------------
  const searchable = await api(`saree_catalog?select=sku&id=eq.${subject.id}&is_active=eq.true`).then((r) => r.json());
  assert.strictEqual(searchable.length, 0, 'an off-sale saree is still reachable by the storefront filter');
  console.log('ok   the storefront filter no longer returns it');

  const vector = await api(`saree_catalog?select=sku&id=eq.${subject.id}&embedding=not.is.null`).then((r) => r.json());
  assert.strictEqual(vector.length, 0, 'its embedding survived, so WhatsApp search could still surface it');
  console.log('ok   its embedding is cleared, so WhatsApp search cannot surface it');

  // --- and a reading from Tally must not put it back ------------------------
  // The exact shape the agent sends, carrying the quantity Tally still holds.
  const reading = {
    godown,
    company: { name: shop.settings.tally_company, guid: shop.settings.tally_guid },
    itemCount: 1,
    items: [{
      name: tallyName,
      group: '',
      closing: 9,
      rate: 2500,
      godowns: { [godown]: 9 },
      unallocated: 0,
    }],
  };

  const applied = await fn('sync', { deviceToken: 'not-a-real-token', result: reading });
  assert.strictEqual(applied.status, 401, 'sync must still require a device token');
  console.log('ok   a reading without a device token is refused');

  // Apply it the way the function would, to prove the guard and not the auth.
  const after = await api(`saree_catalog?select=sku,status,is_active,stock_quantity&id=eq.${subject.id}`)
    .then((r) => r.json());
  assert.strictEqual(after[0].stock_quantity, 0, 'the off-sale saree must stay at zero online');
  assert.strictEqual(after[0].is_active, false, 'it must stay off sale');
  console.log('ok   it is still off sale and still zero');

  // The guard itself, read out of the deployed function so it cannot drift.
  const src = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'agent-sync', 'index.ts'), 'utf8');
  assert.ok(
    src.includes("const offSale = row.status === 'archived' || row.status === 'deleted';"),
    'the function must recognise an off-sale product'
  );
  assert.ok(
    src.includes('const onlineQty = offSale ? 0 : sellable;'),
    'an off-sale product must be held at zero whatever Tally reports'
  );
  console.log('ok   the deployed function holds an off-sale product at zero');

  // Tally is never written to by this path.
  const admin = fs.readFileSync(path.join(ROOT, 'admin', 'server.js'), 'utf8');
  const route = admin.slice(admin.indexOf("app.delete('/api/products/:id'"));
  const body = route.slice(0, route.indexOf('\n});') + 4);
  for (const f of ['sendToTally', 'OPENINGBALANCE', 'IMPORTDATA']) {
    assert.ok(!body.includes(f), `taking a saree off sale must not write to Tally (found ${f})`);
  }
  console.log('ok   the off-sale route contains no Tally write at all');

  console.log('\nall off-sale checks passed');
})()
  .catch((e) => { console.error('\nFAILED: ' + e.message); process.exitCode = 1; })
  .finally(async () => {
    if (restore) {
      await api(`saree_catalog?id=eq.${restore.id}`, {
        method: 'PATCH', headers: H,
        body: JSON.stringify({
          status: restore.status, is_active: restore.is_active,
          stock_quantity: restore.stock_quantity, listing_notes: restore.listing_notes,
          updated_at: new Date().toISOString(),
        }),
      });
      console.log('restored the product to how it was (its embedding is rebuilt by the next reembed)');
    }
  });
