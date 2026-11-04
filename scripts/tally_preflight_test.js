/**
 * Phase 2 Pre-Flight: TallyPrime XML Test Suite
 * 
 * Tests all XML structures on the test company BEFORE migration.
 * Does NOT apply any migration. Only creates test items that can be deleted.
 * 
 * Run: node scripts/tally_preflight_test.js
 */
const http = require('http');

const TALLY_HOST = '127.0.0.1';
const TALLY_PORT = 9000;

function sendToTally(xml) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: TALLY_HOST,
      port: TALLY_PORT,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml;charset=utf-8',
        'Content-Length': Buffer.byteLength(xml)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(xml);
    req.end();
  });
}

const results = {};

async function test(name, fn) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`TEST: ${name}`);
  console.log('='.repeat(70));
  try {
    const result = await fn();
    results[name] = { status: 'PASS', ...result };
    console.log(`✅ PASS`);
  } catch (e) {
    results[name] = { status: 'FAIL', error: e.message };
    console.log(`❌ FAIL: ${e.message}`);
  }
}

async function testConnectivity() {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><EXPORTDATA><REQUESTDESC>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
<REPORTNAME>List of Companies</REPORTNAME>
</REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;
  const res = await sendToTally(xml);
  console.log('Response (first 2000):\n', res.body.slice(0, 2000));
  return { responseLength: res.body.length };
}

async function testExportStockItem() {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><EXPORTDATA><REQUESTDESC>
<REPORTNAME>Stock Item</REPORTNAME>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<STOCKITEMNAME>SR-1042-R</STOCKITEMNAME>
</STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;
  const res = await sendToTally(xml);
  console.log('EXPORTED STOCK ITEM XML (SR-1042-R):');
  console.log(res.body);
  const masterIdMatch = res.body.match(/<MASTERID>([^<]+)<\/MASTERID>/i);
  const guidMatch = res.body.match(/<GUID>([^<]+)<\/GUID>/i);
  console.log('MASTERID:', masterIdMatch ? masterIdMatch[1] : 'NOT FOUND');
  console.log('GUID:', guidMatch ? guidMatch[1] : 'NOT FOUND');
  return { hasMasterId: !!masterIdMatch, hasGuid: !!guidMatch, fullResponse: res.body };
}

async function testCreateStockItemWithGST() {
  // Ensure Nos unit
  await sendToTally(`<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<UNIT NAME="Nos" ACTION="Create"><NAME>Nos</NAME><ISSIMPLEUNIT>Yes</ISSIMPLEUNIT><DECIMALPLACES>0</DECIMALPLACES></UNIT>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`);
  
  // Ensure Sarees group
  const groupRes = await sendToTally(`<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<STOCKGROUP NAME="Sarees" ACTION="Create"><NAME>Sarees</NAME><PARENT>Primary</PARENT></STOCKGROUP>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`);
  console.log('Sarees group:', groupRes.body.slice(0, 300));

  // Create test item with GSTDETAILS.LIST
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<STOCKITEM NAME="Test Emerald Silk Saree &amp; Gold Border" ACTION="Create">
  <NAME.LIST>
    <NAME>Test Emerald Silk Saree &amp; Gold Border</NAME>
    <NAME>TEST-SAI-0099</NAME>
  </NAME.LIST>
  <PARENT>Sarees</PARENT>
  <BASEUNITS>Nos</BASEUNITS>
  <GSTAPPLICABLE>&#4;Applicable</GSTAPPLICABLE>
  <GSTTYPEOFSUPPLY>Goods</GSTTYPEOFSUPPLY>
  <GSTDETAILS.LIST>
    <APPLICABLEFROM>20260401</APPLICABLEFROM>
    <HSNCODE>5007</HSNCODE>
    <TAXABILITY>Taxable</TAXABILITY>
    <GSTTYPEOFSUPPLY>Goods</GSTTYPEOFSUPPLY>
    <STATEWISEDETAILS.LIST>
      <STATENAME>Tamil Nadu</STATENAME>
      <RATEDETAILS.LIST>
        <GSTRATE>5</GSTRATE>
        <SGSTRATE>2.5</SGSTRATE>
        <CGSTRATE>2.5</CGSTRATE>
        <IGSTRATE>5</IGSTRATE>
      </RATEDETAILS.LIST>
    </STATEWISEDETAILS.LIST>
  </GSTDETAILS.LIST>
</STOCKITEM>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  const res = await sendToTally(xml);
  console.log('CREATE response:', res.body);
  
  const created = res.body.includes('<CREATED>1</CREATED>');
  const altered = res.body.includes('<ALTERED>1</ALTERED>');
  
  if (!created && !altered) {
    console.log('Retrying without &#4;...');
    const xml2 = xml.replace('&#4;Applicable', 'Applicable');
    const res2 = await sendToTally(xml2);
    console.log('Retry:', res2.body);
  }
  
  // Export what Tally stored
  const exportRes = await sendToTally(`<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><EXPORTDATA><REQUESTDESC>
<REPORTNAME>Stock Item</REPORTNAME>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<STOCKITEMNAME>Test Emerald Silk Saree &amp; Gold Border</STOCKITEMNAME>
</STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`);
  console.log('EXPORTED TEST ITEM:');
  console.log(exportRes.body);
  return { created: created || altered, exportedXml: exportRes.body };
}

