const fs = require('fs');
const d = fs.readFileSync('c:/sai_traders/scripts/tally_collection_after_gst.xml', 'utf8');
// Find the test item block
const b = d.match(/<STOCKITEM NAME="Test Emerald[^"]*"[^>]*>[\s\S]*?<\/STOCKITEM>/i);
if (b) {
  const sw = b[0].match(/<STATEWISEDETAILS\.LIST>[\s\S]*?<\/STATEWISEDETAILS\.LIST>/gi);
  if (sw) sw.forEach(function(s,i) { console.log('STATEWISE', i, ':', s); });
  else console.log('No STATEWISEDETAILS');
  
  // Also get RATEDETAILS
  const rd = b[0].match(/<RATEDETAILS\.LIST>[\s\S]*?<\/RATEDETAILS\.LIST>/gi);
  if (rd) rd.forEach(function(r,i) { console.log('RATEDETAILS', i, ':', r); });
  else console.log('No RATEDETAILS');
} else {
  console.log('Block not found');
}

// Also check the MYSORE item (SAI-0021) which is under Sarees group
console.log('\n=== MYSORE ITEM ===');
const m = d.match(/<STOCKITEM NAME="MYSORE[^"]*"[^>]*>[\s\S]*?<\/STOCKITEM>/i);
if (m) {
  const msw = m[0].match(/<STATEWISEDETAILS\.LIST>[\s\S]*?<\/STATEWISEDETAILS\.LIST>/gi);
  if (msw) msw.forEach(function(s,i) { console.log('MYSORE STATEWISE', i, ':', s); });
  const mrd = m[0].match(/<RATEDETAILS\.LIST>[\s\S]*?<\/RATEDETAILS\.LIST>/gi);
  if (mrd) mrd.forEach(function(r,i) { console.log('MYSORE RATEDETAILS', i, ':', r); });
}
