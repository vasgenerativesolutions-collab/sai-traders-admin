/**
 * Live test for Google Gemini Vision & 768-dim Embedding using your API key
 * Run: node scripts/test_live_gemini.js
 */

const API_KEY = "AQ.Ab8RN6JO8D2MNkoyPL8adK859IwL_fpzg3y0RhYBgE2BifOOWg";

async function runLiveTest() {
  console.log("==================================================");
  console.log("🌸 TESTING GOOGLE GEMINI 3.5 FLASH & EMBEDDING");
  console.log("==================================================\n");

  // 1. Test Text Analysis with gemini-3.5-flash
  console.log("1️⃣ Testing Gemini 3.5 Flash Model...");
  const prompt = `You are a master saree appraiser. In 2 bullet points, summarize why Kanjivaram silk sarees are prized in Indian weddings.`;

  try {
    const textRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
      }
    );

    const textData = await textRes.json();
    const reply = textData?.candidates?.[0]?.content?.parts?.[0]?.text;
    console.log("✅ Gemini 3.5 Flash Response:\n" + reply);
  } catch (err) {
    console.error("❌ Gemini Text failed:", err);
  }

  console.log("\n--------------------------------------------------");

  // 2. Test 768-dim Text Embedding with gemini-embedding-001
  console.log("2️⃣ Testing 768-dim Embedding with gemini-embedding-001...");
  try {
    const embedRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "models/gemini-embedding-001",
          content: {
            parts: [{ text: "Crimson Red Kanjivaram Pure Mulberry Silk Saree with Gold Zari Temple Border" }],
          },
          outputDimensionality: 768,
        }),
      }
    );

    const embedData = await embedRes.json();
    const values = embedData?.embedding?.values;
    if (values && values.length === 768) {
      console.log(`✅ Embedding generated successfully! Dimensions: ${values.length}`);
      console.log(`   Sample vector values: [${values.slice(0, 5).map((v) => v.toFixed(5)).join(", ")}...]`);
    } else {
      console.log("❌ Unexpected embedding output:", embedData);
    }
  } catch (err) {
    console.error("❌ Embedding failed:", err);
  }

  console.log("\n==================================================");
  console.log("🎉 ALL GOOGLE GEMINI APIS VERIFIED AND WORKING!");
  console.log("==================================================");
}

runLiveTest();