async function testCreateOnlineGodown() {
  const res = await sendToTally(`<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<GODOWN NAME="Online" ACTION="Create"><NAME>Online</NAME><PARENT>Main Location</PARENT></GODOWN>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`);
  console.log('Online godown:', res.body);
  return { created: res.body.includes('<CREATED>') || res.body.includes('<ALTERED>') };
}

async function testReceiptNote() {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER VCHTYPE="Receipt Note" ACTION="Create">
  <DATE>20261006</DATE><EFFECTIVEDATE>20261006</EFFECTIVEDATE>
  <VOUCHERTYPENAME>Receipt Note</VOUCHERTYPENAME>
  <VOUCHERNUMBER>ONL-TEST-001</VOUCHERNUMBER>
  <REFERENCE>ONL-TEST-001</REFERENCE>
  <NARRATION>Pre-flight: TEST-SAI-0099 2 Nos to Online</NARRATION>
  <ALLINVENTORYENTRIES.LIST>
    <STOCKITEMNAME>Test Emerald Silk Saree &amp; Gold Border</STOCKITEMNAME>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <RATE>3500.00/Nos</RATE>
    <AMOUNT>-7000.00</AMOUNT>
    <ACTUALQTY>2 Nos</ACTUALQTY>
    <BILLEDQTY>2 Nos</BILLEDQTY>
    <BATCHALLOCATIONS.LIST>
      <GODOWNNAME>Online</GODOWNNAME>
      <BATCHNAME>Primary Batch</BATCHNAME>
      <AMOUNT>-7000.00</AMOUNT>
      <ACTUALQTY>2 Nos</ACTUALQTY>
      <BILLEDQTY>2 Nos</BILLEDQTY>
    </BATCHALLOCATIONS.LIST>
  </ALLINVENTORYENTRIES.LIST>
</VOUCHER>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  const res = await sendToTally(xml);
  console.log('RECEIPT NOTE:', res.body);
  const created = res.body.includes('<CREATED>1</CREATED>');
  if (!created) {
    console.log('Trying WITH party ledger...');
    const xml2 = xml.replace('<NARRATION>', '<PARTYLEDGERNAME>Cash</PARTYLEDGERNAME>\n  <NARRATION>');
    const res2 = await sendToTally(xml2);
    console.log('WITH PARTY:', res2.body);
    return { created: res2.body.includes('<CREATED>1</CREATED>'), needsPartyLedger: true };
  }
  return { created, needsPartyLedger: false };
}

async function testStockJournal() {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER VCHTYPE="Stock Journal" ACTION="Create">
  <DATE>20261006</DATE><EFFECTIVEDATE>20261006</EFFECTIVEDATE>
  <VOUCHERTYPENAME>Stock Journal</VOUCHERTYPENAME>
  <VOUCHERNUMBER>ONL-TEST-SJ-001</VOUCHERNUMBER>
  <REFERENCE>ONL-TEST-SJ-001</REFERENCE>
  <NARRATION>Pre-flight: SR-1042-R 1 Pcs Main→Online</NARRATION>
  <INVENTORYENTRIESOUT.LIST>
    <STOCKITEMNAME>SR-1042-R</STOCKITEMNAME>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <RATE>4650.00/Pcs</RATE>
    <AMOUNT>4650.00</AMOUNT>
    <ACTUALQTY>1 Pcs</ACTUALQTY>
    <BILLEDQTY>1 Pcs</BILLEDQTY>
    <BATCHALLOCATIONS.LIST>
      <GODOWNNAME>Main Location</GODOWNNAME>
      <BATCHNAME>Primary Batch</BATCHNAME>
      <AMOUNT>4650.00</AMOUNT>
      <ACTUALQTY>1 Pcs</ACTUALQTY>
      <BILLEDQTY>1 Pcs</BILLEDQTY>
    </BATCHALLOCATIONS.LIST>
  </INVENTORYENTRIESOUT.LIST>
  <INVENTORYENTRIESIN.LIST>
    <STOCKITEMNAME>SR-1042-R</STOCKITEMNAME>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <RATE>4650.00/Pcs</RATE>
    <AMOUNT>-4650.00</AMOUNT>
    <ACTUALQTY>1 Pcs</ACTUALQTY>
    <BILLEDQTY>1 Pcs</BILLEDQTY>
    <BATCHALLOCATIONS.LIST>
      <GODOWNNAME>Online</GODOWNNAME>
      <BATCHNAME>Primary Batch</BATCHNAME>
      <AMOUNT>-4650.00</AMOUNT>
      <ACTUALQTY>1 Pcs</ACTUALQTY>
      <BILLEDQTY>1 Pcs</BILLEDQTY>
    </BATCHALLOCATIONS.LIST>
  </INVENTORYENTRIESIN.LIST>
</VOUCHER>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  const res = await sendToTally(xml);
  console.log('STOCK JOURNAL:', res.body);
  return { created: res.body.includes('<CREATED>1</CREATED>') };
}

