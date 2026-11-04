import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-shop-id, x-agent-version",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

/**
 * Computes SHA-256 hash of a string
 */
async function sha256(str: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Validates agent device authorization
 */
async function authenticateAgent(
  req: Request,
  supabase: ReturnType<typeof getSupabaseAdmin>,
  shopId: string
): Promise<{ authorized: boolean; deviceId?: string; error?: string }> {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    return { authorized: false, error: "Missing authorization token" };
  }

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (serviceKey && token === serviceKey) {
    return { authorized: true, deviceId: "service-role-admin" };
  }

  // Hash token and lookup active device
  const hashed = await sha256(token);
  const { data: device, error } = await supabase
    .from("agent_devices")
    .select("id, shop_id, status")
    .eq("credential_hash", hashed)
    .eq("shop_id", shopId)
    .eq("status", "active")
    .maybeSingle();

  if (error || !device) {
    return { authorized: false, error: "Invalid, revoked or mismatched device credentials" };
  }

  return { authorized: true, deviceId: device.id };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/agent-api|\/functions\/v1\/agent-api/, "");
  const supabase = getSupabaseAdmin();

  const shopId = req.headers.get("x-shop-id") ||
                 url.searchParams.get("shop_id") ||
                 "00000000-0000-0000-0000-000000000001";

  try {
    // --------------------------------------------------------------------------
    // 1. POST /enroll: One-time code exchange for device token
    // --------------------------------------------------------------------------
    if (req.method === "POST" && (path === "/enroll" || path === "/agent/enroll")) {
      const body = await req.json().catch(() => ({}));
      const code = String(body.enrollment_code || "").trim();
      const deviceName = String(body.device_name || "Shop PC").trim();

      if (!code) {
        return new Response(JSON.stringify({ error: "enrollment_code is required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Check code
      const { data: device, error } = await supabase
        .from("agent_devices")
        .select("id, shop_id")
        .eq("enrollment_code", code)
        .eq("status", "active")
        .gt("enrollment_expires_at", new Date().toISOString())
        .maybeSingle();

      if (error || !device) {
        return new Response(JSON.stringify({ error: "Invalid or expired enrollment code" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Generate permanent device token
      const rawToken = `sai_agent_${crypto.randomUUID().replace(/-/g, "")}_${Date.now()}`;
      const hashedToken = await sha256(rawToken);

      await supabase
        .from("agent_devices")
        .update({
          credential_hash: hashedToken,
          enrollment_code: null, // one-time use invalidated
          device_name: deviceName,
          last_seen_at: new Date().toISOString(),
        })
        .eq("id", device.id);

      return new Response(
        JSON.stringify({
          success: true,
          shop_id: device.shop_id,
          device_id: device.id,
          device_token: rawToken,
          message: "Device successfully enrolled. Store token in Windows Credential Manager.",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Authenticate all remaining agent endpoints
    const auth = await authenticateAgent(req, supabase, shopId);
    if (!auth.authorized) {
      return new Response(JSON.stringify({ error: auth.error }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --------------------------------------------------------------------------
    // 2. POST /heartbeat: 60-second telemetry beacon
    // --------------------------------------------------------------------------
    if (req.method === "POST" && (path === "/heartbeat" || path === "/agent/heartbeat")) {
      const body = await req.json().catch(() => ({}));

      if (auth.deviceId && auth.deviceId !== "service-role-admin") {
        await supabase
          .from("agent_devices")
          .update({
            last_seen_at: new Date().toISOString(),
            version: body.agent_version || "1.0.0",
            tally_reachable: Boolean(body.tally_reachable),
            company_loaded: body.company_loaded || null,
            godown_exists: Boolean(body.godown_exists),
          })
          .eq("id", auth.deviceId);
      }

      return new Response(
        JSON.stringify({ success: true, timestamp: new Date().toISOString() }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // --------------------------------------------------------------------------
    // 3. GET /jobs/next: Poll for next pending job for this shop
    // --------------------------------------------------------------------------
    if (req.method === "GET" && (path === "/jobs/next" || path === "/agent/jobs/next")) {
      const { data: job, error } = await supabase
        .from("agent_jobs")
        .select("*")
        .eq("shop_id", shopId)
        .eq("state", "pending")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (error || !job) {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // Atomically lock job to in_progress
      await supabase
        .from("agent_jobs")
        .update({
          state: "in_progress",
          device_id: auth.deviceId !== "service-role-admin" ? auth.deviceId : null,
          locked_at: new Date().toISOString(),
          attempts: (job.attempts || 0) + 1,
        })
        .eq("id", job.id);

      return new Response(JSON.stringify(job), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --------------------------------------------------------------------------
    // 4. POST /jobs/:id/result: Ingest job execution outcome from agent
    // --------------------------------------------------------------------------
    const jobResultMatch = path.match(/^\/?(?:agent\/)?jobs\/([^/]+)\/result$/);
    if (req.method === "POST" && jobResultMatch) {
      const jobId = jobResultMatch[1];
      const body = await req.json().catch(() => ({}));
      const success = Boolean(body.success);

      const { data: job } = await supabase
        .from("agent_jobs")
        .select("*")
        .eq("id", jobId)
        .single();

      if (!job) {
        return new Response(JSON.stringify({ error: "Job not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      await supabase
        .from("agent_jobs")
        .update({
          state: success ? "completed" : "failed",
          result: body.result || {},
          error: body.error || null,
          completed_at: new Date().toISOString(),
        })
        .eq("id", jobId);

      // If job was read_godown_balances, automatically trigger apply_sync_result reconciliation
      if (job.type === "read_godown_balances" && success && body.result?.items) {
        const runId = job.payload?.run_id;
        if (runId) {
          const { data: rpcRes, error: rpcErr } = await supabase.rpc("apply_sync_result", {
            p_shop_id: shopId,
            p_run_id: runId,
            p_tally_balances: body.result.items,
            p_actor: `agent:${auth.deviceId}`,
          });

          return new Response(
            JSON.stringify({ success: true, jobId, rpc_result: rpcRes, rpc_error: rpcErr }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }

      return new Response(JSON.stringify({ success: true, jobId }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --------------------------------------------------------------------------
    // 5. POST /stock-snapshot: Direct Online Godown snapshot ingestion
    // --------------------------------------------------------------------------
    if (req.method === "POST" && (path === "/stock-snapshot" || path === "/agent/stock-snapshot")) {
      const body = await req.json().catch(() => ({}));
      const { run_id, balances } = body;

      if (!run_id || !Array.isArray(balances)) {
        return new Response(JSON.stringify({ error: "run_id and balances array are required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data, error } = await supabase.rpc("apply_sync_result", {
        p_shop_id: shopId,
        p_run_id: run_id,
        p_tally_balances: balances,
        p_actor: `agent:${auth.deviceId}`,
      });

      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ success: true, result: data }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: `Not found: ${req.method} ${path}` }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: errorMsg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
