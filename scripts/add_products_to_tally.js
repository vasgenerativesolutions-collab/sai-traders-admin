const http = require('http');

/**
 * Script to automatically import Saree Products, Units, and Stock into TallyPrime
 * via Tally's XML HTTP Server on port 9000.
 *
 * Run: node scripts/add_products_to_tally.js
 */

function sendToTally(xml) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 9000,
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
    req.write(xml);
    req.end();
  });
}

// Products to create in Tally
const products = [
  {
    sku: "SR-1042-R",
    alias: "Royal Blue Soft Silk Elephant Zari Border",
    units: "Pcs",
    openingQty: 4,
    rate: 4650.00
  },
  {
    sku: "SAI-KANJ-01",
    alias: "Crimson Regal Kanjivaram Silk Saree",
    units: "Pcs",
    openingQty: 4,
    rate: 12500.00
  },
  {
    sku: "SAI-BAN-02",
    alias: "Royal Sapphire Banarasi Katan Silk Saree",
    units: "Pcs",
    openingQty: 5,
    rate: 8999.00
  },
  {
    sku: "SAI-BAN-03",
    alias: "Marigold Sunburst Bandhani Georgette Saree",
    units: "Pcs",
    openingQty: 8,
    rate: 4750.00
  },
  {
    sku: "SAI-CHAN-04",
    alias: "Pastel Mint Whisper Chanderi Silk Cotton Saree",
    units: "Pcs",
    openingQty: 10,
    rate: 3200.00
  },
  {
    sku: "SAI-ORG-05",
    alias: "Blush Rose Handpainted Organza Silk Saree",
    units: "Pcs",
    openingQty: 6,
    rate: 5600.00
  }
];

function buildImportXml() {
  const itemMessages = products.map(p => {
    const totalVal = (p.openingQty * p.rate).toFixed(2);
    return `
      <TALLYMESSAGE xmlns:UDF="TallyUDF">
        <STOCKITEM NAME="${p.sku}" ACTION="Alter">
          <NAME.LIST>
            <NAME>${p.sku}</NAME>
            <NAME>${p.alias}</NAME>
          </NAME.LIST>
          <BASEUNITS>${p.units}</BASEUNITS>
          <OPENINGBALANCE>${p.openingQty} ${p.units}</OPENINGBALANCE>
          <OPENINGRATE>${p.rate.toFixed(2)}/${p.units}</OPENINGRATE>
          <OPENINGVALUE>-${totalVal}</OPENINGVALUE>
          <BATCHALLOCATIONS.LIST>
            <GODOWNNAME>Main Location</GODOWNNAME>
            <BATCHNAME>Primary Batch</BATCHNAME>
            <OPENINGBALANCE>${p.openingQty} ${p.units}</OPENINGBALANCE>
            <OPENINGRATE>${p.rate.toFixed(2)}/${p.units}</OPENINGRATE>
            <OPENINGVALUE>-${totalVal}</OPENINGVALUE>
          </BATCHALLOCATIONS.LIST>
        </STOCKITEM>
      </TALLYMESSAGE>`;
  }).join('');

  return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
      </REQUESTDESC>
      <REQUESTDATA>
        <!-- 1. Create Unit Pcs -->
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <UNIT NAME="Pcs" ACTION="Create">
            <NAME>Pcs</NAME>
            <ISSIMPLEUNIT>Yes</ISSIMPLEUNIT>
            <DECIMALPLACES>0</DECIMALPLACES>
          </UNIT>
        </TALLYMESSAGE>
        <!-- 2. Create Stock Items -->
        ${itemMessages}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

async function verifyStockItem(sku) {
  const queryXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Export Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Stock Item</REPORTNAME>
        <STATICVARIABLES>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
          <STOCKITEMNAME>${sku}</STOCKITEMNAME>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;

  try {
    const res = await sendToTally(queryXml);
    const balanceMatch = res.body.match(/<CLOSINGBALANCE>([^<]+)<\/CLOSINGBALANCE>/i);
    const rateMatch = res.body.match(/<RATE>([^<]+)<\/RATE>/i);
    return {
      exists: !res.body.includes("Unknown Stock Item") && !res.body.includes("<LINEERROR>"),
      balance: balanceMatch ? balanceMatch[1] : null,
      rate: rateMatch ? rateMatch[1] : null
    };
  } catch (e) {
    return { exists: false, error: e.message };
  }
}

async function main() {
  console.log("===============================================================================");
  console.log("🚀 IMPORTING PRODUCTS & INVENTORY DIRECTLY INTO TALLY PRIME");
  console.log("===============================================================================\n");

  console.log("1. Sending XML Master Import request to TallyPrime on port 9000...");
  const importXml = buildImportXml();
  const importRes = await sendToTally(importXml);

  console.log("   Tally Response Code:", importRes.status);
  console.log("   Response Details:\n", importRes.body);

  console.log("\n2. Verifying created products in Tally...");
  for (const p of products) {
    const check = await verifyStockItem(p.sku);
    if (check.exists) {
      console.log(`   ✅ ${p.sku}: In Tally! Closing Balance = ${check.balance || '0 Pcs'}, Rate = ${check.rate || '₹' + p.rate}`);
    } else {
      console.log(`   ⚠️ ${p.sku}: Pending company acceptance in TallyPrime.`);
    }
  }

  console.log("\n===============================================================================");
}

main().catch(console.error);