async function testAliasLookup() {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><EXPORTDATA><REQUESTDESC>
<REPORTNAME>List of Accounts</REPORTNAME>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<ACCOUNTTYPE>Stock Item</ACCOUNTTYPE>
</STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;
  const res = await sendToTally(xml);
  console.log('ALIAS LOOKUP (first 3000):');
  console.log(res.body.slice(0, 3000));
  const nameListBlocks = res.body.match(/<NAME\.LIST[^>]*>[\s\S]*?<\/NAME\.LIST>/gi) || [];
  console.log('NAME.LIST blocks:', nameListBlocks.length);
  nameListBlocks.forEach((b, i) => console.log(`  ${i+1}: ${b}`));
  return { nameListBlocks: nameListBlocks.length };
}

async function testDuplicateName() {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<STOCKITEM NAME="SR-1042-R" ACTION="Create">
  <NAME.LIST><NAME>SR-1042-R</NAME><NAME>DUP-TEST-ALIAS</NAME></NAME.LIST>
  <PARENT>Sarees</PARENT><BASEUNITS>Nos</BASEUNITS>
</STOCKITEM>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  const res = await sendToTally(xml);
  console.log('DUPLICATE NAME:', res.body);
  const created = res.body.includes('<CREATED>1</CREATED>');
  const altered = res.body.includes('<ALTERED>1</ALTERED>');
  console.log('Result:', created ? 'CREATED (new item!)' : altered ? 'ALTERED existing!' : 'REJECTED');
  return { created, altered };
}

async function testDuplicateAlias() {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<STOCKITEM NAME="Different Name Dup Alias Test" ACTION="Create">
  <NAME.LIST><NAME>Different Name Dup Alias Test</NAME><NAME>TEST-SAI-0099</NAME></NAME.LIST>
  <PARENT>Sarees</PARENT><BASEUNITS>Nos</BASEUNITS>
</STOCKITEM>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  const res = await sendToTally(xml);
  console.log('DUPLICATE ALIAS:', res.body);
  const created = res.body.includes('<CREATED>1</CREATED>');
  console.log('Result:', created ? 'CREATED (Tally allows dup aliases!)' : 'REJECTED');
  return { created };
}

async function testVoucherTypes() {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><EXPORTDATA><REQUESTDESC>
<REPORTNAME>List of Accounts</REPORTNAME>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<ACCOUNTTYPE>Voucher Type</ACCOUNTTYPE>
</STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;
  const res = await sendToTally(xml);
  console.log('VOUCHER TYPES (first 3000):', res.body.slice(0, 3000));
  return { 
    hasReceiptNote: res.body.includes('Receipt Note'),
    hasStockJournal: res.body.includes('Stock Journal')
  };
}

async function main() {
  console.log('PHASE 2 PRE-FLIGHT: TallyPrime XML Tests @ 127.0.0.1:9000');
  console.log('='.repeat(70));
  
  await test('1. Connectivity', testConnectivity);
  await test('2. Export SR-1042-R', testExportStockItem);
  await test('3. Create item + GSTDETAILS.LIST', testCreateStockItemWithGST);
  await test('4. Online godown', testCreateOnlineGodown);
  await test('5. Receipt Note', testReceiptNote);
  await test('6. Stock Journal', testStockJournal);
  await test('7. Alias lookup', testAliasLookup);
  await test('8. Duplicate name', testDuplicateName);
  await test('9. Duplicate alias', testDuplicateAlias);
  await test('10. Voucher types', testVoucherTypes);

  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  for (const [name, r] of Object.entries(results)) {
    console.log(`${r.status === 'PASS' ? '✅' : '❌'} ${name}: ${r.status}${r.error ? ' — ' + r.error : ''}`);
  }
}

main().catch(e => {
  console.error('FATAL:', e.message);
  if (e.code === 'ECONNREFUSED') console.error('TallyPrime is not running on port 9000.');
  process.exit(1);
});
