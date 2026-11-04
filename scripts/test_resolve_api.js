async function testResolveViaApi() {
  const r = await fetch('http://localhost:3000/api/discrepancies?status=open');
  const d = await r.json();
  console.log('Open discrepancies before resolve:', d.discrepancies?.map(x => ({ id: x.id, code: x.product_code })));

  if (d.discrepancies?.length > 0) {
    const target = d.discrepancies[0];
    const resolveRes = await fetch(`http://localhost:3000/api/discrepancies/${target.id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'accept_tally',
        notes: 'API resolve test via HTTP',
        resolved_by: 'admin:test'
      })
    });
    console.log('Resolve result status:', resolveRes.status, await resolveRes.json());
  }

  const rAfter = await fetch('http://localhost:3000/api/discrepancies?status=open');
  const dAfter = await rAfter.json();
  console.log('Open discrepancies after resolve:', dAfter.count);
}
testResolveViaApi().catch(console.error);
