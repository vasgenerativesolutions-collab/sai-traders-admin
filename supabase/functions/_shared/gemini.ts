/**
 * Google Gemini Multimodal AI and Embeddings Helper
 */

export interface SareeExtractedAttributes {
  product_code?: string | null;
  product_code_confidence?: "high" | "medium" | "low" | "none";
  fabric: string;
  weave_style: string;
  color_primary: string;
  color_secondary: string;
  pattern: string;
  border_type: string;
  pallu_design: string;
  occasion: string[];
  estimated_price_range: string;
  summary: string;
}

export interface CustomerIntentResult {
  intent:
    | "search_catalog"
    | "select_product"
    | "confirm_order"
    | "provide_address"
    | "track_order"
    | "greeting"
    | "general_query";
  confidence: number;
  entities: {
    selected_index?: number;
    sku?: string;
    search_keywords?: string;
    order_number?: string;
    address?: Record<string, unknown>;
  };
  suggested_reply?: string;
}

function getGeminiApiKey(): string {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) {
    throw new Error("Missing GEMINI_API_KEY environment variable.");
  }
  return key;
}

/**
 * Analyze saree image using Gemini with automatic fallback
 */
export async function analyzeSareeImage(
  base64Image: string,
  mimeType = "image/jpeg"
): Promise<SareeExtractedAttributes> {
  const apiKey = getGeminiApiKey();
  const candidateModels = [
    Deno.env.get("GEMINI_MODEL") || "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.8-flash",
    "gemini-flash-latest",
  ];

  const prompt = `You are a master saree appraiser, textile expert, and Indian ethnic fashion stylist for Sai Traders.
Analyze this saree image in meticulous detail. Extract its key physical, artisanal, and stylistic attributes.
CRITICAL INSTRUCTION: Inspect the entire image with extreme precision for any watermarked text, overlaid product codes, SKU stamps, or alphanumeric identifiers (e.g. 'SR-1042-R', 'SR-1042', 'SAI-...', or similar codes watermarked on fabric or video frames).

Return ONLY a valid JSON object matching this schema:
{
  "product_code": "The exact product code/SKU string visible in the image (e.g. 'SR-1042-R'), or null if no code is visible",
  "product_code_confidence": "high | medium | low | none",
  "fabric": "Specific fabric type (e.g., Pure Mulberry Silk, Katan Silk, Georgette, Chiffon, Organza, Chanderi Silk Cotton, Tussar Silk, Linen, Crepe)",
  "weave_style": "Weave or regional craft style (e.g., Kanjivaram, Banarasi, Bandhani, Patola, Chanderi, Paithani, Pochampally Ikat, Chikankari, Modern Designer)",
  "color_primary": "Main dominant color (e.g., Crimson Red, Royal Blue, Mustard Yellow, Emerald Green, Blush Pink)",
  "color_secondary": "Secondary or accent color (e.g., Antique Gold, Silver Zari, Contrast Red, Coral)",
  "pattern": "Surface pattern or motifs (e.g., Traditional Peacock & Floral Buta, Floral Jaal with Meenakari, Hand-tied Bandhej Dots, Geometric Shikargah)",
  "border_type": "Border style & craft (e.g., Broad Zari Temple Border, Contrast Gota Patti, Scalloped Cutwork with Pearl Embroidery, Sleek Silver Zari)",
  "pallu_design": "Description of pallu (e.g., Heavy Gold Zari with Mayil motifs, Shikargah zari pallu, Delicate Striped Zari)",
  "occasion": ["Array of suitable occasions, e.g. wedding, bridal, festive, reception, party, casual, office"],
  "estimated_price_range": "Realistic retail market estimate in INR (e.g. ₹5,000 - ₹9,000)",
  "summary": "A 2 to 3 sentence elegant description of this saree highlight its texture, craft, and appeal."
}`;

  let lastError: Error | null = null;

  for (const model of candidateModels) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  inline_data: {
                    mime_type: mimeType,
                    data: base64Image,
                  },
                },
                {
                  text: prompt,
                },
              ],
            },
          ],
          generationConfig: {
            response_mime_type: "application/json",
            temperature: 0.2,
          },
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.warn(`Gemini model ${model} failed (${response.status}): ${errorBody}`);
        lastError = new Error(`Gemini Image Analysis failed with ${model} (${response.status})`);
        continue; // try next candidate model
      }

      const result = await response.json();
      const textResponse = result?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!textResponse) {
        lastError = new Error(`Empty response from ${model}`);
        continue;
      }

      const parsed = JSON.parse(textResponse) as SareeExtractedAttributes;
      return parsed;
    } catch (err) {
      console.warn(`Attempt with ${model} failed:`, err);
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError || new Error("All Gemini vision models failed to analyze image.");
}

