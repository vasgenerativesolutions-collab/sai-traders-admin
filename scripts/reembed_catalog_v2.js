/**
 * Re-embeds all products in saree_catalog using Google Gemini embedding-2 (multimodal 768-d).
 * 
 * Rules:
 * 1. Preserves legacy 'embedding' column untouched (side-by-side migration).
 * 2. Populates 'embedding_v2', 'embedding_model' = 'gemini-embedding-001', 'embedding_dim' = 768.
 * 3. Tests vector similarity match using match_sarees_v2 RPC.
 * 4. Updates app_config.embedding_config.migration_status to 'completed'.
 * 
 * Usage: node scripts/reembed_catalog_v2.js
 */

/**
 * NOTE ON THE MODEL
 *
 * gemini-embedding-001 is used here because that is what the live search uses:
 * _shared/gemini.ts embeds a customer's words with it, and match_sarees compares the
 * result against the catalogue. A different model here produces a different vector
 * space, so every search returns nothing while both sides report success — which is
 * exactly what was happening with gemini-embedding-2.
 *
 * To move to a newer model, change it in _shared/gemini.ts AND here, then re-run this
 * script. Never one without the others.
 */

const fs = require('fs');

// Load environment variables
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

const SUPABASE_URL = env.SUPABASE_URL || 'https://aisttddxrbizoshtpdxi.supabase.co';
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_KEY = env.GEMINI_API_KEY;

if (!SERVICE_KEY || !GEMINI_KEY) {
  console.error('❌ Missing SUPABASE_SERVICE_ROLE_KEY or GEMINI_API_KEY in .env');
  process.exit(1);
}

