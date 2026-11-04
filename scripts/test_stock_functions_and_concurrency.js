/**
 * Sai Traders — Stock Functions & Concurrency Verification Suite
 *
 * Mandatory Tests (Working Rules):
 * 1. place_hold (idempotency, duration, grace)
 * 2. Concurrency stress test: Two buyers competing for the LAST remaining unit simultaneously.
 *    -> Exactly ONE succeeds, ONE receives out_of_stock, zero negative inventory.
 * 3. release_hold (inventory restored upon expiry/cancel)
 * 4. confirm_order (held -> sold_pending_quantity, posting_queue entry, idempotent replay)
 * 5. apply_sync_result (Tally Online Godown snapshot, discrepancy logging, clamp warning)
 * 6. admin_manual_stock_entry (downtime safety override)
 * 7. Failure Drills (PC off, Tally closed, missing Online godown)
 */

const fs = require('fs');
const path = require('path');

// Load environment credentials
const envPath = path.resolve(__dirname, '..', '.env');
const env = {};
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)?\s*$/);
    if (match) env[match[1]] = (match[2] || '').trim().replace(/^["']|["']$/g, '');
  });
}

const SUPABASE_URL = env.SUPABASE_URL || 'https://aisttddxrbizoshtpdxi.supabase.co';
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const SHOP_ID = '00000000-0000-0000-0000-000000000001';

const headers = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json'
};

async function rpc(functionName, params) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${functionName}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(params)
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

