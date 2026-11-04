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
  // 1. List of Stock Items (different report name)
  console.log('=== LIST OF STOCK ITEMS ===');
  const r1 = await send(
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>\n' +
    '<BODY><EXPORTDATA><REQUESTDESC>\n' +
    '<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>\n' +
    '<REPORTNAME>List of Stock Items</REPORTNAME>\n' +
    '</REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>'
  );
  fs.writeFileSync('c:/sai_traders/scripts/tally_list_stock_items.xml', r1);
  console.log('Length:', r1.length);
  console.log(r1.slice(0, 3000));

  // 2. Fetch by alias (TEST-SAI-0099 is alias of our test item)
  console.log('\n=== FETCH BY ALIAS ===');
  const r2 = await send(
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>\n' +
    '<BODY><EXPORTDATA><REQUESTDESC>\n' +
    '<REPORTNAME>Stock Item</REPORTNAME>\n' +
    '<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>\n' +
    '<STOCKITEMNAME>TEST-SAI-0099</STOCKITEMNAME>\n' +
    '</STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>'
  );
  console.log('Fetch by alias result (first 500):', r2.slice(0, 500));
  console.log('Found (not unknown):', !r2.includes('Unknown') && r2.length > 200);

  // 3. Parse exported vouchers
  console.log('\n=== RECEIPT NOTE DETAILS ===');
  const rn = fs.readFileSync('c:/sai_traders/scripts/tally_export_receipt_note.xml', 'utf8');
  const rnGuid = rn.match(/<GUID>([^<]+)<\/GUID>/i);
  const rnVch = rn.match(/<VOUCHERNUMBER>([^<]+)<\/VOUCHERNUMBER>/i);
  const rnRef = rn.match(/<REFERENCE>([^<]+)<\/REFERENCE>/i);
  const rnRemote = rn.match(/REMOTEID="([^"]+)"/i);
  console.log('GUID:', rnGuid ? rnGuid[1] : 'NOT FOUND');
  console.log('VOUCHERNUMBER:', rnVch ? rnVch[1] : 'NOT FOUND');
  console.log('REFERENCE:', rnRef ? rnRef[1] : 'NOT FOUND');
  console.log('REMOTEID:', rnRemote ? rnRemote[1] : 'NOT FOUND');
  
  // Extract inventory entries
  const rnInv = rn.match(/<ALLINVENTORYENTRIES\.LIST>[\s\S]*?<\/ALLINVENTORYENTRIES\.LIST>/i);
  if (rnInv) {
    console.log('\nRECEIPT NOTE INVENTORY:');
    console.log(rnInv[0]);
  }

  console.log('\n=== STOCK JOURNAL DETAILS ===');
  const sj = fs.readFileSync('c:/sai_traders/scripts/tally_export_stock_journal.xml', 'utf8');
  const sjGuid = sj.match(/<GUID>([^<]+)<\/GUID>/i);
  const sjVch = sj.match(/<VOUCHERNUMBER>([^<]+)<\/VOUCHERNUMBER>/i);
  console.log('GUID:', sjGuid ? sjGuid[1] : 'NOT FOUND');
  console.log('VOUCHERNUMBER:', sjVch ? sjVch[1] : 'NOT FOUND');
  
  // Extract all inventory entry lists
  const sjInvAll = sj.match(/<INVENTORYENTRIES[A-Z]*\.LIST>[\s\S]*?<\/INVENTORYENTRIES[A-Z]*\.LIST>/gi);
  if (sjInvAll) {
    sjInvAll.forEach(function(m, i) {
      console.log('\nSJ INVENTORY ENTRY ' + i + ':');
      console.log(m);
    });
  }

  // 4. Check if NARRATION and REFERENCE were preserved
  const rnNarr = rn.match(/<NARRATION>([^<]*)<\/NARRATION>/i);
  console.log('\nRN NARRATION:', rnNarr ? rnNarr[1] : 'NOT FOUND');
  const sjNarr = sj.match(/<NARRATION>([^<]*)<\/NARRATION>/i);
  console.log('SJ NARRATION:', sjNarr ? sjNarr[1] : 'NOT FOUND');
}

main().catch(function(e) { console.error(e.message); });