export interface CatalogMatchResult {
  matched_product_code: string;
  confidence_percentage: number;
  detected_color: string;
  detected_weave: string;
  visual_reasoning: string;
}

/**
 * Match customer screenshot directly against stored saree catalog and video descriptions
 */
export async function identifySareeFromCatalog(
  base64Image: string,
  catalogSummary: string,
  mimeType = "image/jpeg"
): Promise<CatalogMatchResult> {
  const apiKey = getGeminiApiKey();
  const candidateModels = [
    Deno.env.get("GEMINI_MODEL") || "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-flash-latest",
  ];

  const prompt = `You are the master saree textile expert and appraisal AI for Sai Traders.
Analyze this customer photo / video screenshot.
Match it against our STORED SAREE CATALOG below:

${catalogSummary}

Determine WHICH saree in our stored catalog is shown in the image.
Return JSON ONLY matching this schema:
{
  "matched_product_code": "STRING (must match one of our Product Codes/SKUs above)",
  "confidence_percentage": NUMBER (0-100),
  "detected_color": "STRING",
  "detected_weave": "STRING",
  "visual_reasoning": "STRING"
}`;

  let lastError: Error | null = null;

  for (const model of candidateModels) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  inline_data: {
                    mime_type: mimeType,
                    data: base64Image,
                  },
                },
                {
                  text: prompt,
                },
              ],
            },
          ],
          generationConfig: {
            response_mime_type: "application/json",
            temperature: 0.1,
          },
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.warn(`Gemini catalog match ${model} failed (${response.status}): ${errorBody}`);
        lastError = new Error(`Gemini Catalog Match failed with ${model} (${response.status})`);
        continue;
      }

      const result = await response.json();
      const textResponse = result?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!textResponse) {
        lastError = new Error(`Empty response from ${model}`);
        continue;
      }

      const parsed = JSON.parse(textResponse) as CatalogMatchResult;
      return parsed;
    } catch (err) {
      console.warn(`Catalog match attempt with ${model} failed:`, err);
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError || new Error("All Gemini vision models failed to identify saree from catalog.");
}

/**
 * Generate 768-dimensional text embedding using Gemini gemini-embedding-001
 */
export async function generateTextEmbedding(text: string): Promise<number[]> {
  const apiKey = getGeminiApiKey();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "models/gemini-embedding-001",
      content: {
        parts: [{ text: text.trim().slice(0, 2048) }],
      },
      outputDimensionality: 768,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("Gemini embedding error:", errorBody);
    throw new Error(`Gemini embedding failed (${response.status}): ${errorBody}`);
  }

  const result = await response.json();
  const values = result?.embedding?.values;

  if (!values || !Array.isArray(values)) {
    throw new Error("No embedding values returned by Gemini embedding model.");
  }

  return values;
}

/**
 * Create a descriptive string representation of saree attributes for embedding
 */
export function formatSareeForEmbedding(attributes: {
  fabric?: string | null;
  weave_style?: string | null;
  color_primary?: string | null;
  color_secondary?: string | null;
  pattern?: string | null;
  border_type?: string | null;
  pallu_design?: string | null;
  occasion?: string[] | null;
  description?: string | null;
  name?: string | null;
}): string {
  const parts: string[] = [];

  if (attributes.name) parts.push(`Name: ${attributes.name}`);
  if (attributes.fabric) parts.push(`Fabric: ${attributes.fabric}`);
  if (attributes.weave_style) parts.push(`Weave Style: ${attributes.weave_style}`);
  if (attributes.color_primary) parts.push(`Primary Color: ${attributes.color_primary}`);
  if (attributes.color_secondary) parts.push(`Accent Color: ${attributes.color_secondary}`);
  if (attributes.pattern) parts.push(`Pattern: ${attributes.pattern}`);
  if (attributes.border_type) parts.push(`Border: ${attributes.border_type}`);
  if (attributes.pallu_design) parts.push(`Pallu: ${attributes.pallu_design}`);
  if (attributes.occasion && attributes.occasion.length > 0) {
    parts.push(`Occasions: ${attributes.occasion.join(", ")}`);
  }
  if (attributes.description) parts.push(`Details: ${attributes.description}`);

  return parts.join(". ");
}

