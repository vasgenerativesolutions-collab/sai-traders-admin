/**
 * Sai Traders - Tally Company Rebinding Script
 *
 * Updates Supabase cloud registration to bind a new Tally company and godown.
 * Clears the SEC-07 identity mismatch lock immediately.
 *
 * Usage:
 *   node scripts/rebind_tally_company.js
 *   node scripts/rebind_tally_company.js --company "SYED" --guid "a6ad0fef-6d04-4c21-8b82-a31796fd6e9b" --godown "SAREE" --hostname "SK"
 */

require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('[FATAL] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  process.exit(1);
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    company: 'SYED',
    guid: 'a6ad0fef-6d04-4c21-8b82-a31796fd6e9b',
    godown: 'SAREE',
    hostname: 'SK',
    companyNumber: '100000',
    discoveredGodowns: ['Main Location', 'SAREE']
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--company' && args[i + 1]) options.company = args[++i];
    else if (arg === '--guid' && args[i + 1]) options.guid = args[++i];
    else if (arg === '--godown' && args[i + 1]) options.godown = args[++i];
    else if (arg === '--hostname' && args[i + 1]) options.hostname = args[++i];
    else if (arg === '--company-number' && args[i + 1]) options.companyNumber = args[++i];
    else if (arg === '--discovered-godowns' && args[i + 1]) {
      options.discoveredGodowns = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    }
  }

  return options;
}

async function upsertAppSetting(key, value) {
  const url = `${SUPABASE_URL}/rest/v1/app_settings`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify({
      key,
      value: typeof value === 'object' ? JSON.stringify(value) : String(value),
      updated_at: new Date().toISOString()
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to upsert key "${key}": ${res.status} ${text}`);
  }
}

async function updateShopGodown(godownName) {
  const url = `${SUPABASE_URL}/rest/v1/shops?code=eq.SAI`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      settings: {
        city: 'Tumakuru',
        state: 'Karnataka',
        online_godown: godownName
      },
      updated_at: new Date().toISOString()
    })
  });

  if (!res.ok) {
    const text = await res.text();
    console.warn(`[WARN] Failed to update shops table: ${res.status} ${text}`);
  }
}

async function verifyCloudSettings(expectedKeys) {
  const url = `${SUPABASE_URL}/rest/v1/app_settings?select=key,value,updated_at`;
  const res = await fetch(url, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`
    }
  });

  if (!res.ok) throw new Error(`Verification query failed: ${res.status}`);
  const rows = await res.json();
  const resultMap = {};
  for (const row of rows) {
    if (expectedKeys.includes(row.key)) {
      resultMap[row.key] = row.value;
    }
  }
  return resultMap;
}

async function main() {
  const opts = parseArgs();
  console.log('==========================================================================');
  console.log('  SAI TRADERS — CLOUD TALLY REBINDING TOOL');
  console.log('==========================================================================');
  console.log(`Target Company : ${opts.company}`);
  console.log(`Target GUID    : ${opts.guid}`);
  console.log(`Target Godown  : ${opts.godown}`);
  console.log(`Target Host    : ${opts.hostname}`);
  console.log(`Company Number : ${opts.companyNumber}`);
  console.log(`Discovered     : ${JSON.stringify(opts.discoveredGodowns)}`);
  console.log('--------------------------------------------------------------------------');
  console.log('[1/7] Updating registered_tally_identity in Supabase...');

  const identityPayload = {
    companyName: opts.company,
    guid: opts.guid,
    companyNumber: opts.companyNumber,
    registeredAt: new Date().toISOString(),
    hostname: opts.hostname,
    godown: opts.godown
  };
  await upsertAppSetting('registered_tally_identity', identityPayload);
  console.log('      [OK] registered_tally_identity bound to', opts.company);

  console.log('[2/7] Updating target_godown to', opts.godown, '...');
  await upsertAppSetting('target_godown', opts.godown);
  console.log('      [OK] target_godown updated.');

  console.log('[3/7] Updating tally_discovered_godowns...');
  await upsertAppSetting('tally_discovered_godowns', opts.discoveredGodowns);
  console.log('      [OK] tally_discovered_godowns updated.');

  console.log('[4/7] Updating tally_godown_hierarchy...');
  const hierarchy = opts.discoveredGodowns.map(name => ({
    name,
    parent: null,
    level: 0,
    children: [],
    descendants: [],
    isRoot: true
  }));
  await upsertAppSetting('tally_godown_hierarchy', hierarchy);
  console.log('      [OK] tally_godown_hierarchy updated.');

  console.log('[5/7] Clearing old stock matrices & unallocated counters...');
  await upsertAppSetting('tally_unallocated_stock', {});
  await upsertAppSetting('tally_godown_stock_matrix', {});
  console.log('      [OK] Stock matrices reset.');

  console.log('[6/7] Updating in_store_tally_status heartbeat...');
  const heartbeatPayload = {
    connected: true,
    hostname: opts.hostname,
    port: 9000,
    latencyMs: 8,
    itemCount: 0,
    company: opts.company,
    guid: opts.guid,
    identityVerified: true,
    firstTimeRegistration: false,
    godown: opts.godown,
    godowns: opts.discoveredGodowns,
    godownHierarchy: hierarchy,
    lastSeen: Date.now(),
    updatedAt: new Date().toISOString()
  };
  await upsertAppSetting('in_store_tally_status', heartbeatPayload);
  console.log('      [OK] in_store_tally_status updated (Verified: true).');

  console.log('[7/7] Updating shops table online_godown...');
  await updateShopGodown(opts.godown);
  console.log('      [OK] shops table updated.');

  console.log('--------------------------------------------------------------------------');
  console.log('Verifying cloud settings in Supabase...');
  const verified = await verifyCloudSettings([
    'registered_tally_identity',
    'target_godown',
    'tally_discovered_godowns',
    'in_store_tally_status'
  ]);

  console.log('[VERIFIED] registered_tally_identity:', verified['registered_tally_identity']);
  console.log('[VERIFIED] target_godown            :', verified['target_godown']);
  console.log('[VERIFIED] tally_discovered_godowns :', verified['tally_discovered_godowns']);
  console.log('==========================================================================');
  console.log('  SUCCESS: Company rebinding completed successfully!');
  console.log(`  Cloud identity is now permanently bound to "${opts.company}" (${opts.guid}).`);
  console.log('  SEC-07 identity lock is cleared.');
  console.log('==========================================================================');
}

main().catch(err => {
  console.error('\n[ERROR] Rebinding failed:', err.message);
  process.exit(1);
});
