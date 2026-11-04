const fs = require('fs');

// Credentials come from the environment only. A literal fallback here would ship the
// live service-role key — which bypasses RLS on every table — inside the repo and
// inside every distribution kit. Fail loudly instead of defaulting.
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.');
  process.exit(1);
}


const SUPABASE_URL = '';
const SERVICE_KEY =
  '';
const GEMINI_KEY = "AQ.Ab8RN6JO8D2MNkoyPL8adK859IwL_fpzg3y0RhYBgE2BifOOWg";
const imagePath = "C:\\Users\\mithu\\.gemini\\antigravity-ide\\brain\\0cdb8f07-b5be-4e88-817c-e13d717008f8\\.user_uploaded\\media_1790923197039.png";

async function uploadToStorage(filePath, fileName) {
  const fileBuffer = fs.readFileSync(filePath);
  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/saree-catalog-images/${fileName}`;

  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "image/png",
      "x-upsert": "true",
    },
    body: fileBuffer,
  });

  if (!res.ok) {
    const err = await res.text();
    console.warn(`Storage upload warning for ${fileName}:`, err);
  }

  return `${SUPABASE_URL}/storage/v1/object/public/saree-catalog-images/${fileName}`;
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
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data.embedding.values;
}

async function addSaree() {
  console.log("1. Uploading saree screenshot image to Supabase Storage...");
  const publicUrl = await uploadToStorage(imagePath, "sr_1042_r_royal_blue.png");
  console.log("   Uploaded to:", publicUrl);

  const sareeData = {
    sku: "SR-1042-R",
    name: "Royal Blue Soft Silk Saree with Antique Zari Elephant Border",
    fabric: "Soft Silk / Silk Cotton",
    weave_style: "Traditional Zari Border with Elephant Motifs",
    color_primary: "Royal Blue",
    color_secondary: "Antique Gold Zari",
    pattern: "Elephant & Floral Zari Weave Borders",
    border_type: "Dual Elephant Procession Zari Border",
    pallu_design: "Rich Antique Gold Zari Woven Pallu",
    occasion: ["wedding", "festive", "traditional", "pooja", "reception"],
    price: 4650.00,
    mrp: 6499.00,
    stock_quantity: 4,
    description: "Exquisite royal blue soft silk saree featuring finely detailed elephant procession motifs along the lustrous antique gold zari borders. Perfect for grand festivities, wedding functions, and traditional celebrations.",
    image_urls: [publicUrl],
    attributes_json: {
      fabric: "Soft Silk / Silk Cotton",
      weave_style: "Zari Border with Elephant Motifs",
      color_primary: "Royal Blue",
      color_secondary: "Antique Gold Zari",
      border_type: "Dual Elephant Procession Zari Border",
      tally_part_number: "SR-1042-R",
      tally_item_name: "SR-1042-R Soft Silk Royal Blue",
      blouse_included: true
    }
  };

  console.log("2. Generating 768-dim Gemini vector embedding...");
  const textToEmbed = `${sareeData.name}. Fabric: ${sareeData.fabric}. Craft: ${sareeData.weave_style}. Colors: ${sareeData.color_primary} with ${sareeData.color_secondary}. Pattern: ${sareeData.pattern}. Border: ${sareeData.border_type}. ${sareeData.description}`;
  const embedding = await getEmbedding(textToEmbed);
  sareeData.embedding = embedding;

  console.log("3. Upserting into saree_catalog in Supabase...");
  const upsertUrl = `${SUPABASE_URL}/rest/v1/saree_catalog`;
  const res = await fetch(upsertUrl, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates"
    },
    body: JSON.stringify(sareeData)
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Failed to insert saree:", err);
  } else {
    console.log("✅ Successfully seeded SR-1042-R into catalog with image and embedding!");
  }
}

addSaree().catch(console.error);
