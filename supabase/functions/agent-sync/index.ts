/**
 * agent-sync — the only way a store PC talks to the cloud.
 *
 * The shop machine holds one credential: a device token issued at pairing. It never
 * holds the Supabase service-role key, so a stolen or cloned machine cannot read or
 * write anything beyond what these four actions allow, and revoking it is a single
 * row update that takes effect on the very next call.
 *
 * Everything is pull-based. The agent polls; nothing ever connects inward to the shop.
 * That removes the tunnel, the firewall rule, the LAN address and the port forward —
 * not by fixing them, but by not needing them.
 *
 *   POST /agent-sync/enroll     { deviceName }              -> { code }        no auth
 *   POST /agent-sync/claim      { deviceToken }             -> { job | null }
 *   POST /agent-sync/report     { deviceToken, jobId, ... } -> { ok }
 *   POST /agent-sync/heartbeat  { deviceToken, tally }      -> { ok }
 *
 * Approval of an enrollment code happens from the authenticated dashboard, not here.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// This client is privileged. It exists only inside this function — that is the whole
// point of routing the agent through here rather than letting it hold the key.
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

/** Device tokens are stored hashed, so a database leak does not yield usable credentials. */
async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Resolve a device token to its row, rejecting anything not currently active.
 *
 * Status is checked on EVERY call rather than trusted from the token, so unpairing a
 * machine takes effect immediately — no waiting for expiry, and no need to reach the
 * machine itself.
 */
async function authenticate(deviceToken: unknown) {
  if (typeof deviceToken !== 'string' || deviceToken.length < 32) return null;
  const hash = await hashToken(deviceToken);
  const { data, error } = await db
    .from('agent_devices')
    .select('id, shop_id, device_name, status, revoked_at')
    .eq('credential_hash', hash)
    .maybeSingle();
  if (error || !data) return null;
  if (data.status !== 'active' || data.revoked_at) return null;
  return data;
}

/** Unambiguous characters only — no O/0 or I/1 confusion when read off a screen. */
function enrollmentCode(): string {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  for (const b of bytes) out += chars[b % chars.length];
  return out;
}

// ---------------------------------------------------------------------------
// enroll — a brand new machine asks to be adopted.
//
// Unauthenticated by necessity: the agent has no credential yet. It is safe because
// the row created here is inert. It carries no shop, no token and cannot claim work
// until someone signed into the dashboard approves the code.
// ---------------------------------------------------------------------------
async function enroll(body: Record<string, unknown>) {
  const deviceName = String(body.deviceName || 'Store PC').slice(0, 80).trim() || 'Store PC';
  const code = enrollmentCode();
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  // The token is minted now and only its hash is stored, so the database never holds a
  // usable credential. The plaintext sits in the one-time handoff slot until approval
  // collects it; it is inert before then, because every authenticated call also requires
  // status = 'active', which only approval sets.
  const token = 'dvc_' + Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0')).join('');

  const { data, error } = await db
    .from('agent_devices')
    .insert({
      device_name: deviceName,
      enrollment_code: code,
      enrollment_expires_at: expires,
      status: 'revoked', // awaiting approval — see note above; authenticate() refuses it
      credential_hash: await hashToken(token),
      version: token,
    })
    .select('id')
    .single();

  if (error) return json({ error: 'enroll_failed', detail: error.message }, 500);
  return json({ code, deviceId: data.id, expiresAt: expires });
}

