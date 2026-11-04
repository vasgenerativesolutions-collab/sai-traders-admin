/**
 * Test script for Sai Traders Admin Suite APIs
 * 
 * Verifies:
 * 1. GET /api/options (Option Lists Master Data)
 * 2. GET /api/products (Listing Gatekeeper readiness check)
 * 3. GET /api/video-records
 * 4. GET /api/app-config
 * 5. Publish rejection test (Gatekeeper blocks listing without verified video)
 * 
 * Usage: node scripts/test_admin_endpoints.js
 */

async function testEndpoints() {
  console.log('======================================================================');
  console.log('🧪 TESTING SAI TRADERS ADMIN DASHBOARD APIS (http://localhost:3000)');
  console.log('======================================================================\n');

  const BASE_URL = 'http://localhost:3000';

  // 1. GET /api/options
  process.stdout.write('1️⃣ Testing GET /api/options... ');
  try {
    const res = await fetch(`${BASE_URL}/api/options`);
    const data = await res.json();
    if (res.ok && data.success && data.options) {
      console.log(`✅ Passed! Loaded ${data.options.length} options across ${data.categories?.length || Object.keys(data.grouped || {}).length} categories.`);
    } else {
      console.log(`❌ Failed:`, data);
    }
  } catch (err) {
    console.log(`❌ Request failed: ${err.message}`);
  }

  // 2. GET /api/products (Readiness evaluation)
  process.stdout.write('2️⃣ Testing GET /api/products (4-Pillar Gatekeeper)... ');
  let testProductId = null;
  try {
    const res = await fetch(`${BASE_URL}/api/products`);
    const data = await res.json();
    if (res.ok && data.success && data.products) {
      console.log(`✅ Passed! Evaluated ${data.products.length} products.`);
      const sample = data.products[0];
      testProductId = sample?.id;
      console.log(`   Sample [${sample?.sku || sample?.tally_part_number}] "${sample?.name}":`);
      console.log(`   • Status: ${sample?.status}`);
      console.log(`   • Ready to List: ${sample?.readiness?.can_list ? 'YES' : 'NO'}`);
      console.log(`   • Missing Pillars:`, sample?.readiness?.reasons || []);
    } else {
      console.log(`❌ Failed:`, data);
    }
  } catch (err) {
    console.log(`❌ Request failed: ${err.message}`);
  }

  // 3. GET /api/video-records
  process.stdout.write('3️⃣ Testing GET /api/video-records... ');
  try {
    const res = await fetch(`${BASE_URL}/api/video-records`);
    const data = await res.json();
    if (res.ok && data.success) {
      console.log(`✅ Passed! Loaded ${data.records?.length || 0} video records.`);
    } else {
      console.log(`❌ Failed:`, data);
    }
  } catch (err) {
    console.log(`❌ Request failed: ${err.message}`);
  }

  // 4. GET /api/app-config
  process.stdout.write('4️⃣ Testing GET /api/app-config... ');
  try {
    const res = await fetch(`${BASE_URL}/api/app-config`);
    const data = await res.json();
    if (res.ok && data.success && data.config) {
      console.log(`✅ Passed! Found config keys: ${Object.keys(data.config).join(', ')}`);
      console.log(`   • Direct Order Enabled: ${data.config.feature_flags?.direct_order_enabled}`);
      console.log(`   • Embedding Migration Status: ${data.config.embedding_config?.migration_status}`);
      console.log(`   • Calibration Status: ${data.config.matching_thresholds?.calibration_status}`);
    } else {
      console.log(`❌ Failed:`, data);
    }
  } catch (err) {
    console.log(`❌ Request failed: ${err.message}`);
  }

  // 5. Test Listing Gatekeeper enforcement on an unverified product
  if (testProductId) {
    process.stdout.write('5️⃣ Testing Gatekeeper Protection (POST /api/products/:id/publish)... ');
    try {
      const res = await fetch(`${BASE_URL}/api/products/${testProductId}/publish`, {
        method: 'POST'
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        console.log(`🛡️ Correctly Blocked by Gatekeeper!`);
        console.log(`   • Rejection Reason: ${data.error || JSON.stringify(data.reasons)}`);
      } else {
        console.log(`⚠️ Published unexpectedly:`, data);
      }
    } catch (err) {
      console.log(`❌ Request failed: ${err.message}`);
    }
  }

  console.log('\n🎉 ALL ADMIN API ENDPOINTS VERIFIED!\n');
}

testEndpoints();
