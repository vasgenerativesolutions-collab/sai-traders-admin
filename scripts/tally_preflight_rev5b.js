const fs = require('fs');
const http = require('http');

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
  // Parse the collection export for stock items
  const data = fs.readFileSync('c:/sai_traders/scripts/tally_collection_stockitems.xml', 'utf8');
  
  // Find all STOCKITEM blocks
  const stockItemBlocks = data.match(/<STOCKITEM NAME="[^"]*"[^>]*>[\s\S]*?<\/STOCKITEM>/gi) || [];
  console.log('=== STOCK ITEM BLOCKS ===');
  console.log('Count:', stockItemBlocks.length);
  
  for (const block of stockItemBlocks) {
    const nameAttr = block.match(/<STOCKITEM NAME="([^"]*)"/i);
    const guid = block.match(/<GUID>([^<]+)<\/GUID>/i);
    const nameListBlock = block.match(/<NAME\.LIST[^>]*>([\s\S]*?)<\/NAME\.LIST>/i);
    const names = nameListBlock ? nameListBlock[1].match(/<NAME>([^<]+)<\/NAME>/gi) : [];
    const parent = block.match(/<PARENT>([^<]+)<\/PARENT>/i);
    const baseUnits = block.match(/<BASEUNITS>([^<]+)<\/BASEUNITS>/i);
    const gstDetails = block.match(/<GSTDETAILS\.LIST>([\s\S]*?)<\/GSTDETAILS\.LIST>/i);
    const gstApplicable = block.match(/<GSTAPPLICABLE>([^<]+)<\/GSTAPPLICABLE>/i);
    
    console.log('\n--- STOCK ITEM ---');
    console.log('NAME attr:', nameAttr ? nameAttr[1] : '?');
    console.log('GUID:', guid ? guid[1] : 'NOT FOUND');
    console.log('NAMES:', names ? names.map(n => n.replace(/<\/?NAME>/gi, '')) : []);
    console.log('PARENT:', parent ? parent[1] : '?');
    console.log('BASEUNITS:', baseUnits ? baseUnits[1] : '?');
    console.log('GSTAPPLICABLE:', gstApplicable ? gstApplicable[1] : 'NOT FOUND');
    console.log('Has GSTDETAILS.LIST:', !!gstDetails);
    if (gstDetails) {
      console.log('GSTDETAILS.LIST:\n', gstDetails[0].slice(0, 1000));
      // Check for actual rate values
      const rates = gstDetails[1].match(/<GSTRATE>([^<]+)<\/GSTRATE>/gi) || [];
      const hsnMatch = gstDetails[1].match(/<HSNCODE>([^<]+)<\/HSNCODE>/i);
      console.log('Rates:', rates.map(r => r.replace(/<\/?GSTRATE>/gi, '')));
      console.log('HSN:', hsnMatch ? hsnMatch[1] : 'NOT FOUND');
    }
  }

  // Now try to set GST on the Sarees group directly and on an item
  console.log('\n\n=== SET GST ON SAREES GROUP ===');
  const gstGroup = await send(`<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<STOCKGROUP NAME="Sarees" ACTION="Alter">
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
</STOCKGROUP>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`);
  console.log('Group GST result:', gstGroup);

  // Re-export to see if GST is now set
  console.log('\n=== RE-EXPORT STOCK ITEMS AFTER GROUP GST ===');
  const r2 = await send(`<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><EXPORTDATA><REQUESTDESC>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
<REPORTNAME>List of Accounts</REPORTNAME>
<STATICVARIABLES><ACCOUNTTYPE>Stock Items</ACCOUNTTYPE></STATICVARIABLES>
</REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`);
  fs.writeFileSync('c:/sai_traders/scripts/tally_collection_after_gst.xml', r2);
  
  // Check the test item
  const testBlock = r2.match(/<STOCKITEM NAME="Test Emerald Silk Saree[^"]*"[^>]*>[\s\S]*?<\/STOCKITEM>/i);
  if (testBlock) {
    const gst = testBlock[0].match(/<GSTDETAILS\.LIST>([\s\S]*?)<\/GSTDETAILS\.LIST>/i);
    console.log('Test item GSTDETAILS after group set:', gst ? gst[0].slice(0,1000) : 'NOT FOUND');
    const rates = gst ? gst[1].match(/<GSTRATE>([^<]+)<\/GSTRATE>/gi) : null;
    console.log('Rates:', rates ? rates.map(r=>r.replace(/<\/?GSTRATE>/gi,'')) : 'none');
  }

  // Also try to set GST directly on the item with the GSTDETAILS.LIST 
  console.log('\n=== SET GST DIRECTLY ON ITEM via collection structure ===');
  const gstItem = await send(`<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<STOCKITEM NAME="Test Emerald Silk Saree &amp; Gold Border" ACTION="Alter">
  <GSTAPPLICABLE>&#4;Applicable</GSTAPPLICABLE>
  <GSTTYPEOFSUPPLY>Goods</GSTTYPEOFSUPPLY>
  <ISTAXUPDATED>Yes</ISTAXUPDATED>
  <ISTAXOVERRIDEENABLED>Yes</ISTAXOVERRIDEENABLED>
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
  console.log('Item GST with ISTAXUPDATED:', gstItem);

  // Re-export just that item via collection
  const r3 = await send(`<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><EXPORTDATA><REQUESTDESC>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
<REPORTNAME>List of Accounts</REPORTNAME>
<STATICVARIABLES><ACCOUNTTYPE>Stock Items</ACCOUNTTYPE></STATICVARIABLES>
</REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`);
  const testBlock2 = r3.match(/<STOCKITEM NAME="Test Emerald Silk Saree[^"]*"[^>]*>[\s\S]*?<\/STOCKITEM>/i);
  if (testBlock2) {
    const gst2 = testBlock2[0].match(/<GSTDETAILS\.LIST>([\s\S]*?)<\/GSTDETAILS\.LIST>/i);
    console.log('\nItem GST after ISTAXUPDATED:', gst2 ? gst2[0].slice(0,1500) : 'NOT FOUND');
  }
}

main().catch(e => console.error(e.message));
