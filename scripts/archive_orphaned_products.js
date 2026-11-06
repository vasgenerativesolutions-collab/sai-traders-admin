/**
 * Archive products that no longer exist in the shop's Tally company.
 *
 *   node scripts/archive_orphaned_products.js          show what would change
 *   node scripts/archive_orphaned_products.js --yes    apply it
 *
 * When a shop is bound to a different Tally company, the products from the previous
 * one stay in the catalogue. They show up as permanently out of stock, which is worse
 * than absent: the dashboard looks wrong and a customer can be shown a saree the shop
 * has no record of.
 *
 * Products are ARCHIVED, never deleted. Photos, prices and descriptions are real work
 * and survive, so a mistake here is undone by setting the status back.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const get = (k) => (env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [, ''])[1].trim();

const base = get('SUPABASE_URL');
const KEY = get('SUPABASE_SERVICE_ROLE_KEY');
if (!base || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env'); process.exit(2); }

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const api = (p, o) => fetch(`${base}/rest/v1/${p}`, { headers: H, ...o });

const apply = process.argv.includes('--yes');

(async () => {
  const [shops, settings] = await Promise.all([
    api('shops?select=id,name,settings&limit=1').then((r) => r.json()),
    api('app_settings?key=eq.tally_godown_stock_matrix&select=value,updated_at').then((r) => r.json()),
  ]);

  const shop = shops[0];
  if (!shop) { console.error('no shop row'); process.exit(1); }
  const row = settings[0];
  if (!row) { console.error('Tally stock has never been read — nothing to compare against'); process.exit(1); }

  const matrix = typeof row.value === 'string' ? JSON.parse(row.value) : (row.value || {});
  const inTally = new Set(Object.keys(matrix).map((k) => k.toLowerCase()));

  // Refuse to act on a reading that cannot be trusted. An empty or stale picture would
  // archive the entire catalogue — the same trap as zeroing stock on an empty read.
  const ageMin = (Date.now() - new Date(row.updated_at).getTime()) / 60000;
  if (!inTally.size) {
    console.error('The last reading found no stock items at all. Refusing to archive the whole catalogue.');
    process.exit(1);
  }
  if (ageMin > 30) {
    console.error(`The last reading is ${Math.round(ageMin)} minutes old. Start the agent and try again.`);
    process.exit(1);
  }

  const catalog = await api(
    'saree_catalog?select=id,sku,tally_part_number,name,status,is_active,stock_quantity,price,image_urls' +
    `&shop_id=eq.${shop.id}`
  ).then((r) => r.json());

  const orphans = catalog.filter((p) => {
    if (p.status === 'archived' || p.status === 'deleted') return false; // already gone
    const sku = String(p.sku || '').trim().toLowerCase();
    const part = String(p.tally_part_number || '').trim().toLowerCase();
    return !(sku && inTally.has(sku)) && !(part && inTally.has(part));
  });

  console.log('');
  console.log(`Shop     ${shop.name}`);
  console.log(`Company  ${shop.settings?.tally_company || '(unnamed)'}  ${shop.settings?.tally_guid || ''}`);
  console.log(`Reading  ${Math.round(ageMin)} min old, ${inTally.size} item(s) in Tally: ${[...inTally].join(', ')}`);
  console.log('');

  if (!orphans.length) { console.log('Nothing to archive — every product matches an item in Tally.'); return; }

  console.log(`${orphans.length} product(s) have no item in this Tally company:`);
  for (const p of orphans) {
    const photos = (p.image_urls || []).length;
    console.log(`  ${String(p.sku).padEnd(14)} price=${String(p.price).padEnd(7)} ${photos} photo(s)  ${(p.name || '').slice(0, 32)}`);
  }
  console.log('');

  if (!apply) {
    console.log('Nothing was changed. Re-run with --yes to archive these.');
    console.log('Archiving is reversible: it sets status to archived and keeps photos and prices.');
    return;
  }

  const res = await api(`saree_catalog?id=in.(${orphans.map((p) => p.id).join(',')})`, {
    method: 'PATCH',
    headers: { ...H, Prefer: 'return=representation' },
    body: JSON.stringify({
      status: 'archived',
      is_active: false,
      stock_quantity: 0,
      // Record that Tally no longer holds these. The dashboard uses this to tell a
      // product left behind by a previous company, which should disappear, from one the
      // shop still holds but has withdrawn from sale, which must stay visible so it can
      // be put back. Leaving the flag set made the old company's items reappear.
      item_created_in_tally: false,
      stock_added_in_tally: false,
      listing_notes: 'Archived automatically: no matching item in the shop\'s current Tally company.',
      updated_at: new Date().toISOString(),
    }),
  });

  if (!res.ok) { console.error(`Archiving failed: HTTP ${res.status} ${await res.text()}`); process.exit(1); }
  const changed = await res.json();
  console.log(`Archived ${changed.length} product(s). Photos and prices are kept.`);
  console.log('To bring one back, set its status to draft and is_active to true.');
})().catch((err) => { console.error(err.message); process.exit(1); });
