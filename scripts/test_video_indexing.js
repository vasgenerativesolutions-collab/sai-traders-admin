/**
 * Attaching a video must actually index the saree, not merely record that a video
 * exists.
 *
 * The listing rule only asks whether a verified video is present, so a video that
 * stored nothing still put the saree on sale and reported success — while the frames
 * the shop captured, the attributes they typed, and the embeddings that match a
 * customer's photograph all went nowhere. This asserts the work was done, with real
 * image data, against the live project.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const get = (k) => (env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [, ''])[1].trim();
const base = get('SUPABASE_URL');
const ANON = get('SUPABASE_ANON_KEY');
const SERVICE = get('SUPABASE_SERVICE_ROLE_KEY');
const SVC = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };

const SKU = 'ZZ-VIDEO-CHECK';
const EMAIL = 'video-check@saitraders.invalid';
const PASSWORD = 'Video-check-2611';

// A real 96x96 image. An 8x8 one is refused by the vision model with "Unable to
// process input image", which reads exactly like a broken code path — the first
// version of this test chased that for a while before the picture turned out to be
// the problem.
const { pngBase64, mimeType } = require('./make_test_image.js');
const FRAME_B64 = pngBase64();

const svc = (p, o) => fetch(`${base}/rest/v1/${p}`, { headers: SVC, ...o });

let userId = null;
let videoId = null;

(async () => {
  const [shop] = await svc('shops?select=id&limit=1').then((r) => r.json());

  // --- a member, and a saree of its own to index ---------------------------
  const existing = await fetch(`${base}/auth/v1/admin/users?per_page=200`, { headers: SVC }).then((r) => r.json());
  for (const u of existing.users || []) {
    if (u.email === EMAIL) await fetch(`${base}/auth/v1/admin/users/${u.id}`, { method: 'DELETE', headers: SVC });
  }
  const user = await fetch(`${base}/auth/v1/admin/users`, {
    method: 'POST', headers: SVC,
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, email_confirm: true }),
  }).then((r) => r.json());
  assert.ok(user.id, `could not create a test member: ${JSON.stringify(user).slice(0, 200)}`);
  userId = user.id;
  await svc('shop_members', { method: 'POST', body: JSON.stringify([{ user_id: userId, shop_id: shop.id, role: 'staff' }]) });

  const session = await fetch(`${base}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  }).then((r) => r.json());
  const token = session.access_token;
  assert.ok(token, 'sign-in failed');

  const fn = (action, body) => fetch(`${base}/functions/v1/agent-sync/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  await svc(`saree_catalog?sku=eq.${SKU}`, { method: 'DELETE' });
  await svc('saree_catalog', {
    method: 'POST',
    body: JSON.stringify([{
      shop_id: shop.id, sku: SKU, tally_part_number: SKU, name: 'Video Check Silk Saree',
      fabric: 'Pure Silk', color_primary: 'Royal Green', price: 9000, stock_quantity: 2,
      is_active: false, status: 'pending_review',
      item_created_in_tally: true, stock_added_in_tally: true, created_by: 'agent',
      image_urls: ['https://example.invalid/placeholder.jpg'],
    }]),
  });

  // --- attach a video with real keyframes, as the website does -------------
  const res = await fn('add-video', {
    product_code: SKU,
    video_description: 'Pallu and border close-up',
    source_url: 'https://www.instagram.com/reel/example/',
    craft_attributes: { fabric: 'Pure Silk', weave_style: 'Kanjivaram', zari_type: 'Pure Zari' },
    reference_frames: [
      { base64: FRAME_B64, mimeType, timestamp_sec: 1.5 },
      { base64: FRAME_B64, mimeType, timestamp_sec: 4.25 },
    ],
  });

  assert.strictEqual(res.status, 200, `add-video failed: ${JSON.stringify(res.body).slice(0, 250)}`);
  videoId = res.body.videoId;
  console.log(`ok   video accepted: ${videoId}`);

  assert.strictEqual(res.body.textIndexed, true, 'the description was not indexed, so text search cannot find this saree');
  console.log('ok   the description was indexed for text search');

  assert.strictEqual(res.body.framesGiven, 2, 'both keyframes should have been received');

  // Not an image embedding: Gemini's embedContent is text-only. A customer's photograph
  // is matched by describing it and embedding the description, so the keyframes are
  // described the same way — that is what puts both sides in the same language.
  assert.ok(res.body.framesDescribed >= 1,
    'no keyframe was described, so a customer photograph has nothing to match against');
  console.log(`ok   ${res.body.framesDescribed} keyframe(s) described by vision`);

  assert.strictEqual(res.body.framesStored, 2, 'both frames should be stored with their timestamps');
  console.log('ok   both frames stored');

  // --- and it is really in the database ------------------------------------
  const frames = await svc(`saree_frame?select=timestamp_sec,text_emb,embedding_dim&video_id=eq.${videoId}`)
    .then((r) => r.json());
  assert.strictEqual(frames.length, 2, 'both frames must be stored');
  for (const f of frames) {
    assert.ok(f.text_emb, `the frame at ${f.timestamp_sec}s has no embedding`);
    assert.strictEqual(f.embedding_dim, 768);
  }
  assert.deepStrictEqual(frames.map((f) => f.timestamp_sec).sort(), [1.5, 4.25],
    'the frame timestamps must be kept, or a match cannot be shown at the right moment');
  console.log('ok   both frames carry an embedding at the right timestamps');

  // The attributes the shop typed must survive.
  const [record] = await svc(`video_record?select=saree,source,reference_frames,verified&video_id=eq.${videoId}`)
    .then((r) => r.json());
  assert.strictEqual(record.saree.fabric, 'Pure Silk');
  assert.strictEqual(record.saree.weave_style, 'Kanjivaram');
  assert.strictEqual(record.saree.stylist_summary, 'Pallu and border close-up');
  assert.strictEqual(record.source, 'instagram', 'the source should be derived from the link');
  assert.strictEqual(record.reference_frames.length, 2);
  console.log(`ok   attributes kept, source derived as "${record.source}"`);

  // The product's own embedding, which is what a text search matches against.
  const [product] = await svc(`saree_catalog?select=embedding,embedding_dim,status&sku=eq.${SKU}`).then((r) => r.json());
  assert.ok(product.embedding, 'the product has no embedding, so a search cannot find it');
  assert.strictEqual(product.embedding_dim, 768);
  console.log('ok   the saree itself is searchable');

  // And it went on sale, because the video was the last condition.
  assert.strictEqual(product.status, 'listed', `it met every condition but is ${product.status}`);
  console.log('ok   the video completed the set and it went on sale');

  console.log('\nall video indexing checks passed');
})()
  .catch((e) => { console.error('\nFAILED: ' + e.message); process.exitCode = 1; })
  .finally(async () => {
    if (videoId) {
      await svc(`saree_frame?video_id=eq.${videoId}`, { method: 'DELETE' });
      await svc(`video_item?video_id=eq.${videoId}`, { method: 'DELETE' });
      await svc(`video_record?video_id=eq.${videoId}`, { method: 'DELETE' });
    }
    await svc(`saree_catalog?sku=eq.${SKU}`, { method: 'DELETE' });
    if (userId) {
      await svc(`shop_members?user_id=eq.${userId}`, { method: 'DELETE' });
      await fetch(`${base}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: SVC });
    }
    console.log('cleaned up the test saree, its video, frames and the test member');
  });
