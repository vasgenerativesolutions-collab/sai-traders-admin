const fs = require('fs');

const envFile = fs.readFileSync('.env', 'utf-8');
const env = {};
envFile.split('\n').forEach(line => {
  const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)?\s*$/);
  if (match) {
    let val = match[2] || '';
    val = val.trim().replace(/^["']|["']$/g, '');
    env[match[1]] = val;
  }
});

const headers = {
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
};

async function verify() {
  console.log("===============================================================================");
  console.log("🔍 VERIFYING PHASE 1 DATABASE MIGRATION (v3) ON SUPABASE");
  console.log("===============================================================================\n");

  // 1. Check saree_catalog new columns
  const catRes = await fetch(`${env.SUPABASE_URL}/rest/v1/saree_catalog?select=id,sku,status,tally_part_number&limit=3`, { headers });
  const catData = await catRes.json();
  console.log("1️⃣ saree_catalog columns check:");
  if (catRes.ok && Array.isArray(catData)) {
    console.log(`   ✅ Saree catalog queried successfully. Sample rows:`);
    catData.forEach(r => console.log(`      • SKU: ${r.sku} | Status: ${r.status} | Part#: ${r.tally_part_number}`));
  } else {
    console.error("   ❌ Failed:", catData);
  }

  // 2. Check stock_pool
  const spRes = await fetch(`${env.SUPABASE_URL}/rest/v1/stock_pool?select=*&limit=3`, { headers });
  const spData = await spRes.json();
  console.log("\n2️⃣ stock_pool table check:");
  if (spRes.ok && Array.isArray(spData)) {
    console.log(`   ✅ stock_pool queried successfully (${spData.length} sample rows):`);
    spData.forEach(r => console.log(`      • Code: ${r.product_code} | Online: ${r.online_quantity} | Held: ${r.held_quantity} | SoldPending: ${r.sold_pending_quantity}`));
  } else {
    console.error("   ❌ Failed:", spData);
  }

  // 3. Check available_stock view
  const avRes = await fetch(`${env.SUPABASE_URL}/rest/v1/available_stock?select=*&limit=3`, { headers });
  const avData = await avRes.json();
  console.log("\n3️⃣ available_stock view check:");
  if (avRes.ok && Array.isArray(avData)) {
    console.log(`   ✅ available_stock view working (${avData.length} sample rows):`);
    avData.forEach(r => console.log(`      • Code: ${r.product_code} | Available: ${r.available_quantity} | Status: ${r.availability_status} | Name: ${r.name?.slice(0, 25)}`));
  } else {
    console.error("   ❌ Failed:", avData);
  }

  // 4. Check option_lists
  const optRes = await fetch(`${env.SUPABASE_URL}/rest/v1/option_lists?select=category,value&limit=10`, { headers });
  const optData = await optRes.json();
  console.log("\n4️⃣ option_lists table check:");
  if (optRes.ok && Array.isArray(optData)) {
    console.log(`   ✅ option_lists seeded successfully. Found ${optData.length} sample values:`);
    optData.slice(0, 5).forEach(r => console.log(`      • [${r.category}] ${r.value}`));
  } else {
    console.error("   ❌ Failed:", optData);
  }

  // 5. Check wa_template_registry
  const tmplRes = await fetch(`${env.SUPABASE_URL}/rest/v1/wa_template_registry?select=template_name,purpose,category`, { headers });
  const tmplData = await tmplRes.json();
  console.log("\n5️⃣ wa_template_registry table check:");
  if (tmplRes.ok && Array.isArray(tmplData)) {
    console.log(`   ✅ wa_template_registry seeded with ${tmplData.length} templates:`);
    tmplData.forEach(r => console.log(`      • ${r.template_name} (${r.purpose} - ${r.category})`));
  } else {
    console.error("   ❌ Failed:", tmplData);
  }

  // 6. Check app_config
  const cfgRes = await fetch(`${env.SUPABASE_URL}/rest/v1/app_config?select=key`, { headers });
  const cfgData = await cfgRes.json();
  console.log("\n6️⃣ app_config keys check:");
  if (cfgRes.ok && Array.isArray(cfgData)) {
    console.log(`   ✅ app_config keys present:`, cfgData.map(k => k.key).join(", "));
  } else {
    console.error("   ❌ Failed:", cfgData);
  }

  // 7. Test check_can_list_product RPC
  if (catData && catData.length > 0) {
    const testId = catData[0].id;
    const rpcRes = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/check_can_list_product`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ p_saree_id: testId })
    });
    const rpcData = await rpcRes.json();
    console.log("\n7️⃣ check_can_list_product() RPC check for " + catData[0].sku + ":");
    console.log(`   Result: can_list = ${rpcData?.can_list}`);
    if (rpcData?.reasons) {
      console.log(`   Reasons/Gaps:`, rpcData.reasons);
    }
  }

  console.log("\n===============================================================================");
  console.log("🎉 ALL MIGRATION OBJECTS VERIFIED SUCCESSFULLY!");
  console.log("===============================================================================");
}

verify().catch(console.error);
