async function runSync() {
  console.log('Triggering /api/sync-morning-stock...');
  const res = await fetch('http://localhost:3000/api/sync-morning-stock', { method: 'POST' });
  const data = await res.json();
  console.log('Sync result:');
  console.log(JSON.stringify(data, null, 2));

  console.log('\nChecking products from /api/products:');
  const pRes = await fetch('http://localhost:3000/api/products');
  const pData = await pRes.json();
  (pData.products || []).forEach(p => {
    console.log(`[${p.sku || p.canonical_code}] "${p.name}" | Online: ${p.stock_quantity} | Avail: ${p.available_quantity}`);
  });
}

runSync().catch(console.error);
