import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { generateTextEmbedding, formatSareeForEmbedding } from "../_shared/gemini.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = getSupabaseAdmin();
  const url = new URL(req.url);
  const forceAll = url.searchParams.get("force") === "true";

  try {
    let query = supabase
      .from("saree_catalog")
      .select("id, sku, name, fabric, weave_style, color_primary, color_secondary, pattern, border_type, pallu_design, occasion, description");

    if (!forceAll) {
      query = query.is("embedding", null);
    }

    const { data: sarees, error } = await query;

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
    }

    if (!sarees || sarees.length === 0) {
      return new Response(
        JSON.stringify({ message: "No sarees found needing embedding updates." }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const results: Array<{ id: string; sku: string; status: string; error?: string }> = [];

    for (const saree of sarees) {
      try {
        const text = formatSareeForEmbedding(saree);
        const embedding = await generateTextEmbedding(text);

        const { error: updateError } = await supabase
          .from("saree_catalog")
          .update({
            embedding: embedding,
            updated_at: new Date().toISOString(),
          })
          .eq("id", saree.id);

        if (updateError) {
          results.push({ id: saree.id, sku: saree.sku, status: "error", error: updateError.message });
        } else {
          results.push({ id: saree.id, sku: saree.sku, status: "updated" });
        }

        // Small delay to respect Gemini rate limits
        await new Promise((r) => setTimeout(r, 200));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ id: saree.id, sku: saree.sku, status: "failed", error: msg });
      }
    }

    return new Response(
      JSON.stringify({
        total: sarees.length,
        processed: results.length,
        successCount: results.filter((r) => r.status === "updated").length,
        details: results,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: corsHeaders });
  }
});
