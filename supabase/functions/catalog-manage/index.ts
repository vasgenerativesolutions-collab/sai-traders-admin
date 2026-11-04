import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { generateTextEmbedding, formatSareeForEmbedding } from "../_shared/gemini.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = getSupabaseAdmin();
  const url = new URL(req.url);
  const sareeId = url.searchParams.get("id");

  try {
    // ------------------------------------------------------------------------
    // GET: List or Retrieve Saree
    // ------------------------------------------------------------------------
    if (req.method === "GET") {
      if (sareeId) {
        const { data, error } = await supabase
          .from("saree_catalog")
          .select("*")
          .eq("id", sareeId)
          .single();

        if (error) return new Response(JSON.stringify({ error: error.message }), { status: 404, headers: corsHeaders });
        return new Response(JSON.stringify(data), { status: 200, headers: corsHeaders });
      }

      const limit = parseInt(url.searchParams.get("limit") || "50", 10);
      const search = url.searchParams.get("search");

      let query = supabase
        .from("saree_catalog")
        .select("id, sku, name, fabric, weave_style, color_primary, price, mrp, stock_quantity, image_urls, is_active, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (search) {
        query = query.or(`name.ilike.%${search}%,fabric.ilike.%${search}%,sku.ilike.%${search}%`);
      }

      const { data, error } = await query;
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });

      return new Response(JSON.stringify({ sarees: data }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ------------------------------------------------------------------------
    // POST: Create New Saree (with auto-vector embedding generation)
    // ------------------------------------------------------------------------
    if (req.method === "POST") {
      const body = await req.json();

      if (!body.name || !body.sku || !body.price || !body.fabric || !body.color_primary) {
        return new Response(
          JSON.stringify({ error: "Required fields: sku, name, fabric, color_primary, price" }),
          { status: 400, headers: corsHeaders }
        );
      }

      // Generate embedding automatically using Gemini text-embedding-004
      const embeddingText = formatSareeForEmbedding({
        name: body.name,
        fabric: body.fabric,
        weave_style: body.weave_style,
        color_primary: body.color_primary,
        color_secondary: body.color_secondary,
        pattern: body.pattern,
        border_type: body.border_type,
        pallu_design: body.pallu_design,
        occasion: body.occasion,
        description: body.description,
      });

      let embedding: number[] | null = null;
      try {
        embedding = await generateTextEmbedding(embeddingText);
      } catch (embErr) {
        console.warn("Could not generate embedding right away, will save without embedding:", embErr);
      }

      const insertPayload = {
        sku: body.sku,
        name: body.name,
        fabric: body.fabric,
        weave_style: body.weave_style || null,
        color_primary: body.color_primary,
        color_secondary: body.color_secondary || null,
        pattern: body.pattern || null,
        border_type: body.border_type || null,
        pallu_design: body.pallu_design || null,
        occasion: body.occasion || [],
        price: body.price,
        mrp: body.mrp || null,
        stock_quantity: body.stock_quantity ?? 1,
        description: body.description || null,
        image_urls: body.image_urls || [],
        attributes_json: body.attributes_json || {},
        embedding: embedding,
        is_active: body.is_active ?? true,
      };

      const { data, error } = await supabase
        .from("saree_catalog")
        .insert(insertPayload)
        .select()
        .single();

      if (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: corsHeaders });
      }

      return new Response(JSON.stringify({ success: true, saree: data }), {
        status: 201,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ------------------------------------------------------------------------
    // PUT: Update Saree
    // ------------------------------------------------------------------------
    if (req.method === "PUT") {
      if (!sareeId) {
        return new Response(JSON.stringify({ error: "Missing ?id= parameter" }), { status: 400, headers: corsHeaders });
      }

      const body = await req.json();

      // Regenerate embedding if core attributes changed
      let embedding: number[] | undefined = undefined;
      if (body.name || body.fabric || body.weave_style || body.color_primary || body.pattern) {
        try {
          const embeddingText = formatSareeForEmbedding({
            name: body.name,
            fabric: body.fabric,
            weave_style: body.weave_style,
            color_primary: body.color_primary,
            color_secondary: body.color_secondary,
            pattern: body.pattern,
            border_type: body.border_type,
            pallu_design: body.pallu_design,
            occasion: body.occasion,
            description: body.description,
          });
          embedding = await generateTextEmbedding(embeddingText);
        } catch (e) {
          console.warn("Failed to refresh embedding:", e);
        }
      }

      const updateData: Record<string, unknown> = {
        ...body,
        updated_at: new Date().toISOString(),
      };
      if (embedding) {
        updateData.embedding = embedding;
      }

      const { data, error } = await supabase
        .from("saree_catalog")
        .update(updateData)
        .eq("id", sareeId)
        .select()
        .single();

      if (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: corsHeaders });
      }

      return new Response(JSON.stringify({ success: true, saree: data }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ------------------------------------------------------------------------
    // DELETE: Remove Saree
    // ------------------------------------------------------------------------
    if (req.method === "DELETE") {
      if (!sareeId) {
        return new Response(JSON.stringify({ error: "Missing ?id= parameter" }), { status: 400, headers: corsHeaders });
      }

      const { error } = await supabase.from("saree_catalog").delete().eq("id", sareeId);
      if (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: corsHeaders });
      }

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