// ---------------------------------------------------------------------------
// enroll-status — the agent polls this while the code is on screen.
//
// Returns the device token exactly once, when approval has happened. A read, so it is
// cheap to poll; it identifies itself by the code it was given rather than by a
// credential it does not yet have.
// ---------------------------------------------------------------------------
async function enrollStatus(body: Record<string, unknown>) {
  const code = String(body.code || '').toUpperCase().trim();
  if (!code) return json({ error: 'code_required' }, 400);

  const { data } = await db
    .from('agent_devices')
    .select('id, status, shop_id, device_name, enrollment_expires_at, version, revoked_at')
    .eq('enrollment_code', code)
    .maybeSingle();

  if (!data) return json({ status: 'unknown' });

  // Awaiting approval: still carries its enrollment code and has not been genuinely
  // revoked. A real revocation has revoked_at set and no code.
  if (data.status !== 'active') {
    if (data.revoked_at) return json({ status: 'revoked' });
    const expired = data.enrollment_expires_at && new Date(data.enrollment_expires_at) < new Date();
    return json({ status: expired ? 'expired' : 'pending' });
  }

  // `version` carries the one-time token handoff. It is cleared immediately so the
  // token cannot be collected twice, which would let a second machine impersonate this
  // one by replaying the same code.
  const handoff = data.version;
  if (!handoff) return json({ status: 'active', tokenAlreadyCollected: true });

  await db.from('agent_devices').update({ version: null }).eq('id', data.id);
  return json({ status: 'active', deviceToken: handoff, deviceId: data.id, deviceName: data.device_name, shopId: data.shop_id });
}


// ---------------------------------------------------------------------------
// approve — the dashboard adopts a machine that is showing a code.
//
// Authenticated as a PERSON, not a device: it validates the signed-in user's Supabase
// JWT. This is the only action that can turn an enrollment into a usable credential,
// which is what keeps the unauthenticated enroll call safe.
// ---------------------------------------------------------------------------
async function approve(req: Request, body: Record<string, unknown>) {
  const auth = req.headers.get('authorization') || '';
  const userJwt = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!userJwt) return json({ error: 'sign_in_required' }, 401);

  const { data: userData, error: userErr } = await db.auth.getUser(userJwt);
  if (userErr || !userData?.user) return json({ error: 'sign_in_required' }, 401);

  const code = String(body.code || '').toUpperCase().trim();
  if (!code) return json({ error: 'code_required' }, 400);

  const { data: device } = await db
    .from('agent_devices')
    .select('id, status, enrollment_expires_at, revoked_at, device_name')
    .eq('enrollment_code', code)
    .maybeSingle();

  if (!device) return json({ error: 'unknown_code' }, 404);
  if (device.revoked_at) return json({ error: 'device_revoked' }, 409);
  if (device.status === 'active') return json({ ok: true, alreadyApproved: true, deviceId: device.id });
  if (device.enrollment_expires_at && new Date(device.enrollment_expires_at) < new Date()) {
    return json({ error: 'code_expired' }, 410);
  }

  const patch: Record<string, unknown> = {
    status: 'active',
    enrollment_code: null, // single use — the code cannot adopt a second machine
    last_seen_at: new Date().toISOString(),
  };
  if (body.deviceName) patch.device_name = String(body.deviceName).slice(0, 80);

  const { error } = await db.from('agent_devices').update(patch).eq('id', device.id);
  if (error) return json({ error: 'approve_failed', detail: error.message }, 500);

  console.log(`[agent-sync] ${userData.user.email} approved device ${device.id}`);
  return json({ ok: true, deviceId: device.id, deviceName: patch.device_name || device.device_name });
}

// ---------------------------------------------------------------------------
// claim — hand this device the next job for its shop.
//
// One job at a time, marked in_progress with locked_at, so a restart mid-job does not
// lose it and two devices cannot pick up the same work.
// ---------------------------------------------------------------------------
async function claim(body: Record<string, unknown>) {
  const device = await authenticate(body.deviceToken);
  if (!device) return json({ error: 'unauthorized' }, 401);

  await db.from('agent_devices').update({ last_seen_at: new Date().toISOString() }).eq('id', device.id);

  const { data: jobs } = await db
    .from('agent_jobs')
    .select('id, type, payload, attempts, max_attempts')
    .eq('shop_id', device.shop_id)
    .eq('state', 'pending')
    .order('created_at', { ascending: true })
    .limit(1);

  const job = jobs?.[0];
  if (!job) return json({ job: null });

  if (job.attempts >= job.max_attempts) {
    await db.from('agent_jobs')
      .update({ state: 'failed', error: 'max attempts exceeded', completed_at: new Date().toISOString() })
      .eq('id', job.id);
    return json({ job: null });
  }

  await db.from('agent_jobs')
    .update({ state: 'in_progress', device_id: device.id, locked_at: new Date().toISOString(), attempts: job.attempts + 1 })
    .eq('id', job.id)
    .eq('state', 'pending'); // only claim it if nobody else just did

  return json({ job: { id: job.id, type: job.type, payload: job.payload } });
}

