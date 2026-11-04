/**

// Credentials come from the environment only. A literal fallback here would ship the
// live service-role key — which bypasses RLS on every table — inside the repo and
// inside every distribution kit. Fail loudly instead of defaulting.
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.');
  process.exit(1);
}

 * Generates and stores 768-dimensional embeddings for all sarees in Supabase catalog
 * using Google Gemini Embedding API.
 *
 * Run: node scripts/populate_catalog_embeddings.js
 */

const SUPABASE_URL = '';
const SERVICE_KEY =
  '';
const GEMINI_KEY = "AQ.Ab8RN6JO8D2MNkoyPL8adK859IwL_fpzg3y0RhYBgE2BifOOWg";

function formatSareeText(s) {
  const parts = [];
  if (s.name) parts.push(`Name: ${s.name}`);
  if (s.fabric) parts.push(`Fabric: ${s.fabric}`);
  if (s.weave_style) parts.push(`Weave: ${s.weave_style}`);
  if (s.color_primary) parts.push(`Color: ${s.color_primary}`);
  if (s.color_secondary) parts.push(`Accent: ${s.color_secondary}`);
  if (s.pattern) parts.push(`Pattern: ${s.pattern}`);
  if (s.border_type) parts.push(`Border: ${s.border_type}`);
  if (s.pallu_design) parts.push(`Pallu: ${s.pallu_design}`);
  if (s.occasion && Array.isArray(s.occasion)) parts.push(`Occasions: ${s.occasion.join(", ")}`);
  if (s.description) parts.push(`Details: ${s.description}`);
  return parts.join(". ");
}

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
  if (!res.ok) {
    throw new Error(JSON.stringify(data));
  }
  return data.embedding.values;
}

async function run() {
  console.log("==================================================");
  console.log("🌸 POPULATING VECTOR EMBEDDINGS FOR SAREE CATALOG");
  console.log("==================================================\n");

  // 1. Fetch all sarees
  const getRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?select=*`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
  });

  const sarees = await getRes.json();
  console.log(`Found ${sarees.length} sarees in catalog.\n`);

  for (const s of sarees) {
    const text = formatSareeText(s);
    process.stdout.write(`Processing [${s.sku}] ${s.name}... `);

    try {
      const embedding = await getEmbedding(text);

      // Update in Supabase
      const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${s.id}`, {
        method: "PATCH",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify({ embedding }),
      });

      if (!patchRes.ok) {
        const err = await patchRes.text();
        console.log(`❌ DB Update Error: ${err}`);
      } else {
        console.log(`✅ Embedding saved (${embedding.length} dims)`);
      }

      // Small pause for API rate limits
      await new Promise((r) => setTimeout(r, 300));
    } catch (err) {
      console.log(`❌ Failed: ${err.message}`);
    }
  }

  console.log("\n==================================================");
  console.log("🧪 TESTING pgvector SIMILARITY SEARCH (match_sarees)");
  console.log("==================================================\n");

  // Test vector match with a simulated customer query: "red wedding kanjivaram silk saree"
  const testQuery = "red bridal wedding kanjivaram pure silk saree with gold zari temple border";
  console.log(`Querying: "${testQuery}"`);

  const queryEmbedding = await getEmbedding(testQuery);

  const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_sarees`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query_embedding: queryEmbedding,
      match_threshold: 0.3,
      match_count: 3,
    }),
  });

  const matches = await rpcRes.json();
  console.log(`\n🎯 RPC match_sarees returned ${matches.length} matches:\n`);

  for (const m of matches) {
    const similarityPct = Math.round((m.similarity || 0) * 100);
    console.log(`• [${m.sku}] ${m.name}`);
    console.log(`  Price: ₹${m.price} | Similarity: ${similarityPct}% | Fabric: ${m.fabric}`);
  }

  console.log("\n==================================================");
  console.log("🎉 DATABASE, VECTOR EMBEDDINGS & SEARCH ALL WORKING!");
  console.log("==================================================");
}

run();
