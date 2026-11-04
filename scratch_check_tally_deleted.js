const http = require('http');

function send(xml) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 9000,
      path: '/',
      method: 'POST',
      headers: { 'Content-Type': 'text/xml;charset=utf-8', 'Content-Length': Buffer.byteLength(xml) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(xml);
    req.end();
  });
}

function unescapeXml(str) {
  if (!str) return '';
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
}

async function checkTallyLive() {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CustomStockItems</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CustomStockItems">
            <TYPE>StockItem</TYPE>
            <FETCH>Name,Parent,ClosingBalance,OpeningBalance,PartNo,StandardPrice</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

  const text = await send(xml);
  const items = [];
  const regex = /<STOCKITEM NAME="([^"]+)"[\s\S]*?<CLOSINGBALANCE[^>]*>([^<]*)<\/CLOSINGBALANCE>(?:[\s\S]*?<CLOSINGRATE[^>]*>([^<]*)<\/CLOSINGRATE>)?(?:[\s\S]*?<STANDARDPRICE[^>]*>([^<]*)<\/STANDARDPRICE>)?/gi;
  let m;
  while ((m = regex.exec(text)) !== null) {
    items.push({
      name: unescapeXml(m[1]),
      closing: m[2].trim(),
      rate: m[3] ? m[3].trim() : '',
      stdPrice: m[4] ? m[4].trim() : ''
    });
  }
  console.log(`Found ${items.length} items in Tally:`);
  console.table(items);
}

checkTallyLive().catch(console.error);
