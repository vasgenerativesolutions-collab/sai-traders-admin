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
    .select('id, shop_id, device_name, status, revoked_at, company_loaded')
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
      status: 'pending', // authenticate() requires 'active', so this is inert until approved
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

  // Collected — retire both the handoff and the code, so neither can be replayed.
  await db.from('agent_devices').update({ version: null, enrollment_code: null }).eq('id', data.id);
  return json({ status: 'active', deviceToken: handoff, deviceId: data.id, deviceName: data.device_name, shopId: data.shop_id });
}


// ---------------------------------------------------------------------------
// approve — the dashboard adopts a machine that is showing a code.
//
// Authenticated as a PERSON, not a device: it validates the signed-in user's Supabase
// JWT. This is the only action that can turn an enrollment into a usable credential,
// which is what keeps the unauthenticated enroll call safe.
// ---------------------------------------------------------------------------
/**
 * The signed-in member behind a dashboard request, and the shops they may act on.
 *
 * approve() verified the JWT but never checked membership, so any signed-in Supabase
 * user could pair a device to any shop. Verifying identity is not the same as
 * authorising an action.
 */
async function authenticateMember(req: Request) {
  const auth = req.headers.get('authorization') || '';
  const jwt = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!jwt) return null;

  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data?.user) return null;

  const { data: rows } = await db
    .from('shop_members')
    .select('shop_id, role')
    .eq('user_id', data.user.id);

  const shopIds = (rows || []).map((r) => r.shop_id as string).filter(Boolean);
  if (!shopIds.length) return null;   // signed in, but belongs to no shop

  return { user: data.user, shopIds, email: data.user.email as string | undefined };
}

/**
 * Set an item's stock, asked for by a signed-in member.
 *
 * The dashboard has no other way to reach Tally when it is hosted with no server
 * behind it. The work is queued for the agent rather than attempted here: only the
 * agent can see Tally, and it reads the baseline immediately before writing so no
 * stale figure can land in the result.
 *
 * Writing to agent_jobs is deliberately NOT given to the browser through RLS. A job is
 * an instruction to change someone's books, so it is created here, where membership and
 * the shape of the payload are both checked.
 */
async function setStock(req: Request, body: Record<string, unknown>) {
  const member = await authenticateMember(req);
  if (!member) return json({ error: 'sign_in_required' }, 401);

  const name = String(body.name || body.code || '').trim();
  if (!name) return json({ error: 'name_required' }, 400);

  const target = Number(body.targetQuantity);
  if (!Number.isFinite(target) || target < 0 || target > 1_000_000) {
    return json({ error: 'target_out_of_range' }, 400);
  }

  const shopId = String(body.shopId || member.shopIds[0]);
  if (!member.shopIds.includes(shopId)) return json({ error: 'not_your_shop' }, 403);

  // The godown comes from the shop's registration, not the request. A caller naming its
  // own godown could move stock into one the shop does not sell from.
  const { data: shop } = await db.from('shops').select('settings').eq('id', shopId).maybeSingle();
  const settings = (shop?.settings as Record<string, unknown> | null) || {};
  const godown = String(settings.online_godown || '').trim();
  if (!godown) return json({ error: 'no_online_godown' }, 409);

  // The price is read from the catalogue, never taken from the caller: a rate in the
  // request body would let a browser set the value of a voucher.
  const { data: product } = await db
    .from('saree_catalog')
    .select('id, sku, tally_part_number, name, price, tally_rate')
    .eq('shop_id', shopId)
    .or(`sku.eq.${name},tally_part_number.eq.${name}`)
    .maybeSingle();

  if (!product) return json({ error: 'unknown_product' }, 404);

  const tallyName = String(product.tally_part_number || product.sku || product.name);
  const rate = Number(product.price) || Number(product.tally_rate) || 0;

  const { data: job, error } = await db.from('agent_jobs').insert({
    shop_id: shopId,
    type: 'adjust_stock',
    state: 'pending',
    payload: {
      name: tallyName,
      targetQuantity: Math.round(target),
      godown,
      unit: 'Pcs',
      rate,
      requestedBy: member.email || null,
    },
  }).select('id').single();

  if (error) return json({ error: 'queue_failed', detail: error.message }, 500);

  console.log(`[agent-sync] ${member.email} queued ${tallyName} -> ${target} in ${godown}`);
  return json({ ok: true, jobId: job.id, item: tallyName, godown, targetQuantity: Math.round(target) });
}

/**
 * Whether a saree may go on sale, and putting it there if so.
 *
 * Five conditions are enforced in the database by trg_enforce_listing_rules. They are
 * satisfied at different moments by different people, so every action that can complete
 * the set calls this — otherwise a saree becomes ready and sits unlisted because nothing
 * looked again.
 */