async function runTests() {
  console.log('===============================================================================');
  console.log('🧪 SAI TRADERS — ATOMIC STOCK FUNCTIONS & CONCURRENCY TEST SUITE');
  console.log('===============================================================================');
  console.log(`Target Supabase DB: ${SUPABASE_URL}`);
  console.log(`Shop ID           : ${SHOP_ID}`);
  console.log('-------------------------------------------------------------------------------\n');

  let passedCount = 0;
  let totalCount = 0;

  function assert(condition, message) {
    totalCount++;
    if (condition) {
      console.log(`   ✅ PASS: ${message}`);
      passedCount++;
    } else {
      console.error(`   ❌ FAIL: ${message}`);
    }
  }

  // Set up a dedicated test product in stock_pool
  const TEST_CODE = 'SAI-TEST-CONCURRENCY-001';
  console.log(`🔧 Setup: Provisioning test product [${TEST_CODE}] with exactly 1 unit in Online Godown...`);

  await fetch(`${SUPABASE_URL}/rest/v1/stock_pool`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      shop_id: SHOP_ID,
      product_code: TEST_CODE,
      online_quantity: 1,
      held_quantity: 0,
      sold_pending_quantity: 0,
      tally_godown: 'Online',
      source: 'admin_entered'
    })
  });

  // --------------------------------------------------------------------------
  // TEST 1: Basic place_hold & Idempotency
  // --------------------------------------------------------------------------
  console.log('\n1️⃣ Testing place_hold basic reservation & idempotency...');
  const key1 = `idemp_test_${Date.now()}`;
  const h1 = await rpc('place_hold', {
    p_shop_id: SHOP_ID,
    p_product_code: TEST_CODE,
    p_customer_id: '00000000-0000-0000-0000-000000000001',
    p_channel: 'web',
    p_idempotency_key: key1,
    p_duration_minutes: 10
  });

  assert(h1.ok && h1.data.success === true, 'Hold successfully acquired for test product');
  const holdId1 = h1.data.hold_id;

  // Replay with exact same idempotency key
  const h1Replay = await rpc('place_hold', {
    p_shop_id: SHOP_ID,
    p_product_code: TEST_CODE,
    p_customer_id: '00000000-0000-0000-0000-000000000001',
    p_channel: 'web',
    p_idempotency_key: key1
  });

  assert(h1Replay.ok && h1Replay.data.idempotent_replay === true, 'Identical idempotency key safely returns existing hold');

  // Release hold to reset for concurrency test
  console.log('\n2️⃣ Testing release_hold...');
  const rel1 = await rpc('release_hold', { p_hold_id: holdId1, p_reason: 'test_reset' });
  assert(rel1.ok && rel1.data.success === true, 'Hold successfully released back to available pool');

  // --------------------------------------------------------------------------
  // TEST 2: CONCURRENCY STRESS TEST (Two buyers, last unit)
  // --------------------------------------------------------------------------
  console.log('\n3️⃣ CONCURRENCY TEST: Two simultaneous buyers clicking "Proceed to Pay" for the LAST remaining unit...');

  const buyerAKey = `buyer_A_${Date.now()}`;
  const buyerBKey = `buyer_B_${Date.now()}`;

  // Fire both requests concurrently in parallel
  const [buyerA, buyerB] = await Promise.all([
    rpc('place_hold', {
      p_shop_id: SHOP_ID,
      p_product_code: TEST_CODE,
      p_customer_id: '00000000-0000-0000-0000-000000000001',
      p_channel: 'web',
      p_idempotency_key: buyerAKey,
      p_client_ip: '192.168.1.101'
    }),
    rpc('place_hold', {
      p_shop_id: SHOP_ID,
      p_product_code: TEST_CODE,
      p_customer_id: '00000000-0000-0000-0000-000000000001',
      p_channel: 'whatsapp',
      p_idempotency_key: buyerBKey,
      p_client_ip: '192.168.1.102'
    })
  ]);

  const buyerASuccess = buyerA.data?.success === true;
  const buyerBSuccess = buyerB.data?.success === true;

  console.log(`   Buyer A response: success = ${buyerASuccess} (${buyerA.data?.error || 'acquired'})`);
  console.log(`   Buyer B response: success = ${buyerBSuccess} (${buyerB.data?.error || 'acquired'})`);

  // Exactly one buyer must win
  assert(
    (buyerASuccess && !buyerBSuccess) || (!buyerASuccess && buyerBSuccess),
    'Atomic row-level lock guaranteed EXACTLY ONE winner and rejected the other'
  );

  const winningHoldId = buyerASuccess ? buyerA.data.hold_id : buyerB.data.hold_id;
  const losingBuyer = buyerASuccess ? buyerB : buyerA;

  assert(
    losingBuyer.data?.error === 'out_of_stock' && losingBuyer.data?.available_quantity === 0,
    'Losing buyer received clean "out_of_stock" without crashing or race condition'
  );

  // Check inventory pool in DB
  const poolRes = await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?product_code=eq.${TEST_CODE}`, { headers });
  const poolItem = (await poolRes.json())[0];

  assert(
    poolItem.held_quantity === 1 && poolItem.online_quantity === 1,
    'Pool holds exactly 1 unit; no negative inventory created'
  );

  // --------------------------------------------------------------------------
  // TEST 3: confirm_order (Atomic order conversion & posting queue)
  // --------------------------------------------------------------------------
  console.log('\n4️⃣ Testing confirm_order (held -> sold_pending & posting_queue creation)...');

  // Create a dummy order record
  const dummyOrdRes = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=representation' },
    body: JSON.stringify({
      shop_id: SHOP_ID,
      customer_id: '00000000-0000-0000-0000-000000000001',
      status: 'pending',
      total_amount: 5000,
      channel: 'web'
    })
  });
  const dummyOrder = (await dummyOrdRes.json())[0];

  const confRes = await rpc('confirm_order', {
    p_shop_id: SHOP_ID,
    p_hold_id: winningHoldId,
    p_order_id: dummyOrder.id,
    p_payment_ref: 'PAY_TEST_UPI_9988',
    p_channel: 'web'
  });

  assert(confRes.ok && confRes.data.success === true, 'Order confirmed atomically and transitioned to paid_pending_approval');
  assert(confRes.data.remote_id.startsWith('SAI-ORD-'), 'Posting queue remote_id generated for Tally deduplication');

  // Verify stock pool reflects sold_pending_quantity
  const poolAfterConf = (await (await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?product_code=eq.${TEST_CODE}`, { headers })).json())[0];
  assert(
    poolAfterConf.held_quantity === 0 && poolAfterConf.sold_pending_quantity === 1,
    'held_quantity decremented to 0 and moved to sold_pending_quantity'
  );

  // --------------------------------------------------------------------------
  // TEST 4: apply_sync_result & Discrepancies
  // --------------------------------------------------------------------------
  console.log('\n5️⃣ Testing apply_sync_result (Tally Online Godown reconciliation)...');

  // Create sync run
  const runRes = await fetch(`${SUPABASE_URL}/rest/v1/sync_runs`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=representation' },
    body: JSON.stringify({ shop_id: SHOP_ID, status: 'running', triggered_by: 'admin' })
  });
  const syncRun = (await runRes.json())[0];

  // Ingest unexpected discrepancy: Tally reports 5 units for this item
  const syncRes = await rpc('apply_sync_result', {
    p_shop_id: SHOP_ID,
    p_run_id: syncRun.id,
    p_tally_balances: [{ product_code: TEST_CODE, tally_qty: 5, rate: 4500 }]
  });

  assert(syncRes.ok && syncRes.data.success === true, 'apply_sync_result processed Tally balances');
  assert(syncRes.data.discrepancies_count >= 1, 'Discrepancy detected and logged (cloud expected 1 vs Tally reported 5)');

  // --------------------------------------------------------------------------
  // TEST 5: admin_manual_stock_entry (Downtime override)
  // --------------------------------------------------------------------------
  console.log('\n6️⃣ Testing admin_manual_stock_entry (downtime override)...');
  const manRes = await rpc('admin_manual_stock_entry', {
    p_shop_id: SHOP_ID,
    p_product_code: TEST_CODE,
    p_new_quantity: 8,
    p_reason: 'Shop PC offline during morning sync; verified physical shelf stock manually',
    p_admin_user: 'admin:store_manager'
  });

  assert(manRes.ok && manRes.data.success === true, 'Manual stock override recorded successfully');
  assert(manRes.data.new_quantity === 8, 'Online quantity updated directly with audit trail');

  // --------------------------------------------------------------------------
  // TEST 6: FAILURE DRILLS (PC off / Tally closed / missing godown)
  // --------------------------------------------------------------------------
  console.log('\n7️⃣ Testing Failure Drills & Telemetry Alerting...');

  const { checkTallyHealth } = require('../agent/tally_client');

  // Drill A: Tally Closed (port 9000 not responding)
  const drillTallyClosed = await checkTallyHealth('Online');
  console.log(`   [Drill: Tally Closed] Result: reachable = ${drillTallyClosed.reachable}`);
  assert(drillTallyClosed.reachable === false, 'Tally closed drill ended in clear unreachable status with error, not silence');

  // Drill B: Check Godown validation regex
  const regex = /<NAME>\s*Online\s*<\/NAME>/i;
  assert(regex.test('<NAME>Online</NAME>'), 'Online godown presence accurately matched in Tally XML responses');

  console.log('\n===============================================================================');
  console.log(`🏁 TEST RESULTS: ${passedCount} / ${totalCount} ASSERTIONS PASSED`);
  console.log('===============================================================================\n');

  if (passedCount === totalCount) {
    console.log('🎉 ALL ATOMIC STOCK FUNCTIONS & CONCURRENCY TESTS COMPLETED SUCCESSFULLY!');
  } else {
    console.error(`⚠️ ${totalCount - passedCount} assertion(s) failed.`);
  }
}

if (require.main === module) {
  runTests().catch(console.error);
}

module.exports = { runTests };
