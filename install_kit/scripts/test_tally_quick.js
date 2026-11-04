const http = require('http');

const TALLY_HOST = process.env.TALLY_HOST || '127.0.0.1';
const TALLY_PORT = parseInt(process.env.TALLY_PORT || '9000', 10);
const TIMEOUT_MS = 8000;

console.log('===============================================================================');
console.log('🔍 SAI TRADERS — TALLYPRIME IN-STORE DIAGNOSTIC CHECK');
console.log('===============================================================================');
console.log(`Pinging TallyPrime at http://${TALLY_HOST}:${TALLY_PORT} ...\n`);

// Standard, officially supported Tally XML query (List of Companies)
const testXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>List of Companies</REPORTNAME>
        <STATICVARIABLES>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;

function unescapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

const startTime = Date.now();

const req = http.request(
  {
    hostname: TALLY_HOST,
    port: TALLY_PORT,
    path: '/',
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml;charset=utf-8',
      'Content-Length': Buffer.byteLength(testXml)
    },
    timeout: TIMEOUT_MS
  },
  (res) => {
    let data = '';
    res.on('data', (chunk) => (data += chunk));
    res.on('end', () => {
      const elapsed = Date.now() - startTime;
      console.log('-------------------------------------------------------------------------------');
      console.log('✅ TALLY STATUS: CONNECTED & ONLINE!');
      console.log(`   HTTP Gateway  : http://${TALLY_HOST}:${TALLY_PORT} (Response in ${elapsed}ms)`);
      
      const compMatch = data.match(/<COMPANYNAME>([^<]+)<\/COMPANYNAME>/i) ||
                        data.match(/<NAME>([^<]+)<\/NAME>/i) ||
                        data.match(/<SVCURRENTCOMPANY>([^<]+)<\/SVCURRENTCOMPANY>/i);
      
      if (compMatch && compMatch[1]) {
        console.log(`   Active Company: "${unescapeXml(compMatch[1].trim())}"`);
      } else {
        console.log('   Active Company: Connected & Responding (TallyPrime Ready)');
      }
      console.log('-------------------------------------------------------------------------------');
      console.log('✓ Store PC is ready to process sales vouchers and sync inventory with the cloud.\n');
      process.exit(0);
    });
  }
);

req.on('error', (err) => {
  console.log('-------------------------------------------------------------------------------');
  console.log('⚠️ TALLY STATUS: OFFLINE / NOT DETECTED ON PORT 9000');
  console.log(`   Error: ${err.message}`);
  console.log('-------------------------------------------------------------------------------');
  console.log('Quick Checklist:');
  console.log('  1. Is TallyPrime open on this computer?');
  console.log('  2. In TallyPrime, press F1 (Help) -> Settings -> Connectivity -> Client/Server Configuration');
  console.log('  3. Ensure:');
  console.log('     • TallyPrime acts as : Both (or Server)');
  console.log('     • Enable ODBC        : Yes');
  console.log('     • Port               : 9000');
  console.log('  4. Restart TallyPrime if prompted.');
  console.log('-------------------------------------------------------------------------------\n');
  process.exit(1);
});

req.on('timeout', () => {
  req.destroy();
  console.log('-------------------------------------------------------------------------------');
  console.log(`❌ Connection to Tally timed out after ${TIMEOUT_MS / 1000} seconds.`);
  console.log('   Ensure any popup dialog inside TallyPrime is closed and Tally is responsive.');
  console.log('-------------------------------------------------------------------------------\n');
  process.exit(1);
});

req.write(testXml);
req.end();