async function listIfReady(sareeId: string) {
  const { data: row } = await db
    .from('saree_catalog')
    .select('id, sku, tally_part_number, name, price, image_urls, status, is_active, item_created_in_tally, stock_added_in_tally')
    .eq('id', sareeId)
    .maybeSingle();

  if (!row) return { listed: false, needs: ['the product no longer exists'] };
  if (row.status === 'archived' || row.status === 'deleted') return { listed: false, offSale: true, needs: [] };

  const tallyCode = row.tally_part_number || row.sku;
  const { data: videos } = await db
    .from('video_item')
    .select('id, video_record!inner(is_active)')
    .eq('product_code', tallyCode)
    .eq('verified', true)
    .limit(1);
  const hasVideo = (videos || []).some((v: Record<string, unknown>) =>
    (v.video_record as Record<string, unknown> | null)?.is_active === true);

  const needs: string[] = [];
  const name = String(row.name || '').trim();
  if (!name) needs.push('a name');
  else if (name.toLowerCase() === String(tallyCode).toLowerCase()) needs.push('a name customers will understand');
  if (!(Number(row.price) > 0)) needs.push('a selling price');
  if (!Array.isArray(row.image_urls) || row.image_urls.length < 1) needs.push('at least one photo');
  if (!hasVideo) needs.push('a verified video');
  if (!row.item_created_in_tally || !row.stock_added_in_tally) needs.push('stock confirmed in Tally');

  if (needs.length) return { listed: row.status === 'listed', needs };
  if (row.status === 'listed' && row.is_active) return { listed: true, needs: [] };

  const { error } = await db.from('saree_catalog')
    .update({ status: 'listed', is_active: true, updated_at: new Date().toISOString() })
    .eq('id', sareeId);

  if (error) return { listed: false, needs: [`the database refused: ${error.message}`] };
  return { listed: true, needs: [], justListed: true };
}

/** Find one of this member's products by sku, part number or id. */
async function memberProduct(shopIds: string[], ref: string) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
  let q = db.from('saree_catalog')
    .select('id, shop_id, sku, tally_part_number, name, price, image_urls, status')
    .in('shop_id', shopIds);
  q = isUuid ? q.eq('id', ref) : q.or(`sku.eq.${ref},tally_part_number.eq.${ref}`);
  const { data } = await q.limit(1);
  return (data || [])[0] || null;
}

/**
 * Change what a customer sees.
 *
 * The same whitelist as the server route, for the same reasons: sku and
 * tally_part_number are the link to Tally and changing them would strand the saree;
 * stock_quantity belongs to Tally; and whether a saree is on sale has its own action so
 * that withdrawing one is never a side effect of an edit.
 */
async function updateProduct(req: Request, body: Record<string, unknown>) {
  const member = await authenticateMember(req);
  if (!member) return json({ error: 'sign_in_required' }, 401);

  const saree = await memberProduct(member.shopIds, String(body.id || body.code || '').trim());
  if (!saree) return json({ error: 'unknown_product' }, 404);

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (typeof body.name === 'string') {
    const name = body.name.trim();
    if (!name) return json({ error: 'name_required' }, 400);
    patch.name = name.slice(0, 140);
  }
  if (typeof body.description === 'string') patch.description = body.description.trim().slice(0, 2000);

  for (const field of ['price', 'mrp']) {
    const raw = body[field];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return json({ error: `${field}_invalid` }, 400);
    patch[field] = value;
  }
  for (const field of ['fabric', 'color_primary', 'color_secondary', 'weave_style']) {
    if (typeof body[field] === 'string') patch[field] = String(body[field]).trim().slice(0, 80);
  }

  if (Object.keys(patch).length === 1) return json({ error: 'nothing_to_change' }, 400);

  const { error } = await db.from('saree_catalog').update(patch).eq('id', saree.id);
  if (error) return json({ error: 'save_failed', detail: error.message }, 500);

  const { listed, needs } = await listIfReady(saree.id);
  const shown = String(patch.name || saree.name);

  return json({
    ok: true, listed, needs, sku: saree.sku, name: shown,
    message: listed
      ? `Saved. "${shown}" is on sale to online customers.`
      : `Saved — customers will see "${shown}". Still needed before it goes on sale: ${needs.join(', ')}.`,
  });
}

/**
 * Take a saree off online sale, or put it back.
 *
 * Tally is never touched: it keeps whatever it holds, so the counter can still sell the
 * saree in the shop. The record stays too, so photos and price survive.
 */
