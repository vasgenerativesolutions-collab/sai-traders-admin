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

async function checkSessions() {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/customer_sessions?order=updated_at.desc&limit=5`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }
  });
  const data = await res.json();
  console.log('Recent customer sessions:');
  console.log(data);

  const aRes = await fetch(`${env.SUPABASE_URL}/rest/v1/audit_log?entity_type=eq.whatsapp_message&order=created_at.desc&limit=5`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }
  });
  const audit = await aRes.json();
  console.log('Recent WhatsApp audit logs:');
  console.log(audit);
}

checkSessions().catch(console.error);
