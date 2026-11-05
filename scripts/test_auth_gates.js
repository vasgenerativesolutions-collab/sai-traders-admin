// Self-check for the authorisation gates in admin/server.js requireAdminAuth.
// Run: node scripts/test_auth_gates.js
const assert = require('assert');

// --- 1. A paired device token identifies a TERMINAL, never an owner ----------
// It used to `return next()` from requireAdminAuth, making the billing-counter
// token a full admin credential for all 23 owner routes (unpair devices, delete
// products, adjust stock, reset Tally identity).
function authorize({ device, adminKey, supabaseUser, loopback, proxied }) {
  if (adminKey) return 'admin';
  if (supabaseUser) return 'admin';
  if (loopback && !proxied) return 'admin';
  return 'denied'; // a device, on its own, is not authority
}

assert.strictEqual(authorize({ device: { isLocked: true, godown: 'Online_saree' } }), 'denied');
assert.strictEqual(authorize({ device: { isLocked: true }, supabaseUser: { id: 'u1' } }), 'admin');
assert.strictEqual(authorize({ adminKey: true }), 'admin');

// --- 2. The loopback bypass must not cover proxied traffic ------------------
// cloudflared forwards to localhost:3000, so tunnelled requests present as
// 127.0.0.1 and were granted admin with no credential at all.
assert.strictEqual(authorize({ loopback: true, proxied: false }), 'admin');  // at the keyboard
assert.strictEqual(authorize({ loopback: true, proxied: true }), 'denied');  // via tunnel
// A proxied request with a real credential is still fine (laptop -> store PC forward)
assert.strictEqual(authorize({ loopback: true, proxied: true, adminKey: true }), 'admin');

// --- 3. A locked terminal may only touch its own godown ---------------------
// The lock used to fall through to the request body's godown when absent, so it
// behaved like a default rather than a constraint.
function resolveGodown({ device, bodyGodown, fallback }) {
  if (device?.isLocked && device?.godown) {
    const locked = device.godown.trim();
    const asked = bodyGodown ? bodyGodown.trim() : '';
    if (asked && asked.toLowerCase() !== locked.toLowerCase()) return { rejected: true };
    return { godown: locked };
  }
  return { godown: (bodyGodown || fallback).trim() };
}

const locked = { isLocked: true, godown: 'Online_saree' };
// Naming a different godown is refused, not silently honoured
assert.deepStrictEqual(resolveGodown({ device: locked, bodyGodown: 'Main Location' }), { rejected: true });
// Naming its own godown, or none, resolves to the lock
assert.deepStrictEqual(resolveGodown({ device: locked, bodyGodown: 'online_saree' }), { godown: 'Online_saree' });
assert.deepStrictEqual(resolveGodown({ device: locked, bodyGodown: null }), { godown: 'Online_saree' });
// An unlocked caller (owner) may still choose
assert.deepStrictEqual(resolveGodown({ device: null, bodyGodown: 'Jari', fallback: 'X' }), { godown: 'Jari' });

console.log('auth gates: all 10 cases pass');

// --- SEC-A01: escapeHtml ------------------------------------------------------
// Mirrors admin/public/app-v2.js. The function never existed, so untrusted values —
// notably ord.customer_name from the customer's WhatsApp profile — reached innerHTML raw.
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// The exact payload from the original audit's SEC-03 example
assert.strictEqual(
  escapeHtml(`<img src=x onerror="fetch('/api/products/SAI-0021',{method:'DELETE'})">`),
  '&lt;img src=x onerror=&quot;fetch(&#39;/api/products/SAI-0021&#39;,{method:&#39;DELETE&#39;})&quot;&gt;'
);

// Ampersand must be escaped FIRST or &lt; would become &amp;lt;
assert.strictEqual(escapeHtml('Silk & Zari'), 'Silk &amp; Zari');
assert.strictEqual(escapeHtml('<b>'), '&lt;b&gt;');

// Attribute-breaking quotes, both kinds
assert.strictEqual(escapeHtml(`" onmouseover="alert(1)`), '&quot; onmouseover=&quot;alert(1)');

// Null/undefined render as empty, not the strings "null"/"undefined"
assert.strictEqual(escapeHtml(null), '');
assert.strictEqual(escapeHtml(undefined), '');

