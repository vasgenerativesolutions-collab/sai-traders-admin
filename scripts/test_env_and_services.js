const fs = require('fs');
const http = require('http');

// Read .env
const envFile = fs.readFileSync('.env', 'utf-8');
const env = {};
envFile.split('\n').forEach(line => {
  const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)?\s*$/);
  if (match) {
    let val = match[2] || '';
    val = val.trim().replace(/^["']|["']$/g, '');
    env[match[1]] = val;
  }
});

async function runTest() {
  console.log("===============================================================================");
  console.log("🧪 SAI TRADERS — END-TO-END SYSTEM HEALTH CHECK & TEST RUN");
  console.log("===============================================================================\n");

  let allPassed = true;

  // 1. Meta WhatsApp Cloud API Check
  console.log("1️⃣ Checking Meta WhatsApp Cloud API Credentials...");
  try {
    const waUrl = `https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}?access_token=${env.WHATSAPP_ACCESS_TOKEN}`;
    const waRes = await fetch(waUrl);
    const waData = await waRes.json();
    if (waRes.ok) {
      console.log(`   ✅ WhatsApp API Token is VALID!`);
      console.log(`      • Verified Name: ${waData.verified_name || "N/A"}`);
      console.log(`      • Display Phone: ${waData.display_phone_number || "N/A"}`);
      console.log(`      • Quality Rating: ${waData.quality_rating || "N/A"}`);
      console.log(`      • Status: ${waData.code_verification_status || "VERIFIED"}`);
    } else {
      allPassed = false;
      console.log(`   ❌ WhatsApp API Error:`, waData.error?.message || waData);
    }
  } catch (err) {
    allPassed = false;
    console.log(`   ❌ WhatsApp Connection Failed:`, err.message);
  }

  // 2. Google Gemini Vision & Embedding Check
  console.log("\n2️⃣ Checking Google Gemini AI Credentials...");
  try {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL || "gemini-3.5-flash"}:generateContent?key=${env.GEMINI_API_KEY}`;
    const gRes = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "Hello! Confirm you are active in 5 words." }] }]
      })
    });
    const gData = await gRes.json();
    if (gRes.ok) {
      const reply = gData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      console.log(`   ✅ Gemini AI (${env.GEMINI_MODEL || "gemini-3.5-flash"}) is ACTIVE!`);
      console.log(`      • Response: "${reply}"`);
    } else {
      allPassed = false;
      console.log(`   ❌ Gemini Error:`, gData.error?.message || gData);
    }
  } catch (err) {
    allPassed = false;
    console.log(`   ❌ Gemini Connection Failed:`, err.message);
  }

  // 3. Supabase Database & Saree Catalog Check
  console.log("\n3️⃣ Checking Supabase Database & Saree Catalog...");
  try {
    const sbUrl = `${env.SUPABASE_URL}/rest/v1/saree_catalog?select=sku,name,stock_quantity,price&limit=5`;
    const sbRes = await fetch(sbUrl, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
      }
    });
    const sbData = await sbRes.json();
    if (sbRes.ok) {
      console.log(`   ✅ Supabase DB is CONNECTED! Found ${sbData.length} sample sarees:`);
      sbData.forEach(s => {
        console.log(`      • [${s.sku}] ${s.name.slice(0, 35)}... (Qty: ${s.stock_quantity}, ₹${s.price})`);
      });
    } else {
      allPassed = false;
      console.log(`   ❌ Supabase Error:`, sbData);
    }
  } catch (err) {
    allPassed = false;
    console.log(`   ❌ Supabase Connection Failed:`, err.message);
  }

  // 4. Live TallyPrime Port 9000 Check
  console.log("\n4️⃣ Checking Live TallyPrime HTTP Gateway (Port 9000)...");
  try {
    const tallyXml = `<?xml version="1.0" encoding="utf-8"?>
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

    const tallyRes = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: 9000,
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml;charset=utf-8',
          'Content-Length': Buffer.byteLength(tallyXml)
        }
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.write(tallyXml);
      req.end();
    });

    if (tallyRes.status === 200 && tallyRes.body.includes("SR-1042-R")) {
      console.log(`   ✅ TallyPrime is CONNECTED and RESPONDING on port 9000!`);
      const match = tallyRes.body.match(/<DSPDISPNAME>SR-1042-R<\/DSPDISPNAME>[\s\S]*?<DSPCLQTY>([^<]+)<\/DSPCLQTY>/i);
      console.log(`      • Saree SR-1042-R Closing Balance in Tally: ${match ? match[1] : "Active"}`);
    } else {
      console.log(`   ⚠️ TallyPrime responded with status ${tallyRes.status}.`);
    }
  } catch (err) {
    console.log(`   ⚠️ TallyPrime gateway check note:`, err.message);
  }

  console.log("\n===============================================================================");
  if (allPassed) {
    console.log("🎉 ALL CORE CREDENTIALS & SERVICES ARE 100% OPERATIONAL!");
  } else {
    console.log("⚠️ Some services encountered issues. Review details above.");
  }
  console.log("===============================================================================");
}

runTest().catch(console.error);
