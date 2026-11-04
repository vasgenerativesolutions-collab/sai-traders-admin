const fs = require('fs');

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

async function testEmbedding(modelName) {
  console.log(`\nTesting model: ${modelName}...`);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:embedContent?key=${env.GEMINI_API_KEY}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${modelName}`,
        content: { parts: [{ text: "Crimson Kanjivaram Bridal Silk Saree with Gold Zari" }] },
        outputDimensionality: 768
      })
    });
    const data = await res.json();
    if (res.ok && data.embedding) {
      console.log(`✅ Success for ${modelName}! Vector dimension: ${data.embedding.values.length}`);
      return true;
    } else {
      console.log(`❌ Failed for ${modelName}:`, data.error?.message || data);
      return false;
    }
  } catch (err) {
    console.log(`❌ Exception for ${modelName}:`, err.message);
    return false;
  }
}

async function run() {
  await testEmbedding("gemini-embedding-2");
  await testEmbedding("text-embedding-004");
  await testEmbedding("gemini-embedding-001");
}

run();
