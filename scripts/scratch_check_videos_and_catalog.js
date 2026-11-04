const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf-8');
const env = {};
for (const line of content.split(/\r?\n/)) {
  const t = line.trim();
  if (t && !t.startsWith('#')) {
    const eq = t.indexOf('=');
    if (eq !== -1) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
  }
}

async function main() {
  const headers = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };

  const vRes = await fetch(`${env.SUPABASE_URL}/rest/v1/video_record?select=*`, { headers });
  const videos = await vRes.json();
  console.log(`\n📹 video_record count: ${videos.length}`);
  videos.forEach(v => {
    console.log(`• VideoID: ${v.video_id} | Code: ${v.product_code} | Source: ${v.source_url} | Frames: ${v.reference_frames?.length || 0}`);
  });

  const cRes = await fetch(`${env.SUPABASE_URL}/rest/v1/saree_catalog?select=*`, { headers });
  const catalog = await cRes.json();
  console.log(`\n🥻 saree_catalog count: ${catalog.length}`);
  catalog.forEach(c => {
    console.log(`• ID: ${c.id} | SKU: ${c.sku} | Name: ${c.name} | Stock: ${c.stock_quantity} | Listed: ${c.is_listed}`);
  });
}

main().catch(console.error);