/**
 * Understand customer conversational intent and message semantics
 */
export async function parseCustomerIntent(
  userText: string,
  conversationContext: Record<string, unknown> = {}
): Promise<CustomerIntentResult> {
  const apiKey = getGeminiApiKey();
  const model = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";

  const systemPrompt = `You are a conversational routing agent for Sai Traders, a boutique saree store.
Given the customer message and conversation context, determine their intent and extract any entities.

Allowed intents:
- "search_catalog": Asking to browse, search for a saree type, color, fabric, price range (e.g. "show me silk sarees", "do you have yellow bandhani?", "sarees under 5000")
- "select_product": Selecting one of the sarees shown previously (e.g. "1", "first one", "I like #2", "show me the blue one")
- "confirm_order": Ready to purchase or place order (e.g. "I want to buy", "yes confirm", "order this", "proceed to buy")
- "provide_address": Giving their shipping address (e.g. "Deliver to Flat 402, Banjara Hills, Hyderabad 500034")
- "track_order": Inquiring about order status or delivery (e.g. "where is my order", "track SAI-1001", "delivery status")
- "greeting": Hi, hello, namaste, good morning
- "general_query": Store timings, return policy, offline shop location, general question

Context:
${JSON.stringify(conversationContext)}

Customer Message: "${userText}"

Return ONLY valid JSON matching this schema:
{
  "intent": "search_catalog" | "select_product" | "confirm_order" | "provide_address" | "track_order" | "greeting" | "general_query",
  "confidence": 0.0 to 1.0,
  "entities": {
    "selected_index": number (1-based index if selecting a product),
    "sku": string (if specific SKU or product mentioned),
    "search_keywords": string (clean search terms if search_catalog),
    "order_number": string (e.g. "SAI-1001" if tracking),
    "address": object (if provide_address, parse name, street, city, state, pincode)
  },
  "suggested_reply": string (polite, concise WhatsApp reply in English)
}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: systemPrompt }] }],
        generationConfig: {
          response_mime_type: "application/json",
          temperature: 0.1,
        },
      }),
    });

    if (!response.ok) {
      // Fallback simple rule-based matcher
      return fallbackIntentMatcher(userText);
    }

    const result = await response.json();
    const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return fallbackIntentMatcher(userText);

    return JSON.parse(text) as CustomerIntentResult;
  } catch (err) {
    console.warn("Intent parser error, falling back to heuristic:", err);
    return fallbackIntentMatcher(userText);
  }
}

function fallbackIntentMatcher(text: string): CustomerIntentResult {
  const lower = text.trim().toLowerCase();

  // Match greetings
  if (/^(hi|hello|hey|namaste|vanakkam|good\s*(morning|afternoon|evening))/i.test(lower)) {
    return {
      intent: "greeting",
      confidence: 0.9,
      entities: {},
      suggested_reply: "Welcome to Sai Traders! 🌸 How may I help you today? You can send a picture of any saree you like, or ask me for silk, banarasi, bandhani, or organza sarees!",
    };
  }

  // Match selection (1, 2, 3, first, second)
  const numMatch = lower.match(/^(?:option\s*|saree\s*|#\s*)?([1-5])$/i);
  if (numMatch) {
    return {
      intent: "select_product",
      confidence: 0.85,
      entities: { selected_index: parseInt(numMatch[1], 10) },
    };
  }

  // Match order confirmation
  if (/^(yes|confirm|buy|buy now|proceed|order)/i.test(lower)) {
    return {
      intent: "confirm_order",
      confidence: 0.85,
      entities: {},
    };
  }

  // Match order tracking
  const trackMatch = lower.match(/sai-\d+/i);
  if (trackMatch || lower.includes("track") || lower.includes("status")) {
    return {
      intent: "track_order",
      confidence: 0.8,
      entities: { order_number: trackMatch ? trackMatch[0].toUpperCase() : undefined },
    };
  }

  return {
    intent: "search_catalog",
    confidence: 0.6,
    entities: { search_keywords: text },
  };
}