async function setOffSale(req: Request, body: Record<string, unknown>) {
  const member = await authenticateMember(req);
  if (!member) return json({ error: 'sign_in_required' }, 401);

  const saree = await memberProduct(member.shopIds, String(body.id || body.code || '').trim());
  if (!saree) return json({ error: 'unknown_product' }, 404);

  const restore = body.restore === true;

  if (restore) {
    const { error } = await db.from('saree_catalog')
      .update({ status: 'draft', is_active: true, listing_notes: null, updated_at: new Date().toISOString() })
      .eq('id', saree.id);
    if (error) return json({ error: 'restore_failed', detail: error.message }, 500);

    const { listed, needs } = await listIfReady(saree.id);
    return json({
      ok: true, listed, needs, sku: saree.sku,
      message: listed
        ? `${saree.sku} is back on sale.`
        : `${saree.sku} is back in the catalogue. Still needed before it goes on sale: ${needs.join(', ')}.`,
    });
  }

  // The embedding goes too, or an image search would still surface a saree nobody can buy.
  const { error } = await db.from('saree_catalog').update({
    is_active: false,
    status: 'archived',
    stock_quantity: 0,
    embedding: null,
    embedding_v2: null,
    listing_notes: `Taken off online sale on ${new Date().toISOString().slice(0, 10)}. Tally still holds this item.`,
    updated_at: new Date().toISOString(),
  }).eq('id', saree.id);

  if (error) return json({ error: 'off_sale_failed', detail: error.message }, 500);

  return json({
    ok: true, offSale: true, sku: saree.sku,
    message: `${saree.sku} is off online sale. Tally still holds it, so the counter can keep selling it in the shop.`,
  });
}

/** Which of the four allowed sources this video came from. */
function deriveVideoSource(given: unknown, url: string | null): string {
  const allowed = ['instagram', 'youtube', 'studio', 'direct_upload'];
  const asked = String(given || '').trim().toLowerCase();
  if (allowed.includes(asked)) return asked;
  const link = String(url || '').toLowerCase();
  if (link.includes('instagram')) return 'instagram';
  if (link.includes('youtube') || link.includes('youtu.be')) return 'youtube';
  if (link) return 'direct_upload';
  return 'studio';
}
/**
 * An embedding for a piece of text or an image, used to make a saree findable.
 *
 * The shared helper only does text, and a video is mostly frames, so this talks to the
 * same model with either kind of part.
 */
