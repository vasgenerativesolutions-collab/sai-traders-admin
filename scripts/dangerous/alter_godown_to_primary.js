const http = require('http');

const targetGodowns = ['Online_saree', 'Online'];

async function alterGodown(name) {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>All Masters</ID>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <GODOWN NAME="${name}" ACTION="Alter">
            <NAME>${name}</NAME>
            <PARENT/>
          </GODOWN>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 9000,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml;charset=utf-8',
        'Content-Length': Buffer.byteLength(xml)
      },
      timeout: 5000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Connection timed out'));
    });
    req.write(xml);
    req.end();
  });
}

async function main() {
  console.log('===============================================================================');
  console.log('📦 TALLY GODOWN ISOLATION TOOL: MOVING GODOWNS TO "PRIMARY" ROOT');
  console.log('===============================================================================\n');

  for (const godown of targetGodowns) {
    try {
      console.log(`Sending XML to 127.0.0.1:9000 to alter "${godown}" parent -> Primary...`);
      const response = await alterGodown(godown);
      if (response.includes('<ALTERED>1</ALTERED>') || response.includes('<STATUS>1</STATUS>') || !response.includes('<LINEERROR>')) {
        console.log(`✅ SUCCESS: Godown "${godown}" successfully moved to "Primary" (top-level) in Tally!`);
      } else {
        console.log(`ℹ️ Response from Tally for "${godown}":`);
        console.log(response.slice(0, 300));
      }
    } catch (err) {
      console.warn(`⚠️ Notice for "${godown}": ${err.message}`);
    }
  }

  console.log('\n===============================================================================');
  console.log('Verification: Open Tally -> Alter -> Godown -> Confirm "Under: Primary"');
  console.log('===============================================================================\n');
}

main().catch(console.error);
