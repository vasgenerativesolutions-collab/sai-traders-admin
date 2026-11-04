const { sendToTally, parseTallyQuantity, normalizeSku } = require('./tally_client');
const config = require('./config');

/**
 * XML Request for Tally Stock Summary Report
 */
const STOCK_SUMMARY_REQUEST_XML = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Stock Summary</REPORTNAME>
        <STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;

/**
 * Queries all stock items and their closing balances from TallyPrime
 */
async function getTallyStockSummary() {
  try {
    const res = await sendToTally(STOCK_SUMMARY_REQUEST_XML);
    if (!res.body.includes("<ENVELOPE>")) {
      return [];
    }

    const items = [];
    const itemRegex = /<DSPACCNAME>[\s\S]*?<DSPDISPNAME>([^<]+)<\/DSPDISPNAME>[\s\S]*?<\/DSPACCNAME>[\s\S]*?<DSPSTKCL>[\s\S]*?<DSPCLQTY>([^<]+)<\/DSPCLQTY>(?:[\s\S]*?<DSPCLRATE>([^<]+)<\/DSPCLRATE>)?/gi;

    let match;
    while ((match = itemRegex.exec(res.body)) !== null) {
      const name = match[1].trim();
      const qtyStr = match[2].trim();
      const rateStr = match[3] ? match[3].trim() : "0";

      items.push({
        sku: name,
        stockQuantity: parseTallyQuantity(qtyStr),
        rate: parseFloat(rateStr.replace(/[^0-9.]/g, '')) || 0,
        rawQty: qtyStr
      });
    }

    return items;
  } catch (err) {
    console.warn("Could not fetch Tally Stock Summary:", err.message);
    return [];
  }
}

/**
 * Syncs all current Tally closing balances into Supabase saree_catalog
 */
async function syncTallyToCatalog() {
  const tallyItems = await getTallyStockSummary();
  if (tallyItems.length === 0) return 0;

  let updatedCount = 0;
  for (const item of tallyItems) {
    try {
      const res = await fetch(`${config.supabaseUrl}/rest/v1/saree_catalog?sku=eq.${encodeURIComponent(item.sku)}`, {
        method: "PATCH",
        headers: {
          apikey: config.supabaseServiceKey,
          Authorization: `Bearer ${config.supabaseServiceKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ stock_quantity: item.stockQuantity })
      });
      if (res.ok) updatedCount++;
    } catch (_err) {}
  }

  return updatedCount;
}

module.exports = {
  getTallyStockSummary,
  syncTallyToCatalog
};
