/**
 * Sai Traders Agent — Low-Level Tally HTTP/XML Client
 * Communicates strictly with TallyPrime on localhost:9000.
 * OUTBOUND ONLY — Opens zero listening ports.
 */

const http = require('http');
const config = require('./config');

/**
 * Dispatches an XML request to TallyPrime HTTP XML Gateway
 */
function sendToTally(xml, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: config.tallyHost || '127.0.0.1',
      port: config.tallyPort || 9000,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml;charset=utf-8',
        'Content-Length': Buffer.byteLength(xml)
      },
      timeout: timeoutMs
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Tally request timed out after ${timeoutMs}ms`));
    });

    req.write(xml);
    req.end();
  });
}

/**
 * Parses numeric quantity from Tally XML string, e.g. "4.00 Pcs", "12 Nos", "0"
 */
function parseTallyQuantity(qtyStr) {
  if (!qtyStr) return 0;
  const match = qtyStr.match(/([-+]?[0-9]+(?:\.[0-9]+)?)/);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  return isNaN(val) ? 0 : Math.max(0, Math.floor(val));
}

function unescapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Comprehensive health check for TallyPrime:
 * 1. Reachable on port 9000
 * 2. Active company loaded
 * 3. "Online" Godown exists
 */
async function checkTallyHealth(targetGodown = 'Online') {
  const result = {
    reachable: false,
    companyLoaded: null,
    godownExists: false,
    error: null
  };

  try {
    // 1. Check Company & Connectivity
    const companyXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>List of Companies</REPORTNAME>
        <STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;

    const compRes = await sendToTally(companyXml, 3500);
    result.reachable = true;

    // Extract active company name
    const compMatch = compRes.body.match(/<COMPANYNAME>([^<]+)<\/COMPANYNAME>/i) ||
                      compRes.body.match(/<NAME>([^<]+)<\/NAME>/i);
    if (compMatch) {
      result.companyLoaded = unescapeXml(compMatch[1].trim());
    } else if (compRes.body.includes('<ENVELOPE>')) {
      result.companyLoaded = 'Active Company Loaded';
    }

    // 2. Check if the specified Godown ("Online") exists
    const godownXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>List of Accounts</REPORTNAME>
        <STATICVARIABLES>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
          <ACCOUNTTYPE>Godowns</ACCOUNTTYPE>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;

    const godownRes = await sendToTally(godownXml, 3500);
    const godownRegex = new RegExp(`<NAME>\\s*${targetGodown}\\s*<\\/NAME>|<GODOWNNAME>\\s*${targetGodown}\\s*<\\/GODOWNNAME>`, 'i');
    result.godownExists = godownRegex.test(godownRes.body) || godownRes.body.toLowerCase().includes(targetGodown.toLowerCase());

  } catch (err) {
    result.reachable = false;
    result.error = err.message;
  }

  return result;
}

/**
 * Reads closing balances strictly for the specified Godown ("Online")
 */
async function readGodownBalances(godownName = 'Online') {
  // Try Godown Summary report first
  const godownXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Godown Summary</REPORTNAME>
        <STATICVARIABLES>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
          <EXPLODEFLAG>Yes</EXPLODEFLAG>
          <ISITEMWISE>Yes</ISITEMWISE>
          <SVFROMNAME>${godownName}</SVFROMNAME>
          <SVTONAME>${godownName}</SVTONAME>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;

  try {
    const res = await sendToTally(godownXml, 8000);
    const items = [];

    // Parse items from Tally XML report
    const itemRegex = /<DSPACCNAME>[\s\S]*?<DSPDISPNAME>([^<]+)<\/DSPDISPNAME>[\s\S]*?<\/DSPACCNAME>[\s\S]*?<DSPSTKCL>[\s\S]*?<DSPCLQTY>([^<]+)<\/DSPCLQTY>(?:[\s\S]*?<DSPCLRATE>([^<]+)<\/DSPCLRATE>)?/gi;
    let match;

    while ((match = itemRegex.exec(res.body)) !== null) {
      const name = unescapeXml(match[1]).trim();
      const qtyStr = match[2].trim();
      const rateStr = match[3] ? match[3].trim() : '0';

      // Ignore group summary headers (e.g. "Sarees" category)
      if (name.toLowerCase() === 'sarees' || name.toLowerCase() === 'primary') {
        continue;
      }

      items.push({
        product_code: name,
        godown: godownName,
        tally_qty: parseTallyQuantity(qtyStr),
        raw_qty: qtyStr,
        rate: parseFloat(rateStr.replace(/[^0-9.]/g, '')) || 0
      });
    }

    return { success: true, items, rawResponseLength: res.body.length };
  } catch (err) {
    return { success: false, items: [], error: err.message };
  }
}

module.exports = {
  sendToTally,
  parseTallyQuantity,
  unescapeXml,
  checkTallyHealth,
  readGodownBalances
};