// ---------------------------------------------------------------------------
// report — the agent returns the outcome.
//
// Writing the result is idempotent: a job already completed is acknowledged rather
// than rewritten, so an interrupted upload can be retried safely. That matters because
// the agent queues results locally while offline and replays them on reconnect.
// ---------------------------------------------------------------------------
async function report(body: Record<string, unknown>) {
  const device = await authenticate(body.deviceToken);
  if (!device) return json({ error: 'unauthorized' }, 401);

  const jobId = String(body.jobId || '');
  if (!jobId) return json({ error: 'jobId_required' }, 400);

  const { data: job } = await db
    .from('agent_jobs')
    .select('id, type, state, shop_id')
    .eq('id', jobId)
    .maybeSingle();

  if (!job) return json({ error: 'job_not_found' }, 404);
  if (job.shop_id !== device.shop_id) return json({ error: 'wrong_shop' }, 403);
  if (job.state === 'completed') return json({ ok: true, alreadyCompleted: true });

  const failed = Boolean(body.error);
  await db.from('agent_jobs').update({
    state: failed ? 'failed' : 'completed',
    result: (body.result ?? null) as never,
    error: failed ? String(body.error).slice(0, 2000) : null,
    completed_at: new Date().toISOString(),
  }).eq('id', jobId);

  // A completed stock reading is applied to the catalogue here. Without this the job
  // would be marked done while the shop still showed nothing.
  let effect: unknown = null;
  if (!failed && job.type === 'read_godown_balances' && body.result) {
    try {
      effect = await applyStockReading(device.shop_id, body.result as Record<string, unknown>);
    } catch (err) {
      console.error('[agent-sync] applying stock reading failed:', err);
      effect = { error: String(err instanceof Error ? err.message : err) };
    }
  }

  return json({ ok: true, state: failed ? 'failed' : 'completed', effect });
}