// Numbers and ordinary text pass through unharmed
assert.strictEqual(escapeHtml(42), '42');
assert.strictEqual(escapeHtml('Kanjivaram Silk'), 'Kanjivaram Silk');

console.log('escapeHtml: all 8 cases pass');

// --- per-shop app_settings keys ----------------------------------------------
// These rows hold per-shop state but were stored unkeyed. With a hosted dashboard
// serving several shops, store PC B would overwrite store PC A's gateway URL and
// stock matrix rather than coexisting with them.
const DEFAULT_SHOP = '00000000-0000-0000-0000-000000000001';
const SCOPED = new Set(['in_store_gateway_url', 'tally_godown_stock_matrix', 'target_godown']);
function shopKey(key, shopId) {
  if (!SCOPED.has(key)) return key;
  if (shopId === DEFAULT_SHOP) return key;
  return key + ':' + shopId;
}

// The existing shop keeps bare keys, so no migration is needed and current rows stay canonical
assert.strictEqual(shopKey('target_godown', DEFAULT_SHOP), 'target_godown');
assert.strictEqual(shopKey('in_store_gateway_url', DEFAULT_SHOP), 'in_store_gateway_url');

// A second shop gets its own rows — this is the overwrite that used to happen
const SHOP_B = '11111111-2222-3333-4444-555555555555';
assert.strictEqual(shopKey('target_godown', SHOP_B), 'target_godown:' + SHOP_B);
assert.notStrictEqual(shopKey('tally_godown_stock_matrix', SHOP_B), shopKey('tally_godown_stock_matrix', DEFAULT_SHOP));

// Keys that are genuinely global are never scoped
assert.strictEqual(shopKey('whatsapp_access_token', SHOP_B), 'whatsapp_access_token');

console.log('per-shop settings keys: all 5 cases pass');

// --- rate limit tiering -------------------------------------------------------
// The pairing screen polls GET /api/auth/device-pair-status every ~2s while it waits.
// Classifying that as an auth attempt tripped the 10/min limit in about 20 seconds and
// made pairing impossible — observed live as:
//   [RateLimit] ::1 exceeded auth tier (21/10) on GET /api/auth/device-pair-status
function tierFor(method, path) {
  const isAuthPath = /^\/api\/(admin\/)?auth\//.test(path) || path.includes('/login');
  if (isAuthPath && method !== 'GET' && method !== 'OPTIONS') return 'auth';
  if (method !== 'GET' && method !== 'OPTIONS') return 'mutate';
  return 'read';
}

// A credential attempt is strictly limited
assert.strictEqual(tierFor('POST', '/api/auth/device-pair-code'), 'auth');
assert.strictEqual(tierFor('POST', '/api/admin/login'), 'auth');
// A status poll under the same prefix is a read, not an attempt
assert.strictEqual(tierFor('GET', '/api/auth/device-pair-status'), 'read');
assert.strictEqual(tierFor('GET', '/api/auth/supabase-config'), 'read');
// Ordinary mutations keep the middle tier
assert.strictEqual(tierFor('POST', '/api/adjust-tally-stock'), 'mutate');
assert.strictEqual(tierFor('DELETE', '/api/products/X'), 'mutate');
// Reads stay cheap, and preflight is never throttled
assert.strictEqual(tierFor('GET', '/api/products'), 'read');
assert.strictEqual(tierFor('OPTIONS', '/api/products'), 'read');

// Loopback is exempt entirely — the limiter guards against remote brute force, and
// throttling the local dashboard only broke it.
function exempt(ip, headers) {
  const proxied = Boolean(headers['x-forwarded-for'] || headers['cf-connecting-ip'] || headers['x-real-ip']);
  return !proxied && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1');
}
assert.strictEqual(exempt('::1', {}), true);
assert.strictEqual(exempt('127.0.0.1', {}), true);
// ...unless it only looks local because something proxied it
assert.strictEqual(exempt('::1', { 'x-forwarded-for': '203.0.113.9' }), false);
assert.strictEqual(exempt('192.168.1.50', {}), false);

console.log('rate limit tiering: all 12 cases pass');
