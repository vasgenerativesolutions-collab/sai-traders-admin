const http = require('http');
const fs = require('fs');

function send(xml) {
  return new Promise((resolve, reject) => {
    const req = http.request({hostname:'127.0.0.1',port:9000,path:'/',method:'POST',
      headers:{'Content-Type':'text/xml;charset=utf-8','Content-Length':Buffer.byteLength(xml)}},
      r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>resolve(d))});
    req.on('error',reject);req.write(xml);req.end();
  });
}

async function main() {
  // 1. Full individual export of SR-1042-R
  console.log('=== FULL EXPORT SR-1042-R ===');
  const r1 = await send(`<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><EXPORTDATA><REQUESTDESC>
<REPORTNAME>Stock Item</REPORTNAME>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<STOCKITEMNAME>SR-1042-R</STOCKITEMNAME>
</STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`);
  fs.writeFileSync('c:/sai_traders/scripts/tally_export_sr1042r.xml', r1);
  console.log('Saved. Length:', r1.length);
  
  // 2. All stock items full detail
  console.log('\n=== ALL STOCK ITEMS ===');
  const r2 = await send(`<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><EXPORTDATA><REQUESTDESC>
<REPORTNAME>Stock Item</REPORTNAME>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
</STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`);
  fs.writeFileSync('c:/sai_traders/scripts/tally_export_all_items.xml', r2);
  console.log('Saved. Length:', r2.length);
  const nameBlocks = r2.match(/<NAME\.LIST[^>]*>[\s\S]*?<\/NAME\.LIST>/gi) || [];
  console.log('NAME.LIST blocks:', nameBlocks.length);
  nameBlocks.slice(0, 10).forEach((b,i) => console.log('  ', i, b.slice(0,200)));
  
  // 3. Alter test item with GST using state=Karnataka
  console.log('\n=== GST ALTER (Karnataka) ===');
  const r3 = await send(`<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<STOCKITEM NAME="Test Emerald Silk Saree &amp; Gold Border" ACTION="Alter">
  <HSNCODE>5007</HSNCODE>
  <GSTAPPLICABLE>&#4;Applicable</GSTAPPLICABLE>
  <GSTTYPEOFSUPPLY>Goods</GSTTYPEOFSUPPLY>
  <GSTDETAILS.LIST>
    <APPLICABLEFROM>20260401</APPLICABLEFROM>
    <HSNCODE>5007</HSNCODE>
    <TAXABILITY>Taxable</TAXABILITY>
    <GSTTYPEOFSUPPLY>Goods</GSTTYPEOFSUPPLY>
    <STATEWISEDETAILS.LIST>
      <STATENAME>Karnataka</STATENAME>
      <RATEDETAILS.LIST>
        <GSTRATE>5</GSTRATE>
        <SGSTRATE>2.5</SGSTRATE>
        <CGSTRATE>2.5</CGSTRATE>
        <IGSTRATE>5</IGSTRATE>
      </RATEDETAILS.LIST>
    </STATEWISEDETAILS.LIST>
  </GSTDETAILS.LIST>
</STOCKITEM>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`);
  console.log('GST Alter:', r3);
  
  // 4. Re-export test item to check GST
  console.log('\n=== RE-EXPORT TEST ITEM ===');
  const r4 = await send(`<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><EXPORTDATA><REQUESTDESC>
<REPORTNAME>Stock Item</REPORTNAME>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<STOCKITEMNAME>Test Emerald Silk Saree &amp; Gold Border</STOCKITEMNAME>
</STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`);
  fs.writeFileSync('c:/sai_traders/scripts/tally_export_test_gst.xml', r4);
  console.log('Saved. Length:', r4.length);
  const igst = r4.match(/<GSTMSTINFOIGSTRATE>([^<]+)/i);
  const hsn = r4.match(/<GSTMSTINFOHSNSAC>([^<]*)/i);
  console.log('IGST rate:', igst ? igst[1] : 'not found');
  console.log('HSN:', hsn ? (hsn[1] || '(empty)') : 'not found');
  
  // 5. Sarees group with no parent
  console.log('\n=== SAREES GROUP ===');
  const r5 = await send(`<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<STOCKGROUP NAME="Sarees" ACTION="Create"><NAME>Sarees</NAME></STOCKGROUP>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`);
  console.log('Group (no parent):', r5);
  
  // 6. Export the Receipt Note we just created to see exact structure
  console.log('\n=== EXPORT RECEIPT NOTE ===');
  const r6 = await send(`<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><EXPORTDATA><REQUESTDESC>
<REPORTNAME>Voucher Register</REPORTNAME>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<VOUCHERTYPENAME>Receipt Note</VOUCHERTYPENAME>
</STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`);
  fs.writeFileSync('c:/sai_traders/scripts/tally_export_receipt_note.xml', r6);
  console.log('Saved Receipt Note export. Length:', r6.length);
  console.log(r6.slice(0, 3000));
  
  // 7. Export Stock Journal
  console.log('\n=== EXPORT STOCK JOURNAL ===');
  const r7 = await send(`<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><EXPORTDATA><REQUESTDESC>
<REPORTNAME>Voucher Register</REPORTNAME>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<VOUCHERTYPENAME>Stock Journal</VOUCHERTYPENAME>
</STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`);
  fs.writeFileSync('c:/sai_traders/scripts/tally_export_stock_journal.xml', r7);
  console.log('Saved Stock Journal export. Length:', r7.length);
  console.log(r7.slice(0, 3000));
}

main().catch(e => console.error(e.message));