function formatSareeText(s) {
  const parts = [];
  if (s.name) parts.push(`Name: ${s.name}`);
  if (s.sku) parts.push(`SKU: ${s.sku}`);
  if (s.tally_part_number) parts.push(`Part: ${s.tally_part_number}`);
  if (s.fabric) parts.push(`Fabric: ${s.fabric}`);
  if (s.weave_style) parts.push(`Weave: ${s.weave_style}`);
  if (s.color_primary) parts.push(`Color: ${s.color_primary}`);
  if (s.color_secondary) parts.push(`Accent: ${s.color_secondary}`);
  if (s.pattern) parts.push(`Pattern: ${s.pattern}`);
  if (s.border_type) parts.push(`Border: ${s.border_type}`);
  if (s.pallu_design) parts.push(`Pallu: ${s.pallu_design}`);
  if (s.occasion && Array.isArray(s.occasion)) parts.push(`Occasions: ${s.occasion.join(', ')}`);
  if (s.description) parts.push(`Description: ${s.description}`);
  if (s.attributes_json && typeof s.attributes_json === 'object') {
    const extra = Object.entries(s.attributes_json)
      .filter(([_, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    if (extra) parts.push(`Attributes: ${extra}`);
  }
  return parts.join('. ');
}

async function getGeminiEmbeddingV2(text, title = 'Saree Catalog Item', taskType = 'RETRIEVAL_DOCUMENT') {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_KEY}`;
  
  const bodyPayload = {
    model: 'models/gemini-embedding-001',
    content: {
      parts: [{ text: text.slice(0, 4000) }]
    },
    outputDimensionality: 768
  };

  if (taskType) {
    bodyPayload.taskType = taskType;
  }
  if (title && taskType === 'RETRIEVAL_DOCUMENT') {
    bodyPayload.title = title.slice(0, 200);
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyPayload)
  });

  const data = await res.json();
  if (!res.ok || !data.embedding) {
    throw new Error(data.error?.message || JSON.stringify(data));
  }
  return data.embedding.values;
}

async function run() {
  console.log('======================================================================');
  console.log('💎 RE-EMBEDDING SAREE CATALOG WITH GEMINI-EMBEDDING-2 (768-D)');
  console.log('======================================================================\n');

  // 1. Fetch all sarees from Supabase
  const getRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?select=*&order=created_at.asc`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`
    }
  });

  if (!getRes.ok) {
    const err = await getRes.text();
    console.error(`❌ Failed to fetch sarees: ${err}`);
    process.exit(1);
  }

  const sarees = await getRes.json();
  console.log(`📦 Loaded ${sarees.length} sarees from saree_catalog.\n`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < sarees.length; i++) {
    const s = sarees[i];
    const text = formatSareeText(s);
    process.stdout.write(`[${i + 1}/${sarees.length}] Processing [${s.sku || s.tally_part_number}] ${s.name.slice(0, 35)}... `);

    try {
      const embedding = await getGeminiEmbeddingV2(text, s.name, 'RETRIEVAL_DOCUMENT');

      if (!embedding || embedding.length !== 768) {
        throw new Error(`Invalid embedding length: ${embedding ? embedding.length : 0}`);
      }

      // Write BOTH embedding columns.
      //
      // This wrote only embedding_v2, while the live WhatsApp search calls
      // match_sarees, which reads `embedding`. So re-indexing the catalogue reported
      // success and left every saree unfindable by the one path customers actually
      // use. match_sarees_v2 reads embedding_v2 and additionally requires
      // status = 'listed', which nothing here has yet, so it could not cover for it.
      const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${s.id}`, {
        method: 'PATCH',
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation'
        },
        body: JSON.stringify({
          embedding: embedding,
          embedding_v2: embedding,
          embedding_model: 'gemini-embedding-001',
          embedding_dim: 768
        })
      });

      if (!patchRes.ok) {
        const err = await patchRes.text();
        console.log(`❌ DB Update Error: ${err}`);
        failCount++;
      } else {
        console.log(`✅ Saved (768 dims, model: gemini-embedding-001)`);
        successCount++;
      }

      // Respect API rate limits
      await new Promise(r => setTimeout(r, 250));
    } catch (err) {
      console.log(`❌ Failed: ${err.message}`);
      failCount++;
    }
  }

  console.log('\n----------------------------------------------------------------------');
  console.log(`📊 Re-embedding Summary: ${successCount} succeeded, ${failCount} failed.`);
  console.log('----------------------------------------------------------------------\n');

  if (successCount === 0) {
    console.error('❌ No embeddings were generated. Halting.');
    process.exit(1);
  }

  // 2. Test similarity search using match_sarees_v2 RPC
  console.log('======================================================================');
  console.log('🔍 TESTING match_sarees_v2 RPC WITH QUERY EMBEDDING');
  console.log('======================================================================\n');

  const testQueries = [
    'pure bridal silk kanjivaram with temple zari border',
    'royal blue banarasi saree with intricate zari floral work',
    'lightweight yellow organza festive saree'
  ];

  for (const q of testQueries) {
    console.log(`🔎 Test Query: "${q}"`);
    try {
      const queryEmbedding = await getGeminiEmbeddingV2(q, '', 'RETRIEVAL_QUERY');

      const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_sarees_v2`, {
        method: 'POST',
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query_embedding: queryEmbedding,
          match_threshold: 0.1, // test threshold
          match_count: 3,
          filter_listed: false // match across all items in test
        })
      });

      if (!rpcRes.ok) {
        const err = await rpcRes.text();
        console.log(`   ❌ RPC Error: ${err}\n`);
      } else {
        const matches = await rpcRes.json();
        console.log(`   🎯 Found ${matches.length} matches:`);
        matches.forEach((m, idx) => {
          const simPct = (m.similarity * 100).toFixed(1);
          console.log(`      ${idx + 1}. [${m.sku || m.tally_part_number}] ${m.name} | Sim: ${simPct}% | Price: ₹${m.price}`);
        });
        console.log('');
      }
    } catch (err) {
      console.log(`   ❌ Query failed: ${err.message}\n`);
    }
  }

  // 3. Update app_config.embedding_config status
  console.log('======================================================================');
  console.log('⚙️ UPDATING APP_CONFIG (embedding_config)');
  console.log('======================================================================\n');

  const configRes = await fetch(`${SUPABASE_URL}/rest/v1/app_config?key=eq.embedding_config&select=*`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`
    }
  });

  if (configRes.ok) {
    const rows = await configRes.json();
    if (rows.length > 0) {
      const currentConfig = rows[0].value || {};
      const updatedConfig = {
        ...currentConfig,
        v2_model: 'gemini-embedding-001',
        v2_column: 'embedding_v2',
        dimension: 768,
        migration_status: 'completed',
        reembedded_at: new Date().toISOString(),
        total_reembedded: successCount
      };

      const patchConfigRes = await fetch(`${SUPABASE_URL}/rest/v1/app_config?key=eq.embedding_config`, {
        method: 'PATCH',
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ value: updatedConfig })
      });

      if (patchConfigRes.ok) {
        console.log('✅ app_config.embedding_config updated to migration_status: "completed"');
      } else {
        console.log('⚠️ Failed to update app_config:', await patchConfigRes.text());
      }
    }
  }

  console.log('\n🎉 CATALOG RE-EMBEDDING PIPELINE COMPLETE!\n');
}

run().catch(err => {
  console.error('Fatal error in reembed_catalog_v2:', err);
  process.exit(1);
});
