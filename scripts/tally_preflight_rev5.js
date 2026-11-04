/**
 * Phase 2 Pre-Flight Rev5: Name collision, GST collection export, TDL stock list
 * Run: node scripts/tally_preflight_rev5.js
 */
const http = require('http');
const fs = require('fs');

function send(xml) {
  return new Promise((resolve, reject) => {
    const req = http.request({hostname:'127.0.0.1',port:9000,path:'/',method:'POST',
      headers:{'Content-Type':'text/xml;charset=utf-8','Content-Length':Buffer.byteLength(xml)}},
      r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>resolve(d))});
    req.on('error',reject);req.setTimeout(15000,()=>{req.destroy();reject(new Error('Timeout'))});
    req.write(xml);req.end();
  });
}

async function main() {
  // ═══════════════════════════════════════════════════════════════
  // TEST 1: Name collision — same name, same unit, same parent
  // ═══════════════════════════════════════════════════════════════
  console.log('=== TEST 1a: Create scratch item ===');
  const r1a = await send(`<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<STOCKITEM NAME="Name Collision Test Saree" ACTION="Create">
  <NAME.LIST><NAME>Name Collision Test Saree</NAME><NAME>TEST-COLLISION-001</NAME></NAME.LIST>
  <PARENT>Sarees</PARENT><BASEUNITS>Nos</BASEUNITS>
</STOCKITEM>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`);
  console.log('Create 1:', r1a);
  
  console.log('\n=== TEST 1b: Create SAME name, same unit, same parent ===');
  const r1b = await send(`<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<STOCKITEM NAME="Name Collision Test Saree" ACTION="Create">
  <NAME.LIST><NAME>Name Collision Test Saree</NAME><NAME>TEST-COLLISION-002</NAME></NAME.LIST>
  <PARENT>Sarees</PARENT><BASEUNITS>Nos</BASEUNITS>
</STOCKITEM>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`);
  console.log('Create 2 (same name, same unit):', r1b);
  const altered = r1b.includes('<ALTERED>1</ALTERED>');
  const created = r1b.includes('<CREATED>1</CREATED>');
  const errors = r1b.includes('<ERRORS>');
  console.log('ALTERED:', altered, 'CREATED:', created);
  console.log('CONCLUSION: Same name+unit+parent =>', 
    altered ? 'ALTERED existing (alias overwritten!)' : 
    created ? 'CREATED new (unexpected!)' : 'ERROR/REJECTED');

  // Export to see what happened to the alias
  const r1c = await send(`<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><EXPORTDATA><REQUESTDESC>
<REPORTNAME>Stock Item</REPORTNAME>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<STOCKITEMNAME>Name Collision Test Saree</STOCKITEMNAME>
</STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`);
  console.log('\nExport after collision test:', r1c.slice(0, 500));

  // Check if TEST-COLLISION-001 alias still works
  const r1d = await send(`<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><EXPORTDATA><REQUESTDESC>
<REPORTNAME>Stock Item</REPORTNAME>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<STOCKITEMNAME>TEST-COLLISION-001</STOCKITEMNAME>
</STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`);
  console.log('\nAlias TEST-COLLISION-001 still resolves:', r1d.length > 200 && !r1d.includes('Unknown'));

  const r1e = await send(`<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><EXPORTDATA><REQUESTDESC>
<REPORTNAME>Stock Item</REPORTNAME>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<STOCKITEMNAME>TEST-COLLISION-002</STOCKITEMNAME>
</STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`);
  console.log('Alias TEST-COLLISION-002 resolves:', r1e.length > 200 && !r1e.includes('Unknown'));

  // ═══════════════════════════════════════════════════════════════
  // TEST 2: TDL Collection export — get real stock item data
  // ═══════════════════════════════════════════════════════════════
  console.log('\n\n=== TEST 2: TDL Collection exports ===');
  
  // Try COLLECTION export (returns TALLYMESSAGE with full data)
  const r2a = await send(`<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><EXPORTDATA><REQUESTDESC>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
<REPORTNAME>List of Accounts</REPORTNAME>
<STATICVARIABLES>
<ACCOUNTTYPE>Stock Items</ACCOUNTTYPE>
</STATICVARIABLES>
</REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`);
  fs.writeFileSync('c:/sai_traders/scripts/tally_collection_stockitems.xml', r2a);
  console.log('List of Accounts (Stock Items) length:', r2a.length);
  const hasNameList = r2a.includes('NAME.LIST');
  console.log('Has NAME.LIST:', hasNameList);
  console.log('First 2000:', r2a.slice(0, 2000));

  // Try STOCKITEM collection directly
  const r2b = await send(`<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><EXPORTDATA><REQUESTDESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>Mithun_Srinivas</SVCURRENTCOMPANY>
</STATICVARIABLES>
<REPORTNAME>List of Accounts</REPORTNAME>
<STATICVARIABLES>
<ACCOUNTTYPE>Stock Item</ACCOUNTTYPE>
</STATICVARIABLES>
</REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`);
  fs.writeFileSync('c:/sai_traders/scripts/tally_collection_stockitem2.xml', r2b);
  console.log('\nList of Accounts (Stock Item) length:', r2b.length);
  console.log('Has NAME.LIST:', r2b.includes('NAME.LIST'));
  console.log('First 2000:', r2b.slice(0, 2000));

  // ═══════════════════════════════════════════════════════════════
  // TEST 3: Export with OBJECTCRITERIA (individual item detail)
  // ═══════════════════════════════════════════════════════════════
  console.log('\n\n=== TEST 3: Individual stock item via collection ===');
  const r3 = await send(`<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><EXPORTDATA><REQUESTDESC>
<REPORTNAME>List of Accounts</REPORTNAME>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<ACCOUNTTYPE>Stock Item</ACCOUNTTYPE>
<SVFROMNAME>SR-1042-R</SVFROMNAME>
<SVTONAME>SR-1042-R</SVTONAME>
</STATICVARIABLES>
</REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`);
  console.log('Individual export length:', r3.length);
  console.log('Has NAME.LIST:', r3.includes('NAME.LIST'));
  console.log('Has MASTERID:', r3.includes('MASTERID'));
  console.log('Has GSTDETAILS:', r3.includes('GSTDETAILS'));
  console.log('First 3000:', r3.slice(0, 3000));

  // ═══════════════════════════════════════════════════════════════
  // TEST 4: Master-level collection export (TALLYMESSAGE style)
  // ═══════════════════════════════════════════════════════════════
  console.log('\n\n=== TEST 4: Master collection export ===');
  const r4 = await send(`<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><EXPORTDATA><REQUESTDESC>
<REPORTNAME>StockItemMasters</REPORTNAME>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
</STATICVARIABLES>
</REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`);
  console.log('StockItemMasters length:', r4.length);
  console.log('First 1000:', r4.slice(0, 1000));

  // ═══════════════════════════════════════════════════════════════
  // TEST 5: Stock Summary (already works — check for name + alias)
  // ═══════════════════════════════════════════════════════════════
  console.log('\n\n=== TEST 5: Stock Summary for names ===');
  const r5 = await send(`<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><EXPORTDATA><REQUESTDESC>
<REPORTNAME>Stock Summary</REPORTNAME>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
</REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`);
  fs.writeFileSync('c:/sai_traders/scripts/tally_stock_summary.xml', r5);
  console.log('Stock Summary length:', r5.length);
  // Extract all DSPDISPNAME
  const names = r5.match(/<DSPDISPNAME>([^<]+)<\/DSPDISPNAME>/gi) || [];
  console.log('Stock item names:', names.map(n => n.replace(/<\/?DSPDISPNAME>/gi, '')));

  // ═══════════════════════════════════════════════════════════════
  // TEST 6: List all items in a test company
  // ═══════════════════════════════════════════════════════════════
  console.log('\n\n=== TEST 6: List all test items to clean up ===');
  console.log('Items and vouchers created by pre-flight tests:');
  console.log('  Stock Items: Name Collision Test Saree (TEST-COLLISION-001/002)');
  console.log('  Stock Items: Test Emerald Silk Saree & Gold Border (TEST-SAI-0099)');
  console.log('  Stock Groups: Sarees');
  console.log('  Units: Nos');
  console.log('  Godowns: Online (sub of Main Location)');
  console.log('  Receipt Note: ONL-TEST-001');
  console.log('  Stock Journal: ONL-TEST-SJ-001');
}

main().catch(e => console.error('FATAL:', e.message));
