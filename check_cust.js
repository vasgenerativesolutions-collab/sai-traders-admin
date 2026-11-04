const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(path.resolve(__dirname, '.env'), 'utf-8');
const env = {};
for (const line of content.split(/\r?\n/)) {
  const t = line.trim();
  if (t && !t.startsWith('#')) {
    const eq = t.indexOf('=');
    if (eq !== -1) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
  }
}

async function checkCustomer() {
  const cRes = await fetch(`${env.SUPABASE_URL}/rest/v1/customers?id=eq.8e3836f5-903f-4d27-996b-54bfd5968eac&select=*`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }
  });
  const cust = await cRes.json();
  console.log('Customer:', cust);
}

checkCustomer().catch(console.error);
