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

async function main() {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/app_settings?select=*`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }
  });
  const data = await res.json();
  console.log('App settings in Supabase:');
  console.log(data);

  // Check webhook verification endpoint
  const webhookUrl = `${env.SUPABASE_URL}/functions/v1/whatsapp-webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(env.WHATSAPP_VERIFY_TOKEN)}&hub.challenge=1158201444`;
  console.log('\nTesting Webhook GET verification:');
  const whRes = await fetch(webhookUrl);
  const whText = await whRes.text();
  console.log('Webhook verification status:', whRes.status, 'Response:', whText);
}

main().catch(console.error);
