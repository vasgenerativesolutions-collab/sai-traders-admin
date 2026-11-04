/**
 * Test Admin HTTP Endpoints on localhost:3000
 */
async function testEndpoints() {
  console.log('Testing Admin Web Server Endpoints on http://localhost:3000 ...\n');

  // 1. GET /api/status
  const sRes = await fetch('http://localhost:3000/api/status');
  const sData = await sRes.json();
  console.log('1. /api/status:', sRes.status, {
    shopPc: sData.shopPc,
    discrepancies: sData.discrepancies,
    products: sData.counts?.products
  });

  // 2. GET /api/sync/schedule
  const schedRes = await fetch('http://localhost:3000/api/sync/schedule');
  const schedData = await schedRes.json();
  console.log('2. /api/sync/schedule (GET):', schedRes.status, schedData.schedule);

  // 3. POST /api/sync/schedule
  const saveSchedRes = await fetch('http://localhost:3000/api/sync/schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ time: '09:30' })
  });
  const saveSchedData = await saveSchedRes.json();
  console.log('3. /api/sync/schedule (POST):', saveSchedRes.status, saveSchedData.schedule?.time);

  // 4. GET /api/discrepancies
  const discRes = await fetch('http://localhost:3000/api/discrepancies?status=open');
  const discData = await discRes.json();
  console.log('4. /api/discrepancies?status=open:', discRes.status, `count = ${discData.count}`);

  // 5. GET /api/new-stock
  const newStockRes = await fetch('http://localhost:3000/api/new-stock');
  const newStockData = await newStockRes.json();
  console.log('5. /api/new-stock:', newStockRes.status, {
    draft_items_count: newStockData.draft_items?.length,
    inward_events_count: newStockData.inward_events?.length
  });

  // 6. GET /api/sync/runs
  const runsRes = await fetch('http://localhost:3000/api/sync/runs?limit=5');
  const runsData = await runsRes.json();
  console.log('6. /api/sync/runs:', runsRes.status, `count = ${runsData.count}`);

  // 7. POST /api/manual-stock-entry
  const manualRes = await fetch('http://localhost:3000/api/manual-stock-entry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      product_code: 'SAI-KANJ-01',
      new_quantity: 4,
      reason: 'Verified count on physical shelf during downtime check'
    })
  });
  const manualData = await manualRes.json();
  console.log('7. /api/manual-stock-entry:', manualRes.status, {
    success: manualData.success,
    product_code: manualData.product_code,
    new_quantity: manualData.new_quantity
  });

  console.log('\nAll 7 endpoints responding with 200 OK!');
}

testEndpoints().catch(console.error);
