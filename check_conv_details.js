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
  const mRes = await fetch(`${env.SUPABASE_URL}/rest/v1/messages?conversation_id=eq.14ec2438-5f88-4903-940f-f89c5d3f0be7&order=created_at.desc&limit=15`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }
  });
  const msgs = await mRes.json();
  console.log('Conversation messages (inbound & outbound):');
  console.table(msgs.map(m => ({
    id: m.id,
    dir: m.direction,
    type: m.message_type,
    content: (m.content || '').slice(0, 50),
    created: m.created_at
  })));

  // Also check orders table
  const oRes = await fetch(`${env.SUPABASE_URL}/rest/v1/orders?order=created_at.desc&limit=2`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }
  });
  const orders = await oRes.json();
  console.log('\nLatest orders:');
  console.log(orders);
}

main().catch(console.error);
