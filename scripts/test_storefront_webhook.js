const crypto = require('crypto');
const http = require('http');

const SECRET = 'sec_stg_a45981cbd31fefdc05931ff704c9f4b47fc9c4c1b779c8ee73ee22b4ecb14776';
const PORT = 3000;

function computeSignature(payloadStr) {
  return 'sha256=' + crypto.createHmac('sha256', SECRET).update(Buffer.from(payloadStr, 'utf8')).digest('hex');
}

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function runTests() {
  console.log('🧪 [Test Suite] Starting Storefront Webhook & Gateway Tests...\n');

  // Test 1: Health check
  console.log('1️⃣ Testing GET /api/v1/health ...');
  const healthRes = await request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/api/v1/health',
    method: 'GET'
  });
  console.log(`   Status: ${healthRes.status}`);
  console.log(`   R2 CDN Base URL: ${healthRes.body?.r2_media_cdn?.public_base_url}`);
  if (healthRes.status !== 200) throw new Error('Health check failed');
  console.log('   ✅ Health check PASSED\n');

  // Test 2: Ingestion with Invalid Signature
  console.log('2️⃣ Testing POST /api/v1/orders/storefront-sync with INVALID signature ...');
  const payload1 = JSON.stringify({
    orderNumber: 'ORD-TEST-001',
    amount: 3500,
    customer: { name: 'Test Customer', phone: '9876543210' }
  });
  const invalidRes = await request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/api/v1/orders/storefront-sync',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Storefront-Signature': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      'X-Idempotency-Key': 'ORD-TEST-001'
    }
  }, payload1);
  console.log(`   Status: ${invalidRes.status} (Expected 403)`);
  if (invalidRes.status !== 403) throw new Error('Expected 403 for bad signature');
  console.log('   ✅ Invalid signature rejected with 403 Forbidden\n');

  // Test 3: Ingestion with VALID Signature
  console.log('3️⃣ Testing POST /api/v1/orders/storefront-sync with VALID HMAC signature ...');
  const validSig = computeSignature(payload1);
  const validRes = await request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/api/v1/orders/storefront-sync',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Storefront-Signature': validSig,
      'X-Idempotency-Key': 'ORD-TEST-001'
    }
  }, payload1);
  console.log(`   Status: ${validRes.status}`);
  console.log(`   Order Ref: ${validRes.body?.orderReference}`);
  console.log(`   Tally Job ID: ${validRes.body?.tallyJobId}`);
  if (validRes.status !== 200 || !validRes.body?.orderReference) throw new Error('Order ingestion failed');
  console.log('   ✅ Valid HMAC order ingestion PASSED\n');

  // Test 4: Idempotent Replay (Same Key, Same Payload)
  console.log('4️⃣ Testing Idempotent Replay (Same Key & Payload) ...');
  const replayRes = await request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/api/v1/orders/storefront-sync',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Storefront-Signature': validSig,
      'X-Idempotency-Key': 'ORD-TEST-001'
    }
  }, payload1);
  console.log(`   Status: ${replayRes.status}`);
  console.log(`   Idempotent Replay Flag: ${replayRes.body?.idempotentReplay}`);
  if (replayRes.status !== 200 || replayRes.body?.idempotentReplay !== true) throw new Error('Idempotent replay failed');
  console.log('   ✅ Idempotent replay returned cached response with 200 OK\n');

  // Test 5: Conflict Replay (Same Key, Modified Payload)
  console.log('5️⃣ Testing Payload Conflict (Same Key, Disparate Payload) ...');
  const conflictPayload = JSON.stringify({
    orderNumber: 'ORD-TEST-001',
    amount: 99999, // tampered amount
    customer: { name: 'Attacker', phone: '0000000000' }
  });
  const conflictSig = computeSignature(conflictPayload);
  const conflictRes = await request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/api/v1/orders/storefront-sync',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Storefront-Signature': conflictSig,
      'X-Idempotency-Key': 'ORD-TEST-001'
    }
  }, conflictPayload);
  console.log(`   Status: ${conflictRes.status} (Expected 409)`);
  console.log(`   Error Code: ${conflictRes.body?.code}`);
  if (conflictRes.status !== 409 || conflictRes.body?.code !== 'IDEMPOTENCY_PAYLOAD_MISMATCH') {
    throw new Error('Conflict test failed');
  }
  console.log('   ✅ Conflict detected and rejected with 409 Conflict\n');

  // Test 6: Touchpoint 2 - Acquire Hold (10-minute lease)
  console.log('6️⃣ Testing Touchpoint 2: POST /api/v1/inventory/holds/acquire ...');
  const holdPayload = JSON.stringify({
    holdId: 'hld_test_9988',
    sku: 'SAI-TEST-SKU-01',
    quantity: 1,
    channel: 'WEB_STOREFRONT',
    ttlSeconds: 600,
    idempotencyKey: 'hld_test_9988'
  });
  const holdRes = await request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/api/v1/inventory/holds/acquire',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, holdPayload);
  console.log(`   Status: ${holdRes.status}`);
  console.log(`   Hold ID: ${holdRes.body?.holdId}, Status: ${holdRes.body?.status}, ExpiresAt: ${holdRes.body?.expiresAt}`);
  if (holdRes.status !== 200 || holdRes.body?.status !== 'ACTIVE') throw new Error('Hold acquisition failed');
  console.log('   ✅ Hold acquired successfully (ACTIVE, 10m TTL)\n');

  // Test 7: Touchpoint 2 - Query Hold Status
  console.log('7️⃣ Testing Touchpoint 2: GET /api/v1/inventory/holds/:holdId ...');
  const queryRes = await request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/api/v1/inventory/holds/hld_test_9988',
    method: 'GET'
  });
  console.log(`   Status: ${queryRes.status}`);
  console.log(`   Remaining TTL: ${queryRes.body?.timeRemainingSeconds}s`);
  if (queryRes.status !== 200 || queryRes.body?.status !== 'ACTIVE') throw new Error('Query hold failed');
  console.log('   ✅ Hold status query PASSED\n');

  // Test 8: Touchpoint 2 - Release Hold
  console.log('8️⃣ Testing Touchpoint 2: POST /api/v1/inventory/holds/release ...');
  const releasePayload = JSON.stringify({
    holdId: 'hld_test_9988',
    sku: 'SAI-TEST-SKU-01',
    reason: 'USER_ABANDONED_CHECKOUT'
  });
  const releaseRes = await request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/api/v1/inventory/holds/release',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, releasePayload);
  console.log(`   Status: ${releaseRes.status}`);
  console.log(`   Hold ID: ${releaseRes.body?.holdId}, Status: ${releaseRes.body?.status}`);
  if (releaseRes.status !== 200 || releaseRes.body?.status !== 'RELEASED') throw new Error('Hold release failed');
  console.log('   ✅ Hold released successfully (RELEASED)\n');

  console.log('🎉 ALL 8 INTEGRATION TESTS (WEBHOOK + DUAL-MASTER SEAT HOLD ENGINE) PASSED 100%!');
}


runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