async function embed(part: Record<string, unknown>): Promise<number[] | null> {
  const key = Deno.env.get('GEMINI_API_KEY');
  if (!key) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'models/gemini-embedding-001',
          content: { parts: [part] },
          outputDimensionality: 768,
        }),
      }
    );
    if (!res.ok) {
      console.error('[add-video] embedding refused:', (await res.text()).slice(0, 200));
      return null;
    }
    const body = await res.json();
    const values = body?.embedding?.values;
    return Array.isArray(values) ? values : null;
  } catch (err) {
    console.error('[add-video] embedding failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Record a video for a saree.
 *
 * A video is one of the five conditions for going on sale, but it is also how a
 * customer's photograph is matched to a saree: the keyframes the shop captures become
 * image embeddings, and the description becomes a text embedding.
 *
 * The first version of this stored only the video id and threw the rest away. The
 * listing condition was satisfied, so it looked like it had worked, while the frames
 * and the attributes the shop had just typed went nowhere and image search was never
 * taught the saree. Half a job that reports success is worse than a failure.
 *
 * The product code must be the Tally code: the listing guard matches on it, so a video
 * filed under anything else satisfies nothing and gives no clue why.
 */
async function addVideo(req: Request, body: Record<string, unknown>) {
  const member = await authenticateMember(req);
  if (!member) return json({ error: 'sign_in_required' }, 401);

  const code = String(body.product_code || body.code || '').trim();
  if (!code) return json({ error: 'product_code_required' }, 400);

  const saree = await memberProduct(member.shopIds, code);
  if (!saree) return json({ error: 'unknown_product' }, 404);

  const tallyCode = String(saree.tally_part_number || saree.sku);
  const videoId = String(body.video_id || `vid_${tallyCode.toLowerCase()}_${Date.now()}`).trim();
  const sourceUrl = typeof body.source_url === 'string' ? body.source_url.trim().slice(0, 500) : null;
  const description = typeof body.video_description === 'string' ? body.video_description.trim().slice(0, 2000) : '';

  // The craft attributes the shop typed, kept together with the summary, exactly as the
  // store server stores them so both routes produce the same shape.
  const attrs: Record<string, unknown> = {
    ...(body.craft_attributes && typeof body.craft_attributes === 'object' ? body.craft_attributes as Record<string, unknown> : {}),
  };
  if (description) attrs.stylist_summary = description;

  const frames = Array.isArray(body.reference_frames)
    ? (body.reference_frames as Record<string, unknown>[]).slice(0, 12)
    : [];

  // Frames are kept without their image data: the pictures become embeddings below, and
  // storing base64 JPEGs in a jsonb column would bloat every read of this row.
  const frameIndex = frames.map((f) => ({
    timestamp_sec: Number(f.timestamp_sec) || 0,
    mimeType: String(f.mimeType || 'image/jpeg'),
  }));

  const { error: recErr } = await db.from('video_record').upsert({
    video_id: videoId,
    product_code: tallyCode,
    // source is constrained to instagram, youtube, studio or direct_upload. It is
    // derived from the link when there is one, because the website does not ask: a
    // value outside that list is refused and the whole video is lost with it.
    source: deriveVideoSource(body.source, sourceUrl),
    source_url: sourceUrl,
    saree: attrs,
    reference_frames: frameIndex,
    is_active: true,
    verified: true,
    verified_by: member.email || 'dashboard',
    verified_at: new Date().toISOString(),
    review_notes: description || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'video_id' });
  if (recErr) return json({ error: 'video_record_failed', detail: recErr.message }, 500);

  const { error: itemErr } = await db.from('video_item').upsert({
    video_id: videoId,
    product_code: tallyCode,
    verified: true,
    attrs,
    notes: description || null,
  }, { onConflict: 'video_id,product_code' });
  if (itemErr) return json({ error: 'video_item_failed', detail: itemErr.message }, 500);

  // What makes the saree findable. A failure here is reported, not swallowed: the video
  // is recorded either way, but the shop must know image search was not taught.
  const textFor = [
    tallyCode, 'saree', description,
    attrs.fabric, attrs.weave_style, attrs.color_primary, attrs.border_type, attrs.zari_type,
  ].filter(Boolean).join(' ');

  const textEmb = await embed({ text: textFor });
  let framesIndexed = 0;

  for (const frame of frames) {
    const raw = typeof frame.base64 === 'string' ? frame.base64 : '';
    if (!raw) continue;
    const data = raw.replace(/^data:image\/\w+;base64,/, '');
    const imageEmb = await embed({ inline_data: { mime_type: String(frame.mimeType || 'image/jpeg'), data } });

    const { error } = await db.from('saree_frame').insert({
      video_id: videoId,
      product_code: tallyCode,
      timestamp_sec: Number(frame.timestamp_sec) || 0,
      attrs,
      image_emb: imageEmb,
      text_emb: textEmb,
      embedding_model: 'gemini-embedding-001',
      embedding_dim: 768,
      verified: true,
    });
    if (!error && imageEmb) framesIndexed++;
  }

  // The product's own embedding, which is what a text search matches against.
  if (textEmb) {
    await db.from('saree_catalog')
      .update({ embedding: textEmb, embedding_model: 'gemini-embedding-001', embedding_dim: 768 })
      .eq('id', saree.id);
  }

  const { listed, needs } = await listIfReady(saree.id);

  const indexing = framesIndexed
    ? `${framesIndexed} of ${frames.length} frame(s) indexed for image search`
    : frames.length
      ? 'the frames could not be indexed for image search'
      : 'no keyframes were captured, so image search has nothing to match';

  return json({
    ok: true,
    videoId,
    framesIndexed,
    framesGiven: frames.length,
    textIndexed: Boolean(textEmb),
    listed,
    needs,
    message: listed
      ? `Video added and ${saree.sku} is now on sale. ${indexing}.`
      : `Video added. ${indexing}. Still needed before it goes on sale: ${needs.join(', ')}.`,
  });
}

/**
 * Attach an uploaded photo to a saree.
 *
 * The browser uploads the file to storage itself under the member's own session; this
 * records the URL against the product, because the catalogue is not writable from a
 * browser and should not be.
 */
async function attachPhoto(req: Request, body: Record<string, unknown>) {
  const member = await authenticateMember(req);
  if (!member) return json({ error: 'sign_in_required' }, 401);

  const saree = await memberProduct(member.shopIds, String(body.id || body.code || '').trim());
  if (!saree) return json({ error: 'unknown_product' }, 404);

  const url = String(body.url || '').trim();
  // Only a URL inside this project's own public catalogue bucket. Anything else would
  // let a browser point a product at any image on the internet.
  const expected = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/saree-catalog-images/`;
  if (!url.startsWith(expected)) return json({ error: 'url_not_in_catalogue_bucket' }, 400);

  const existing = Array.isArray(saree.image_urls) ? saree.image_urls as string[] : [];
  if (existing.includes(url)) return json({ ok: true, alreadyAttached: true, image_urls: existing });
  if (existing.length >= 12) return json({ error: 'too_many_photos' }, 400);

  const image_urls = [...existing, url];
  const { error } = await db.from('saree_catalog')
    .update({ image_urls, updated_at: new Date().toISOString() })
    .eq('id', saree.id);
  if (error) return json({ error: 'attach_failed', detail: error.message }, 500);

  const { listed, needs } = await listIfReady(saree.id);
  return json({
    ok: true, image_urls, listed, needs,
    message: listed
      ? `Photo added, and ${saree.sku} is now on sale.`
      : `Photo added. Still needed before it goes on sale: ${needs.join(', ')}.`,
  });
}

/** How a queued job is getting on, for the member who asked for it. */
async function jobStatus(req: Request, body: Record<string, unknown>) {
  const member = await authenticateMember(req);
  if (!member) return json({ error: 'sign_in_required' }, 401);

  const id = String(body.jobId || '').trim();
  if (!id) return json({ error: 'jobId_required' }, 400);

  const { data: job } = await db
    .from('agent_jobs')
    .select('id, shop_id, type, state, error, result')
    .eq('id', id)
    .maybeSingle();

  if (!job) return json({ error: 'job_not_found' }, 404);
  if (!member.shopIds.includes(job.shop_id)) return json({ error: 'not_your_shop' }, 403);

  return json({ ok: true, state: job.state, error: job.error, result: job.result });
}

async function approve(req: Request, body: Record<string, unknown>) {
  // Membership, not just a valid session. Any signed-in Supabase user could pair a
  // device to any shop before this: the JWT was verified and then nothing was asked
  // about what that person is allowed to do.
  const member = await authenticateMember(req);
  if (!member) return json({ error: 'sign_in_required' }, 401);

  const code = String(body.code || '').toUpperCase().trim();
  if (!code) return json({ error: 'code_required' }, 400);

  const { data: device } = await db
    .from('agent_devices')
    .select('id, shop_id, status, enrollment_expires_at, revoked_at, device_name')
    .eq('enrollment_code', code)
    .maybeSingle();

  if (!device) return json({ error: 'unknown_code' }, 404);
  if (!member.shopIds.includes(device.shop_id)) return json({ error: 'not_your_shop' }, 403);
  if (device.revoked_at) return json({ error: 'device_revoked' }, 409);
  if (device.status === 'active') return json({ ok: true, alreadyApproved: true, deviceId: device.id });
  if (device.enrollment_expires_at && new Date(device.enrollment_expires_at) < new Date()) {
    return json({ error: 'code_expired' }, 410);
  }

  const patch: Record<string, unknown> = {
    status: 'active',
    // The code is deliberately NOT cleared here. The agent polls enroll-status by
    // code, so clearing it at approval left it unable to find its own row and it waited
    // for an approval that had already happened. It is cleared when the token is
    // collected, which is what makes it single use.
    last_seen_at: new Date().toISOString(),
  };
  if (body.deviceName) patch.device_name = String(body.deviceName).slice(0, 80);

  const { error } = await db.from('agent_devices').update(patch).eq('id', device.id);
  if (error) return json({ error: 'approve_failed', detail: error.message }, 500);

  // Retire every other agent for this shop. One Tally, one agent.
  const { data: retired } = await db
    .from('agent_devices')
    .update({ status: 'revoked', revoked_at: new Date().toISOString() })
    .eq('shop_id', device.shop_id)
    .eq('status', 'active')
    .neq('id', device.id)
    .select('id, device_name');

  if (retired?.length) {
    console.log(`[agent-sync] retired ${retired.length} previous agent(s) for shop ${device.shop_id}`);
  }

  console.log(`[agent-sync] ${member.email} approved device ${device.id}`);
  return json({ ok: true, deviceId: device.id, deviceName: patch.device_name || device.device_name });
}

// ---------------------------------------------------------------------------
// claim — hand this device the next job for its shop.
//
// One job at a time, marked in_progress with locked_at, so a restart mid-job does not
// lose it and two devices cannot pick up the same work.
// ---------------------------------------------------------------------------
/**
 * The company a shop is registered to, and whether a device is currently looking at it.
 *
 * A shop is bound to one Tally company by GUID on first sight. Nothing enforced that
 * afterwards: sync applied whatever reading arrived, so opening a different company on
 * the shop PC would have written that company's stock straight into this shop's
 * catalogue, and jobs would have posted vouchers into someone else's books.
 */
async function registeredGuidFor(shopId: string): Promise<string> {
  const { data: shop } = await db.from('shops').select('settings').eq('id', shopId).maybeSingle();
  return String((shop?.settings as Record<string, unknown> | null)?.tally_guid || '').trim();
}

/** Mismatch reason, or null when the company is the right one. */
function companyRefusal(registered: string, reported: string): string | null {
  if (!registered) return null;             // not yet bound — first sight registers it
  if (!reported) return 'no_company_open';  // cannot prove which company this came from
  if (reported.toLowerCase() !== registered.toLowerCase()) return 'guid_mismatch';
  return null;
}

async function claim(body: Record<string, unknown>) {
  const device = await authenticate(body.deviceToken);
  if (!device) return json({ error: 'unauthorized' }, 401);

  await db.from('agent_devices').update({ last_seen_at: new Date().toISOString() }).eq('id', device.id);

  // Hand out no work while this PC is looking at the wrong company. A write would land
  // in the wrong company's books, which is far worse than not writing at all.
  const registered = await registeredGuidFor(device.shop_id);
  const refusal = companyRefusal(registered, String(device.company_loaded || '').trim());
  if (refusal) return json({ job: null, refused: refusal });

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
      effect = await applyStockReading(device.shop_id, body.result as Record<string, unknown>, String(device.company_loaded || ''));
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
async function applyStockReading(shopId: string, result: Record<string, unknown>, deviceGuid = '') {
  const items = Array.isArray(result?.items) ? (result.items as Record<string, unknown>[]) : [];

  // A reading carries the company it was taken from. Both sync and report land here,
  // so this is the one place the check cannot be skipped. Without it, a different
  // company open on the shop PC would overwrite this shop's catalogue with its stock.
  // A reading names its own company. An agent from before that change does not, so
  // the GUID its heartbeat recorded seconds earlier stands in — weaker, but it still
  // catches a shop PC pointed at the wrong company instead of trusting it blindly.
  const reportedGuid = String(
    (result.company as Record<string, unknown> | undefined)?.guid || result.companyGuid || deviceGuid || ''
  ).trim();
  const registered = await registeredGuidFor(shopId);
  const refusal = companyRefusal(registered, reportedGuid);
  if (refusal) {
    return { applied: 0, refused: refusal, expectedGuid: registered || null, reportedGuid: reportedGuid || null };
  }

  // A company with no stock items is a real answer, not a non-event. Returning early
  // left the last-read timestamp frozen, so the dashboard reported stock as hours
  // stale while the agent was in fact reading Tally every two minutes.
  //
  // The timestamp and the empty picture are recorded, but catalogue quantities are
  // NOT zeroed on an empty read. A transient fault that returned nothing would
  // otherwise wipe every sellable figure in the shop; leaving them is the recoverable
  // mistake, clearing them is not.
  if (!items.length) {
    const now = new Date().toISOString();
    await db.from('app_settings').upsert([
      { key: 'tally_godown_stock_matrix', value: JSON.stringify({}), updated_at: now },
      { key: 'tally_unallocated_stock', value: JSON.stringify({}), updated_at: now },
    ], { onConflict: 'key' });
    return { applied: 0, note: 'Tally holds no stock items; catalogue quantities left untouched' };
  }

  const { data: shop } = await db.from('shops').select('settings').eq('id', shopId).maybeSingle();
  const onlineGodown = String(
    (shop?.settings as Record<string, unknown> | null)?.online_godown || result.godown || ''
  ).trim();

  // Match in memory rather than with a PostgREST filter per item.
  //
  // The filter was `sku.eq.<name>`, which is case SENSITIVE: Tally reports
  // SAI_SILK_02 while the catalogue row is Sai_silk_02, so the update matched nothing
  // and 1500 units sat in Tally showing as zero online. SAI-SIK-02 only worked because
  // its case happened to agree. The filter was also unescaped, so an item name holding
  // a comma would corrupt it, and `%` or `_` would act as wildcards — and every SKU
  // here contains an underscore.
  const { data: catalogue } = await db
    .from('saree_catalog')
    .select('id, sku, tally_part_number, stock_quantity, status, price, item_created_in_tally, stock_added_in_tally')
    .eq('shop_id', shopId);

  const byName = new Map<string, {
    id: string;
    stock_quantity: number;
    status: string | null;
    price: number;
    item_created_in_tally: boolean | null;
    stock_added_in_tally: boolean | null;
  }>();
  for (const row of catalogue || []) {
    const r = row as {
      id: string;
      sku: string | null;
      tally_part_number: string | null;
      stock_quantity: number | null;
      status: string | null;
      price: number | null;
      item_created_in_tally: boolean | null;
      stock_added_in_tally: boolean | null;
    };
    const entry = {
      id: r.id,
      stock_quantity: Number(r.stock_quantity) || 0,
      status: r.status,
      price: Number(r.price) || 0,
      item_created_in_tally: r.item_created_in_tally,
      stock_added_in_tally: r.stock_added_in_tally,
    };
    for (const candidate of [r.sku, r.tally_part_number]) {
      const k = String(candidate || '').trim().toLowerCase();
      if (k && !byName.has(k)) byName.set(k, entry);
    }
  }

  const matrix: Record<string, Record<string, number>> = {};
  const unallocated: Record<string, number> = {};
  const matched = new Set<string>();
  let applied = 0;
  const unmatched: { name: string; sellable: number; rate: number }[] = [];

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
    const sellable = Math.max(0, Math.round(match !== undefined ? Number(godowns[match]) || 0 : 0));

    const row = byName.get(key);
    const tallyRate = Math.max(0, Number(item.rate) || 0);
    if (!row) { unmatched.push({ name, sellable, rate: tallyRate }); continue; } // in Tally, no product yet
    matched.add(row.id);

    // Tally's rate is recorded for reference, but an existing product's price is never
    // overwritten — that figure is the owner's decision, not Tally's.
    // A saree taken off online sale stays off, whatever Tally reports. Tally is the
    // shop's book of record and will keep holding the item — that is the point, the
    // counter can still sell it — but the online quantity stays at zero so no other
    // code path can offer something the owner has withdrawn.
    const offSale = row.status === 'archived' || row.status === 'deleted';
    const onlineQty = offSale ? 0 : sellable;

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (row.stock_quantity !== onlineQty) patch.stock_quantity = onlineQty;
    if (tallyRate > 0) patch.tally_rate = tallyRate;

    // Tally just told us this item exists, so record that. The dashboard's "Not in
    // Tally" badge reads this flag, and nothing kept it truthful — an item sitting in
    // Tally with stock was still labelled missing from it.
    if (row.item_created_in_tally !== true) patch.item_created_in_tally = true;
    if (sellable > 0 && row.stock_added_in_tally !== true) patch.stock_added_in_tally = true;

    // Fill the price only while it is still unset and the product is awaiting review.
    // That is not overwriting anyone's decision — there is no decision yet, and a
    // product drafted before the rate was being read would otherwise sit at zero for
    // ever. Once a person has priced it, Tally never moves that figure again.
    if (row.status === 'pending_review' && row.price <= 0 && tallyRate > 0) {
      patch.price = tallyRate;
    }
    if (Object.keys(patch).length === 1) { applied++; continue; } // nothing to change

    const { error } = await db.from('saree_catalog').update(patch).eq('id', row.id);
    if (!error) applied++;
  }

  // An item the shop created in Tally has no product yet, and that is the normal way
  // this works: stock is entered in Tally, not in the web catalogue. Leaving it
  // unmatched meant stock existed in the online godown that the shop could never sell
  // and nothing reported — 1500 units sat invisible under a name no product used.
  //
  // So a product is created for it, as a DRAFT the owner completes. It cannot be sold
  // in that state: customer search requires is_active and status 'listed', and also an
  // embedding, which a new draft has none of. Price stays 0 deliberately — an
  // unpriced saree must never be offerable.
  //
  // sku and tally_part_number are both unique, so this cannot duplicate a product.
  let drafted = 0;
  if (unmatched.length) {
    const now = new Date().toISOString();
    const { error } = await db.from('saree_catalog').upsert(
      unmatched.map(({ name, sellable, rate }) => ({
        shop_id: shopId,
        sku: name,
        tally_part_number: name,
        name,
        fabric: 'Unspecified',
        color_primary: 'Unspecified',
        // The rate the shop typed in Tally is the only price this item has, so it
        // starts there rather than at zero. It is still pending_review and not
        // sellable, so a person confirms the figure before a customer can see it.
        price: rate > 0 ? rate : 0,
        tally_rate: rate > 0 ? rate : null,
        stock_quantity: sellable,
        is_active: false,
        status: 'pending_review',
        item_created_in_tally: true,
        stock_added_in_tally: sellable > 0,
        tally_master_id: name,
        tally_created_at: now,
        tally_last_seen_at: now,
        created_by: 'agent',
        listing_notes: 'Created in TallyPrime at the shop. Add a price, photos and details, then list it.',
      })),
      { onConflict: 'sku', ignoreDuplicates: true }
    );
    if (!error) drafted = unmatched.length;
    else console.error('[agent-sync] could not draft new Tally items:', error.message);
  }

  // Items the catalogue lists but Tally no longer reports have no stock. A reading
  // always enumerates every stock item in the company — the godown argument does not
  // filter it — so absence is an answer, not a gap. Leaving the previous figure would
  // offer for sale what Tally does not have.
  //
  // This runs only for a non-empty reading. An empty one returns earlier precisely
  // because it cannot be told apart from a transient fault.
  const absent = (catalogue || [])
    .map((row) => row as { id: string; stock_quantity: number | null })
    .filter((row) => !matched.has(row.id) && (Number(row.stock_quantity) || 0) > 0)
    .map((row) => row.id);

  let cleared = 0;
  if (absent.length) {
    const { error } = await db
      .from('saree_catalog')
      .update({
        stock_quantity: 0,
        item_created_in_tally: false,
        stock_added_in_tally: false,
        updated_at: new Date().toISOString(),
      })
      .in('id', absent);
    // status is deliberately untouched here: whether a saree is on sale is the owner's
    // decision, and Tally no longer listing an item does not reverse it.
    if (!error) cleared = absent.length;
  }

  // Keep the full picture alongside the sellable figure, so the dashboard can explain
  // a zero ("40 in Tally, none in the online godown") instead of just showing nothing.
  const stamp = new Date().toISOString();
  await db.from('app_settings').upsert([
    { key: 'tally_godown_stock_matrix', value: JSON.stringify(matrix), updated_at: stamp },
    { key: 'tally_unallocated_stock', value: JSON.stringify(unallocated), updated_at: stamp },
  ], { onConflict: 'key' });

  return { applied, cleared, drafted, onlineGodown: onlineGodown || null, unallocatedItems: Object.keys(unallocated).length };
}

// ---------------------------------------------------------------------------
// sync — the agent volunteers a stock reading on its own schedule.
//
// No job, no queue, no cron. Routine refresh is the agent's own responsibility, which
// removes an entire class of "stock is stale because nothing enqueued the work".
// ---------------------------------------------------------------------------
async function syncStock(body: Record<string, unknown>) {
  const device = await authenticate(body.deviceToken);
  if (!device) return json({ error: 'unauthorized' }, 401);

  const result = (body.result || {}) as Record<string, unknown>;
  if (!Array.isArray(result.items)) return json({ error: 'items_required' }, 400);

  // Do not assert a company here: this would overwrite the GUID the heartbeat
  // recorded with a bare "true", and that GUID is what claim checks against.
  await db.from('agent_devices').update({
    last_seen_at: new Date().toISOString(),
    tally_reachable: true,
  }).eq('id', device.id);

  const effect = await applyStockReading(device.shop_id, result, String(device.company_loaded || ''));
  return json({ ok: true, effect });
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

  // Keep the company name current, not just at first sight. It was recorded only on
  // registration, so a shop registered before the name was captured had none, and the
  // dashboard had nothing to show but the boolean "a company is open".
  if (identityOk && reportedGuid && tally.company) {
    const storedName = String((shop?.settings as Record<string, unknown> | null)?.tally_company || '');
    if (storedName !== String(tally.company)) {
      await db.from('shops').update({
        settings: {
          ...((shop?.settings as Record<string, unknown>) || {}),
          tally_guid: registeredGuid || reportedGuid,
          tally_company: String(tally.company),
        },
      }).eq('id', device.shop_id);
    }
  }

  // version held the one-time token handoff, which is cleared as soon as the token is
  // collected. From then on the column is free, and its name already says what this is.
  const patch: Record<string, unknown> = {
    last_seen_at: new Date().toISOString(),
    tally_reachable: Boolean(tally.reachable),
    company_loaded: reportedGuid || null,
    godown_exists: Boolean(tally.godownExists),
  };
  if (body.agentVersion) patch.version = String(body.agentVersion).slice(0, 40);
  await db.from('agent_devices').update(patch).eq('id', device.id);

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
      case 'sync': return await syncStock(body);
      case 'report': return await report(body);
      case 'heartbeat': return await heartbeat(body);
      case 'set-stock': return await setStock(req, body);
      case 'job-status': return await jobStatus(req, body);
      case 'update-product': return await updateProduct(req, body);
      case 'set-off-sale': return await setOffSale(req, body);
      case 'add-video': return await addVideo(req, body);
      case 'attach-photo': return await attachPhoto(req, body);
      default: return json({ error: 'unknown_action', action }, 404);
    }
  } catch (err) {
    console.error(`[agent-sync] ${action} failed:`, err);
    return json({ error: 'internal', detail: String(err instanceof Error ? err.message : err) }, 500);
  }
});
