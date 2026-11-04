/**
 * Uploads user's 3 saree images to Supabase Storage and inserts them into saree_catalog
 * with auto-generated Gemini vector embeddings and expert descriptions.
 *
 * Run: node scripts/add_user_sarees.js
 */

const fs = require('fs');
const path = require('path');

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

async function uploadToStorage(filePath, fileName) {
  const fileBuffer = fs.readFileSync(filePath);
  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/saree-catalog-images/${fileName}`;

  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "image/jpeg",
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

const newSarees = [
  {
    sku: "SAI-BAN-RED-07",
    name: "Canary Red Bandhani Zari Woven Silk Saree",
    fabric: "Pure Silk Bandhani",
    weave_style: "Banarasi Bandhej",
    color_primary: "Canary Red",
    color_secondary: "Antique Gold Zari",
    pattern: "Traditional Hand-knotted Bandhej Dots with Floral Vines",
    border_type: "Heavy Woven Gold Zari Brocade Border",
    pallu_design: "Intricate Floral and Foliage Zari Woven Rich Pallu",
    occasion: ["wedding", "bridal", "festive", "karwa chauth", "pooja"],
    price: 7850.00,
    mrp: 9999.00,
    stock_quantity: 6,
    description: "Stunning Canary Red pure silk Bandhani saree showcasing all-over authentic tie-and-dye bandhej artistry, harmoniously married with heavy Banarasi antique gold zari woven borders and an opulent zari pallu. Perfect for brides, festive pujas, and regal celebrations.",
    image_files: ["c:\\sai_traders\\assets\\catalog\\canary_red_bandhani.jpg"],
    attributes_json: {
      fabric: "Pure Silk Bandhani",
      weave_style: "Banarasi Bandhej",
      color_primary: "Canary Red",
      color_secondary: "Antique Gold Zari",
      border_type: "Heavy Woven Gold Zari Brocade Border",
      blouse_included: true,
      blouse_details: "Unstitched matching silk blouse piece with zari border"
    }
  },
  {
    sku: "SAI-GAJI-BLU-08",
    name: "Prussian Blue Bandhani Gaji Satin Mirror Work Silk Crepe Saree",
    fabric: "Gaji Satin Silk Crepe",
    weave_style: "Kutch Bandhani with Mirror Craft",
    color_primary: "Prussian Blue",
    color_secondary: "Silver White & Mirror Accents",
    pattern: "Large Radial Bandhej Chakras and Swirl Motifs",
    border_type: "Handcrafted Real Mirror Work Scalloped Lace Border",
    pallu_design: "Elaborate Circular Mandala Bandhani with Heavy Mirror Craft and Tassels",
    occasion: ["sangeet", "reception", "cocktail", "party", "festive"],
    price: 8450.00,
    mrp: 11200.00,
    stock_quantity: 5,
    description: "Mesmerizing Prussian Blue Gaji satin silk crepe saree with a luxurious glossy drape. Features intricate white tie-and-dye bandhani chakras and a statement handcrafted mirror work border with delicate tassels. Comes with a matching embellished sleeveless style blouse piece.",
    image_files: ["c:\\sai_traders\\assets\\catalog\\prussian_blue_bandhani.jpg"],
    attributes_json: {
      fabric: "Gaji Satin Silk Crepe",
      weave_style: "Kutch Bandhani with Mirror Craft",
      color_primary: "Prussian Blue",
      color_secondary: "Silver White & Mirror Accents",
      border_type: "Handcrafted Real Mirror Work Border with Tassels",
      blouse_included: true,
      blouse_details: "Embellished matching Gaji satin blouse piece"
    }
  },
  {
    sku: "SAI-ART-BLU-157",
    name: "Women Art Silk Dark Blue with Sky Blue Saree ASS157",
    fabric: "Fine Art Silk",
    weave_style: "Traditional Jacquard Weave",
    color_primary: "Dark Blue / Indigo",
    color_secondary: "Sky Blue & Silver Zari",
    pattern: "Subtle Leaf Butis & Vertical Stripe Textured Ground",
    border_type: "Contrast Sky Blue Broad Zari Border with Temple Motifs",
    pallu_design: "Solid Sky Blue Contrast Pallu with Dense Floral & Geometric Zari Weaving",
    occasion: ["office wear", "casual festive", "temple visit", "day function"],
    price: 1850.00,
    mrp: 2999.00,
    stock_quantity: 12,
    description: "Graceful and lightweight Dark Blue Art Silk saree contrasted with an enchanting Sky Blue border and pallu. Woven with delicate silver zari leaf butis on a textured jacquard base. Comfortable, elegant, and effortlessly easy to drape for daily or festive occasions.",
    image_files: [
      "c:\\sai_traders\\assets\\catalog\\art_silk_blue_1.jpg",
      "c:\\sai_traders\\assets\\catalog\\art_silk_blue_2.jpg",
      "c:\\sai_traders\\assets\\catalog\\art_silk_blue_3.jpg"
    ],
    attributes_json: {
      fabric: "Fine Art Silk",
      weave_style: "Traditional Jacquard Weave",
      color_primary: "Dark Blue",
      color_secondary: "Sky Blue",
      pattern: "Leaf Butis",
      border_type: "Contrast Sky Blue Zari Border",
      blouse_included: true,
      blouse_details: "Unstitched contrast sky blue blouse piece"
    }
  }
];

async function main() {
  console.log("==================================================");
  console.log("🌸 UPLOADING & ADDING USER SAREES TO CATALOG");
  console.log("==================================================\n");

  for (const saree of newSarees) {
    console.log(`Processing: ${saree.name}...`);

    // 1. Upload images
    const uploadedUrls = [];
    for (let i = 0; i < saree.image_files.length; i++) {
      const filePath = saree.image_files[i];
      const fileName = `${saree.sku.toLowerCase()}_${i + 1}.jpg`;
      const url = await uploadToStorage(filePath, fileName);
      uploadedUrls.push(url);
      console.log(`   Uploaded: ${url}`);
    }

    // 2. Generate embedding
    const embedText = `Name: ${saree.name}. Fabric: ${saree.fabric}. Weave: ${saree.weave_style}. Color: ${saree.color_primary} with ${saree.color_secondary}. Pattern: ${saree.pattern}. Border: ${saree.border_type}. Pallu: ${saree.pallu_design}. Occasions: ${saree.occasion.join(", ")}. Details: ${saree.description}`;
    const embedding = await getEmbedding(embedText);
    console.log(`   Generated 768-dim embedding (${embedding.length} dims)`);

    // 3. Insert or update in Supabase
    const payload = {
      sku: saree.sku,
      name: saree.name,
      fabric: saree.fabric,
      weave_style: saree.weave_style,
      color_primary: saree.color_primary,
      color_secondary: saree.color_secondary,
      pattern: saree.pattern,
      border_type: saree.border_type,
      pallu_design: saree.pallu_design,
      occasion: saree.occasion,
      price: saree.price,
      mrp: saree.mrp,
      stock_quantity: saree.stock_quantity,
      description: saree.description,
      image_urls: uploadedUrls,
      attributes_json: saree.attributes_json,
      embedding: embedding,
      is_active: true
    };

    const res = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates"
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      console.error(`   ❌ Failed to insert:`, await res.text());
    } else {
      console.log(`   ✅ Saree [${saree.sku}] inserted into catalog successfully!\n`);
    }
  }

  console.log("==================================================");
  console.log("🎉 ALL 3 SAREES ADDED WITH IMAGES & EMBEDDINGS!");
  console.log("==================================================");
}

main();
