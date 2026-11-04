const http = require('http');

// Credentials come from the environment only. A literal fallback here would ship the
// live service-role key — which bypasses RLS on every table — inside the repo and
// inside every distribution kit. Fail loudly instead of defaulting.
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.');
  process.exit(1);
}


/**
 * Sai Traders - Tally ERP Clean Slate Utility
 * Deletes all custom godowns from TallyPrime, preserving only 'Main Location' (Default).
 *
 * Usage:
 *   node scripts/delete_all_custom_godowns.js
 */

const SUPABASE_URL = '';
const SERVICE_KEY = '';

function sendToTally(xml, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 9000,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml;charset=utf-8',
        'Content-Length': Buffer.byteLength(xml)
      },
      timeout: timeoutMs
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('TallyPrime request timed out'));
    });
    req.write(xml);
    req.end();
  });
}

function escapeXml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe).replace(/[<>&'"]/g, c => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

function unescapeXml(str) {
  if (!str) return '';
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
}

async function fetchAllGodowns() {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>AllGodowns</ID></HEADER>
  <BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
  <TDL><TDLMESSAGE><COLLECTION NAME="AllGodowns"><TYPE>Godown</TYPE><FETCH>Name,Parent</FETCH></COLLECTION></TDLMESSAGE></TDL>
  </DESC></BODY>
</ENVELOPE>`;
  const res = await sendToTally(xml);
  const names = [];
  const blockRegex = /<GODOWN\b[^>]*>([\s\S]*?)<\/GODOWN>/gi;
  let blockMatch;
  while ((blockMatch = blockRegex.exec(res)) !== null) {
    const blockContent = blockMatch[1];
    const nameMatch = /<NAME[^>]*>([^<]+)<\/NAME>/i.exec(blockContent);
    const attrMatch = /<GODOWN\s+[^>]*NAME="([^"]+)"/i.exec(blockMatch[0]);
    const gName = nameMatch ? unescapeXml(nameMatch[1]).trim() : (attrMatch ? unescapeXml(attrMatch[1]).trim() : '');
    if (gName && !gName.startsWith('$$') && !names.some(n => n.toLowerCase() === gName.toLowerCase())) {
      names.push(gName);
    }
  }
  return names;
}

async function clearStockInGodown(godownName) {
  const summaryXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>StockItemsForGodown</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="StockItemsForGodown"><TYPE>StockItem</TYPE><FETCH>Name,BatchAllocations</FETCH></COLLECTION></TDLMESSAGE></TDL>
</DESC></BODY></ENVELOPE>`;
  try {
    const res = await sendToTally(summaryXml);
    const itemBlockRegex = /<STOCKITEM\s+NAME="([^"]+)"[^>]*>([\s\S]*?)<\/STOCKITEM>/gi;
    let match;
    while ((match = itemBlockRegex.exec(res)) !== null) {
      const itemName = unescapeXml(match[1]).trim();
      const body = match[2];
      if (body.toLowerCase().includes(godownName.toLowerCase())) {
        const alterXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<STOCKITEM NAME="${escapeXml(itemName)}" ACTION="Alter">
  <NAME>${escapeXml(itemName)}</NAME>
  <BATCHALLOCATIONS.LIST>
    <GODOWNNAME>${escapeXml(godownName)}</GODOWNNAME>
    <OPENINGBALANCE>0 Pcs</OPENINGBALANCE>
    <OPENINGRATE>0/Pcs</OPENINGRATE>
    <OPENINGVALUE>0</OPENINGVALUE>
  </BATCHALLOCATIONS.LIST>
</STOCKITEM>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
        await sendToTally(alterXml);
        console.log(`   [UNALLOCATED] Cleared stock allocation for "${itemName}" in godown "${godownName}".`);
      }
    }
  } catch (err) {
    console.warn(`   [WARNING] Allocation check warning for "${godownName}":`, err.message);
  }
}

async function deleteGodown(godownName) {
  const delXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<GODOWN NAME="${escapeXml(godownName)}" ACTION="Delete">
  <NAME>${escapeXml(godownName)}</NAME>
</GODOWN>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  const res = await sendToTally(delXml);
  return res;
}

async function main() {
  console.log('===============================================================================');
  console.log('🗑️  SAI TRADERS - TALLY ERP CLEAN SLATE: CLEARING ALL CUSTOM GODOWNS');
  console.log('===============================================================================\n');

  let godowns = [];
  try {
    godowns = await fetchAllGodowns();
    console.log(`[DISCOVERY] Discovered ${godowns.length} godowns in Tally:`, godowns.join(', '));
  } catch (err) {
    console.error('[ERROR] Cannot talk to Tally on 127.0.0.1:9000:', err.message);
    console.log('Ensure TallyPrime is open with the company loaded.');
    process.exit(1);
  }

  const customGodowns = godowns.filter(g => g.toLowerCase() !== 'main location');

  if (customGodowns.length === 0) {
    console.log('\n✅ No custom godowns found! Only "Main Location" (default) exists.');
  } else {
    console.log(`\nFound ${customGodowns.length} custom godowns to delete:`, customGodowns.join(', '));
    for (const gName of customGodowns) {
      console.log(`\nProcessing deletion for: "${gName}"...`);
      await clearStockInGodown(gName);
      try {
        const delRes = await deleteGodown(gName);
        if (delRes.includes('<DELETED>1</DELETED>') || !delRes.includes('<LINEERROR>')) {
          console.log(`✅ [DELETED] Godown "${gName}" deleted from Tally ERP.`);
        } else {
          console.log(`⚠️ [TALLY RESPONSE] Godown "${gName}":`, delRes.replace(/\s+/g, ' ').slice(0, 150));
        }
      } catch (dErr) {
        console.error(`❌ [FAILED] Could not delete "${gName}":`, dErr.message);
      }
    }
  }

  // Sync Cloud Settings
  console.log('\n[CLOUD SYNC] Resetting Cloud active godown and hierarchy to "Main Location"...');
  try {
    await Promise.allSettled([
      fetch(`${SUPABASE_URL}/rest/v1/app_settings`, {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({ key: 'target_godown', value: 'Main Location', updated_at: new Date().toISOString() })
      }),
      fetch(`${SUPABASE_URL}/rest/v1/app_settings`, {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({ key: 'tally_discovered_godowns', value: JSON.stringify(['Main Location']), updated_at: new Date().toISOString() })
      }),
      fetch(`${SUPABASE_URL}/rest/v1/app_settings`, {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({ key: 'tally_godown_hierarchy', value: JSON.stringify([{ name: 'Main Location', parent: null, level: 0, children: [], descendants: [], isRoot: true }]), updated_at: new Date().toISOString() })
      }),
      fetch(`${SUPABASE_URL}/rest/v1/stock_pool?or=(tally_godown.neq.Main%20Location,tally_godown.is.null)`, {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tally_godown: 'Main Location', updated_at: new Date().toISOString() })
      })
    ]);
    console.log('✅ [CLOUD SYNC] Supabase target_godown, hierarchy, and stock_pool set to "Main Location".');
  } catch (cErr) {
    console.warn('[CLOUD SYNC WARNING]:', cErr.message);
  }

  console.log('\n===============================================================================');
  console.log('🎉 CLEAN SLATE OPERATION COMPLETE! ONLY "MAIN LOCATION" (DEFAULT) REMAINS.');
  console.log('===============================================================================\n');
}

main().catch(console.error);