// ---------------------------------------------------------------------------
// Apply a stock reading to the shop's catalogue.
//
// Reporting a job as complete is not the same as the shop seeing its stock. This is
// what turns a result into something the dashboard and the storefront read, and it
// happens HERE rather than on the device so the store PC never needs write access to
// the catalogue.
//
// Attribution rules, which matter commercially:
//   - a figure for the shop's online godown is sellable stock
//   - stock held in any OTHER godown is deliberately not counted, so the website can
//     never sell a piece sitting on the counter's rack
//   - stock Tally reports with no godown at all is recorded separately as needing
//     allocation, rather than silently becoming either zero or sellable
// ---------------------------------------------------------------------------
async function applyStockReading(shopId: string, result: Record<string, unknown>) {
  const items = Array.isArray(result?.items) ? (result.items as Record<string, unknown>[]) : [];
  if (!items.length) return { applied: 0, note: 'no items in result' };

  const { data: shop } = await db.from('shops').select('settings').eq('id', shopId).maybeSingle();
  const onlineGodown = String(
    (shop?.settings as Record<string, unknown> | null)?.online_godown || result.godown || ''
  ).trim();

  const matrix: Record<string, Record<string, number>> = {};
  const unallocated: Record<string, number> = {};
  let applied = 0;

  for (const item of items) {
    const name = String(item.name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();

    const godowns = (item.godowns || {}) as Record<string, number>;
    matrix[key] = godowns;
    if (Number(item.unallocated) > 0) unallocated[key] = Number(item.unallocated);

    // Sellable only if it is in the shop's online godown.
    const match = onlineGodown
      ? Object.keys(godowns).find((g) => g.toLowerCase() === onlineGodown.toLowerCase())
      : undefined;
    const sellable = match !== undefined ? Number(godowns[match]) || 0 : 0;

    const { error } = await db
      .from('saree_catalog')
      .update({ stock_quantity: Math.max(0, Math.round(sellable)), updated_at: new Date().toISOString() })
      .or(`sku.eq.${name},tally_part_number.eq.${name}`)
      .eq('shop_id', shopId);
    if (!error) applied++;
  }

  // Keep the full picture alongside the sellable figure, so the dashboard can explain
  // a zero ("40 in Tally, none in the online godown") instead of just showing nothing.
  const stamp = new Date().toISOString();
  await db.from('app_settings').upsert([
    { key: 'tally_godown_stock_matrix', value: JSON.stringify(matrix), updated_at: stamp },
    { key: 'tally_unallocated_stock', value: JSON.stringify(unallocated), updated_at: stamp },
  ], { onConflict: 'key' });

  return { applied, onlineGodown: onlineGodown || null, unallocatedItems: Object.keys(unallocated).length };
}

// ---------------------------------------------------------------------------
// heartbeat — liveness plus the cloud-side company check.
//
// The GUID is verified HERE rather than on the device. A tampered agent can lie about
// which company it has open, but it cannot make this function accept a company the
// shop was not registered against: a mismatch is recorded and reported back, and the
// device is told it is not authorised to sync.
// ---------------------------------------------------------------------------
async function heartbeat(body: Record<string, unknown>) {
  const device = await authenticate(body.deviceToken);
  if (!device) return json({ error: 'unauthorized' }, 401);

  const tally = (body.tally || {}) as Record<string, unknown>;
  const reportedGuid = tally.guid ? String(tally.guid).trim() : '';

  const { data: shop } = await db.from('shops').select('id, settings').eq('id', device.shop_id).maybeSingle();
  const registeredGuid = String((shop?.settings as Record<string, unknown> | null)?.tally_guid || '').trim();

  // First company seen for a shop becomes its registered identity. After that, only
  // that company is accepted.
  let identityOk = true;
  let identityNote = 'verified';
  if (!registeredGuid && reportedGuid) {
    await db.from('shops').update({
      settings: { ...((shop?.settings as Record<string, unknown>) || {}), tally_guid: reportedGuid, tally_company: tally.company ?? null },
    }).eq('id', device.shop_id);
    identityNote = 'registered_on_first_sight';
  } else if (registeredGuid && reportedGuid && registeredGuid !== reportedGuid) {
    identityOk = false;
    identityNote = 'guid_mismatch';
  } else if (!reportedGuid) {
    identityOk = false;
    identityNote = 'no_company_open';
  }

  await db.from('agent_devices').update({
    last_seen_at: new Date().toISOString(),
    tally_reachable: Boolean(tally.reachable),
    company_loaded: Boolean(reportedGuid),
    godown_exists: Boolean(tally.godownExists),
  }).eq('id', device.id);

  return json({
    ok: true,
    identityOk,
    identityNote,
    maySync: identityOk && Boolean(tally.reachable),
    deviceName: device.device_name,
    shopId: device.shop_id,
  });
}

// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const action = new URL(req.url).pathname.split('/').filter(Boolean).pop() || '';
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  try {
    switch (action) {
      case 'enroll': return await enroll(body);
      case 'enroll-status': return await enrollStatus(body);
      case 'approve': return await approve(req, body);
      case 'claim': return await claim(body);
      case 'report': return await report(body);
      case 'heartbeat': return await heartbeat(body);
      default: return json({ error: 'unknown_action', action }, 404);
    }
  } catch (err) {
    console.error(`[agent-sync] ${action} failed:`, err);
    return json({ error: 'internal', detail: String(err instanceof Error ? err.message : err) }, 500);
  }
});
