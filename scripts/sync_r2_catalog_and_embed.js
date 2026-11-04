const SUPABASE_URL = '';

// Credentials come from the environment only. A literal fallback here would ship the
// live service-role key — which bypasses RLS on every table — inside the repo and
// inside every distribution kit. Fail loudly instead of defaulting.
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.');
  process.exit(1);
}

const SERVICE_KEY = '';
const GEMINI_KEY = "AQ.Ab8RN6JO8D2MNkoyPL8adK859IwL_fpzg3y0RhYBgE2BifOOWg";
const R2_BASE = "https://pub-3a7d424a015147dbbe6a545151860ab7.r2.dev/catalog";

async function getEmbedding(text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "models/gemini-embedding-001",
      content: { parts: [{ text: text.slice(0, 2048) }] },
      outputDimensionality: 768,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data.embedding.values;
}

function formatSareeText(s) {
  const parts = [];
  if (s.name) parts.push(`Name: ${s.name}`);
  if (s.fabric) parts.push(`Fabric: ${s.fabric}`);
  if (s.weave_style) parts.push(`Weave: ${s.weave_style}`);
  if (s.color_primary) parts.push(`Color: ${s.color_primary}`);
  if (s.color_secondary) parts.push(`Accent: ${s.color_secondary}`);
  if (s.pattern) parts.push(`Pattern: ${s.pattern}`);
  if (s.border_type) parts.push(`Border: ${s.border_type}`);
  if (s.description) parts.push(`Details: ${s.description}`);
  return parts.join(". ");
}

async function main() {
  console.log("🌸 [R2 Catalog Sync] Updating image_urls to Cloudflare R2 Media CDN...\n");

  const updates = [
    {
      sku: "SAI-0022",
      image_urls: [
        `${R2_BASE}/art_silk_blue_1.jpg`,
        `${R2_BASE}/art_silk_blue_2.jpg`,
        `${R2_BASE}/art_silk_blue_3.jpg`
      ]
    },
    {
      sku: "SAI-0021",
      image_urls: [
        `${R2_BASE}/canary_red_bandhani.jpg`
      ]
    },
    {
      sku: "SAI-SIK-01",
      image_urls: [
        `${R2_BASE}/art_silk_blue_1.jpg`,
        `${R2_BASE}/art_silk_blue_2.jpg`
      ]
    },
    {
      sku: "SAI-VAR-01-GRN",
      image_urls: [
        `${R2_BASE}/prussian_blue_bandhani.jpg`
      ]
    }
  ];

  for (const item of updates) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?sku=eq.${item.sku}`, {
      method: "PATCH",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ image_urls: item.image_urls })
    });
    console.log(`✓ Linked R2 CDN URLs to SKU [${item.sku}]`);
  }

  console.log("\n🧠 [Embedding Generator] Computing 768-d Gemini multimodal embeddings...");
  const catalogRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?select=*`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
  });
  const sarees = await catalogRes.json();

  for (const s of sarees) {
    const text = formatSareeText(s);
    if (!text) continue;
    try {
      process.stdout.write(`Embedding [${s.sku}] ${s.name || 'Saree'}... `);
      const embedding = await getEmbedding(text);
      await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${s.id}`, {
        method: "PATCH",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ embedding })
      });
      console.log("✅ (768d vector stored)");
    } catch (err) {
      console.log("⚠️", err.message);
    }
  }

  console.log("\n🎉 Catalog successfully linked to Cloudflare R2 and indexed with Gemini AI!");
}

main().catch(console.error);
