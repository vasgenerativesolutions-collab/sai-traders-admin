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
  const cRes = await fetch(`${env.SUPABASE_URL}/rest/v1/conversations?order=updated_at.desc&limit=5`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }
  });
  const convs = await cRes.json();
  console.log('Recent conversations:');
  console.log(convs);

  const mRes = await fetch(`${env.SUPABASE_URL}/rest/v1/messages?order=created_at.desc&limit=5`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }
  });
  const msgs = await mRes.json();
  console.log('\nRecent messages:');
  console.log(msgs);
}

main().catch(console.error);
