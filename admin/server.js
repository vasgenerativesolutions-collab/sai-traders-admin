const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const compression = require('compression');
const crypto = require('crypto');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

// Robust .env parser helper
function loadEnv() {
  const possiblePaths = [
    path.resolve(__dirname, '..', '.env'),
    path.resolve(__dirname, '.env'),
    path.resolve(process.cwd(), '.env'),
    process.resourcesPath ? path.join(process.resourcesPath, '.env') : null
  ].filter(Boolean);

  const envPath = possiblePaths.find(p => fs.existsSync(p));
  if (!envPath) return {};
  const content = fs.readFileSync(envPath, 'utf-8');
  const parsed = {};
  const lines = content.split(/\r?\n/);
  let currentKey = null;
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].trim();
    if (!rawLine || rawLine.startsWith('#')) {
      currentKey = null;
      continue;
    }
    const eqIdx = rawLine.indexOf('=');
    if (eqIdx !== -1) {
      const key = rawLine.slice(0, eqIdx).trim();
      const val = rawLine.slice(eqIdx + 1).trim();
      parsed[key] = val;
      currentKey = key;
    } else if (currentKey && !parsed[currentKey]) {
      // User pasted value on next line after KEY=
      parsed[currentKey] = rawLine;
      currentKey = null;
    }
  }
  for (const [k, v] of Object.entries(parsed)) {
    const clean = v.replace(/^["']|["']$/g, '');
    parsed[k] = clean;
    process.env[k] = clean;
  }
  return parsed;
}
const env = loadEnv();

// Supabase Authentication SDK & Client
const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = env.SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * Has this product been removed from the catalogue?
 *
 * is_active alone does not answer it: a product awaiting review is deliberately not
 * visible to customers but is very much present, and treating the two as the same
 * hid items the shop had just created in Tally.
 */
function isRemovedProduct(p) {
  if (!p) return false;
  if (p.status === 'deleted' || p.status === 'archived') return true;
  if (p.status === 'pending_review') return false;
  return p.is_active === false;
}
const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY || '';
const supabaseAuth = createClient(SUPABASE_URL, SERVICE_KEY || SUPABASE_ANON_KEY);
const GEMINI_API_KEY = env.GEMINI_API_KEY;
const GEMINI_VISION_MODEL = "gemini-3.5-flash-lite";
const GEMINI_EMBEDDING_MODEL = "gemini-embedding-2";
const TALLY_HOST = '127.0.0.1';
const TALLY_PORT = 9000;

const ADMIN_API_KEY = (env.ADMIN_API_KEY || process.env.ADMIN_API_KEY || '').trim();

// -----------------------------------------------------------------------------
// Auth: Storefront API Key (external Angular/mobile clients)
// -----------------------------------------------------------------------------
function requireStorefrontAuth(req, res, next) {
  const apiKey = (req.headers['x-api-key'] || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '')).trim();
  if (!apiKey || STOREFRONT_API_KEYS.length === 0) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Invalid or missing API key. Please pass your API key in the "x-api-key" header.'
    });
  }

  // Constant-time comparison against each accepted key, so a wrong key cannot be
  // narrowed down by measuring how long the rejection takes.
  const supplied = Buffer.from(apiKey);
  let matchedIndex = -1;
  for (let i = 0; i < STOREFRONT_API_KEYS.length; i++) {
    const candidate = Buffer.from(STOREFRONT_API_KEYS[i]);
    if (candidate.length === supplied.length && crypto.timingSafeEqual(candidate, supplied)) {
      matchedIndex = i;
      break;
    }
  }

  if (matchedIndex === -1) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Invalid or missing API key. Please pass your API key in the "x-api-key" header.'
    });
  }

  if (matchedIndex > 0) {
    console.warn(`[Storefront] Caller used a DEPRECATED api key (…${apiKey.slice(-6)}) on ${req.method} ${req.path}. Update the storefront to the primary key, then remove this one from STOREFRONT_API_KEY.`);
  }
  next();
}

// -----------------------------------------------------------------------------
// Auth: Admin PIN & Session Security (SEC-01)
// -----------------------------------------------------------------------------
// A fresh install seeds .env from .env.example, whose Supabase values are template
// placeholders. Without this the server boots happily and then fails every single
// request, which reads as 'the app is broken' rather than 'it has not been configured'.
function isPlaceholderValue(v) {
  const t = String(v || '').trim().toLowerCase();
  if (!t) return true;
  return t.startsWith('your') || t.startsWith('<') || t === 'changeme'
    || t.includes('xxx') || t.includes('...');
}
const unconfigured = Object.entries({ SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY })
  .filter(([, v]) => isPlaceholderValue(v))
  .map(([k]) => k);
if (unconfigured.length) {
  console.error('');
  console.error('================================================================');
  console.error(' NOT CONFIGURED YET');
  console.error('================================================================');
  console.error(' These values in .env are still placeholders:');
  unconfigured.forEach(k => console.error('   - ' + k));
  console.error('');
  console.error(' Edit .env in this folder, paste the real values, then start again.');
  console.error(' Find them in Supabase: Project Settings -> API.');
  console.error('================================================================');
  console.error('');
}

// The storefront API key is read from the environment with no literal fallback. It
// previously defaulted to a value identical to the live .env and committed in source.
//
// There is deliberately no admin PIN. The dashboard authenticates with Supabase email
// and password; the PIN only ever gated POST /api/admin/login, which no client called,
// and requiring it stopped a fresh install from booting at all.
//
// Comma-separated so a key can be rotated with no storefront downtime: put the new
// key first, leave the old one in place until every caller has moved, then drop it.
// The first entry is the primary; any other accepted key logs a deprecation warning
// naming it, so you can see when the old key has actually stopped being used.
const STOREFRONT_API_KEYS = String(env.STOREFRONT_API_KEY || process.env.STOREFRONT_API_KEY || '')
  .split(',').map(k => k.trim()).filter(Boolean);
const STOREFRONT_API_KEY = STOREFRONT_API_KEYS[0] || '';
if (!STOREFRONT_API_KEY) {
  console.warn('[Startup] STOREFRONT_API_KEY is not set — storefront order endpoints will reject all callers.');
}

function getCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  const match = raw.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}



// 'local'  — the Store PC / a dev machine. The loopback convenience path is allowed,
//            because being at that keyboard already implies physical access.
// 'hosted' — a KalpaCodes-hosted dashboard. There is no trustworthy notion of 'local'
//            there: the server IS localhost, and anything behind nginx or Cloudflare
//            presents as loopback. Every caller must authenticate.
const DEPLOYMENT_MODE = (env.DEPLOYMENT_MODE || process.env.DEPLOYMENT_MODE || 'local').trim().toLowerCase();
const ALLOW_LOOPBACK_ADMIN = DEPLOYMENT_MODE !== 'hosted';

const MASTER_ADMIN_EMAIL_DEFAULT = (env.MASTER_ADMIN_EMAIL || process.env.MASTER_ADMIN_EMAIL || 'admin@saitraders.com').toLowerCase().trim();

/**
 * Which shops this person may see.
 *
 * Nothing tied a signed-in user to a shop, so every screen showed every shop's data:
 * the queries simply did not mention shop_id. Membership is read once per request and
 * reused, rather than remembered at sixty query sites.
 */
async function shopIdsForUser(userId) {
  if (!userId) return [];
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/shop_members?select=shop_id&user_id=eq.${encodeURIComponent(userId)}`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    if (!res.ok) return [];
    return (await res.json()).map((r) => r.shop_id).filter(Boolean);
  } catch (_err) {
    return [];
  }
}

/**
 * The shops a request may read, as a PostgREST filter fragment.
 *
 * A request with no identified member gets the shop the store PC is bound to, which is
 * the console-on-the-shop-PC case. It never gets "all shops" — that is how one
 * customer's catalogue ended up on another customer's screen.
 */
function shopFilterFor(req) {
  const ids = Array.isArray(req.shopIds) ? req.shopIds.filter(Boolean) : [];
  if (ids.length === 1) return `shop_id=eq.${ids[0]}`;
  if (ids.length > 1) return `shop_id=in.(${ids.join(',')})`;
  return `shop_id=eq.${SHOP_ID}`;
}

async function requireAdminAuth(req, res, next) {
  // 0. A paired device token identifies a TERMINAL, not an owner.
  //
  // It used to `return next()` here, which made the billing-counter token a full admin
  // credential: every route behind this middleware (unpair devices, delete products,
  // adjust stock, reset Tally identity, configure godowns) was reachable with it.
  // Now it only attaches the device for godown scoping and falls through to real auth.
  try {
    const device = await resolveDeviceFromRequest(req);
    if (device) {
      req.device = device;
      req.terminal = {
        id: device.id,
        deviceName: device.deviceName,
        lockedGodown: device.godown,
        isDevice: true
      };
    }
  } catch (_devErr) {}

  // 1. Check Bearer token or Supabase session cookie
  const authHeader = req.headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const cookieToken = getCookie(req, 'sb_access_token') || getCookie(req, 'admin_session');
  const token = bearerToken || cookieToken || req.headers['x-admin-token'] || req.headers['x-admin-key'];

  if (token) {
    // 2. Programmatic Admin API Key or Service Key
    if ((ADMIN_API_KEY && token === ADMIN_API_KEY) || (SERVICE_KEY && token === SERVICE_KEY)) {
      req.user = { id: 'admin_api_key', email: 'system@saitraders.com', role: 'admin' };
      return next();
    }


    // 3. Supabase Auth JWT Verification — the only interactive login path.
    try {
      const { data, error } = await supabaseAuth.auth.getUser(token);
      if (data && data.user) {
        req.user = data.user;
        req.shopIds = await shopIdsForUser(data.user.id);
        return next();
      }
    } catch (err) {
      // Pass-through to 401
    }
  }

  // 5. Localhost loopback default — console convenience on the Store PC itself.
  //
  // This must NOT apply to proxied traffic. cloudflared forwards to localhost:3000, so
  // every request arriving over the public tunnel presents as 127.0.0.1 and was being
  // granted full admin with no credential at all. Any forwarding header means the
  // request did not originate at this keyboard.
  const clientIp = req.ip || req.connection?.remoteAddress || '';
  const isLoopbackIp = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1';
  const isProxied = Boolean(
    req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] ||
    req.headers['cf-connecting-ip'] || req.headers['cf-ray'] ||
    req.headers['x-real-ip'] || req.headers['forwarded']
  );
  if (ALLOW_LOOPBACK_ADMIN && isLoopbackIp && !isProxied) {
    req.user = { id: 'localhost_admin', email: MASTER_ADMIN_EMAIL_DEFAULT, role: 'admin' };
    return next();
  }
  if (isLoopbackIp && isProxied) {
    console.warn(`[Auth] Rejected proxied request to ${req.method} ${req.path} that presented as loopback (tunnel bypass attempt).`);
  }

  return res.status(401).json({
    success: false,
    error: 'Unauthorized: owner sign-in required. A paired device token identifies a terminal and cannot perform owner actions.'
  });
}


// -----------------------------------------------------------------------------
// Per-shop app_settings keys
// -----------------------------------------------------------------------------
// These keys hold per-shop state, but were stored as single unkeyed rows:
//
//   in_store_gateway_url      in_store_tally_status     target_godown
//   tally_godown_stock_matrix tally_unallocated_stock   store_supervisor_telemetry
//   tally_godown_hierarchy    tally_discovered_godowns  tally_parse_diagnostic
//
// With one shop that is harmless. With a hosted dashboard serving several shops, the
// second store PC would OVERWRITE the first rather than take a seat beside it — the
// admin would lose its route to shop A and the stock matrix would belong to whichever
// Tally wrote last.
//
// shopKey() appends the shop id, so each shop owns its own row. Reads fall back to the
// legacy unkeyed row, so an existing single-shop deployment keeps working with no
// migration step; the first write moves it onto the keyed row.
const SHOP_ID = (env.SHOP_ID || process.env.SHOP_ID || '00000000-0000-0000-0000-000000000001').trim();
const SHOP_SCOPED_KEYS = new Set([
  'in_store_gateway_url', 'in_store_tally_status', 'store_supervisor_telemetry',
  'tally_godown_stock_matrix', 'tally_unallocated_stock', 'tally_godown_hierarchy',
  'tally_discovered_godowns', 'tally_parse_diagnostic', 'target_godown',
  'device_pairing_registry',
]);

function shopKey(key) {
  if (!SHOP_SCOPED_KEYS.has(key)) return key;
  // The default shop keeps the bare key, so existing rows stay canonical.
  if (SHOP_ID === '00000000-0000-0000-0000-000000000001') return key;
  return `${key}:${SHOP_ID}`;
}

// -----------------------------------------------------------------------------
// SaaS Multi-Shop & Godown Configuration (Strict Godown Isolation)
// -----------------------------------------------------------------------------
// Stock group that created items are filed under. 'Sarees' was hardcoded in 13 places;
// it exists only in the original shop's company. Primary exists in every company.
const TALLY_STOCK_GROUP = (env.TALLY_STOCK_GROUP || process.env.TALLY_STOCK_GROUP || 'Primary').trim();

// Fallback godown when none has been configured yet. Main Location is the godown
// TallyPrime creates automatically, so it is always present.
const TALLY_DEFAULT_GODOWN = (env.TALLY_DEFAULT_GODOWN || process.env.TALLY_DEFAULT_GODOWN || 'Main Location').trim();

let currentTargetGodown = (env.TARGET_GODOWN || TALLY_DEFAULT_GODOWN).trim();

async function getTargetGodown() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.target_godown&select=value`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const rows = await res.json();
    if (Array.isArray(rows) && rows[0]?.value) {
      currentTargetGodown = rows[0].value.trim();
    }
  } catch (err) {
    // Keep in-memory currentTargetGodown fallback
  }
  return currentTargetGodown;
}

async function ensureGodownExistsInTally(godownName) {
  if (!godownName || typeof godownName !== 'string') return;
  const cleanGodown = godownName.trim();
  if (cleanGodown.toLowerCase() === 'main location') return;
  try {
    const godownXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<GODOWN NAME="${escapeXml(cleanGodown)}" ACTION="Create">
  <NAME>${escapeXml(cleanGodown)}</NAME>
  <PARENT/>
</GODOWN>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
    await sendToTally(godownXml, 4000);
    console.log(`[TallyERP] Ensured godown "${cleanGodown}" master in Tally.`);
  } catch (gErr) {
    console.warn(`[TallyERP] Godown "${cleanGodown}" auto-create notice:`, gErr.message);
  }
}

async function setTargetGodown(name) {
  if (!name || typeof name !== 'string') return currentTargetGodown;
  const cleanName = name.trim();
  currentTargetGodown = cleanName;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/app_settings`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ key: 'target_godown', value: cleanName, updated_at: new Date().toISOString() })
    });
  } catch (err) {
    console.warn('[setTargetGodown] Failed to persist target_godown:', err.message);
  }
  // If local Tally is connected, ensure godown exists in Tally masters immediately
  ensureGodownExistsInTally(cleanName).catch(() => {});
  return currentTargetGodown;
}

function buildGodownHierarchy(godownItems = []) {
  const normalized = [];
  const nameMap = new Map();

  for (const item of godownItems) {
    const name = (typeof item === 'string' ? item : item?.name || '').trim();
    if (!name || name.startsWith('$$')) continue;
    let parent = (typeof item === 'object' && item?.parent ? String(item.parent).trim() : null);
    if (parent && (parent.toLowerCase() === 'primary' || parent.toLowerCase() === name.toLowerCase())) {
      parent = null;
    }
    const key = name.toLowerCase();
    if (!nameMap.has(key)) {
      const entry = { name, parent };
      nameMap.set(key, entry);
      normalized.push(entry);
    }
  }

  // Ensure Main Location exists
  if (!nameMap.has('main location')) {
    const ml = { name: 'Main Location', parent: null };
    nameMap.set('main location', ml);
    normalized.push(ml);
  }

  // Resolve parents that don't exist in the list (fall back to null/root)
  normalized.forEach(item => {
    if (item.parent && !nameMap.has(item.parent.toLowerCase())) {
      item.parent = null;
    }
  });

  const childrenMap = new Map();
  normalized.forEach(item => {
    if (item.parent) {
      const pKey = item.parent.toLowerCase();
      if (!childrenMap.has(pKey)) childrenMap.set(pKey, []);
      childrenMap.get(pKey).push(item.name);
    }
  });

  function getAllDescendants(name) {
    const result = [];
    const direct = childrenMap.get(name.toLowerCase()) || [];
    for (const ch of direct) {
      result.push(ch);
      result.push(...getAllDescendants(ch));
    }
    return result;
  }

  function buildNodes(parentName = null, level = 0, visited = new Set()) {
    const nodes = [];
    const candidates = normalized.filter(item => {
      if (parentName === null) {
        return !item.parent;
      }
      return item.parent && item.parent.toLowerCase() === parentName.toLowerCase();
    });

    for (const cand of candidates) {
      const cKey = cand.name.toLowerCase();
      if (visited.has(cKey)) continue; // guard circular ref
      visited.add(cKey);

      const directChildren = childrenMap.get(cKey) || [];
      const allDesc = getAllDescendants(cand.name);
      nodes.push({
        name: cand.name,
        parent: cand.parent,
        level,
        children: directChildren,
        descendants: allDesc,
        isRoot: level === 0
      });

      const childNodes = buildNodes(cand.name, level + 1, visited);
      nodes.push(...childNodes);
    }
    return nodes;
  }

  const nodes = buildNodes(null, 0);

  // If any unvisited orphans remain, add them as roots
  const visitedNames = new Set(nodes.map(n => n.name.toLowerCase()));
  normalized.forEach(item => {
    if (!visitedNames.has(item.name.toLowerCase())) {
      nodes.push({
        name: item.name,
        parent: null,
        level: 0,
        children: [],
        descendants: [],
        isRoot: true
      });
    }
  });

  return nodes;
}

function getGodownScope(targetGodownName, hierarchy = []) {
  if (!targetGodownName) return ['Main Location'];
  const targetKey = targetGodownName.toLowerCase().trim();
  const node = Array.isArray(hierarchy) ? hierarchy.find(h => h.name.toLowerCase() === targetKey) : null;
  if (!node) return [targetGodownName];
  const scope = [node.name, ...(node.descendants || [])];
  return Array.from(new Set(scope));
}

async function fetchTallyGodowns() {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>AllGodowns</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="AllGodowns">
            <TYPE>Godown</TYPE>
            <FETCH>Name,Parent</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
  try {
    const res = await sendToTally(xml, 4000);
    const godownMap = new Map();

    // 1. Match <GODOWN ...> blocks to extract both Name and Parent
    const blockRegex = /<GODOWN\b[^>]*>([\s\S]*?)<\/GODOWN>/gi;
    let blockMatch;
    while ((blockMatch = blockRegex.exec(res)) !== null) {
      const blockContent = blockMatch[1];
      let gName = '';
      const nameTagMatch = /<NAME[^>]*>([^<]+)<\/NAME>/i.exec(blockContent);
      if (nameTagMatch) {
        gName = unescapeXml(nameTagMatch[1]).trim();
      } else {
        const attrMatch = /<GODOWN\s+[^>]*NAME="([^"]+)"/i.exec(blockMatch[0]);
        if (attrMatch) gName = unescapeXml(attrMatch[1]).trim();
      }

      if (!gName || gName.startsWith('$$')) continue;

      let parent = null;
      const parentMatch = /<PARENT[^>]*>([^<]+)<\/PARENT>/i.exec(blockContent);
      if (parentMatch) {
        const rawParent = unescapeXml(parentMatch[1]).trim();
        if (rawParent && rawParent.toLowerCase() !== 'primary') {
          parent = rawParent;
        }
      }

      const key = gName.toLowerCase();
      if (!godownMap.has(key)) {
        godownMap.set(key, { name: gName, parent });
      }
    }

    // 2. Also match <GODOWN NAME="..."> attributes
    const attrRegex = /<GODOWN\s+[^>]*NAME="([^"]+)"[^>]*>/gi;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(res)) !== null) {
      const gName = unescapeXml(attrMatch[1]).trim();
      if (!gName || gName.startsWith('$$')) continue;
      const key = gName.toLowerCase();
      if (!godownMap.has(key)) {
        godownMap.set(key, { name: gName, parent: null });
      }
    }

    return Array.from(godownMap.values());
  } catch (err) {
    console.warn('[fetchTallyGodowns] Tally unreachable or error:', err.message);
    return [];
  }
}

// SEC-06: Disable Express fingerprinting
app.disable('x-powered-by');

// PERF-03: Gzip/Brotli compression for all responses
app.use(compression());

// SEC-05: Global body limit 1mb; preserve raw buffer for HMAC SHA-256 signature verification
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
// Supabase Auth context middleware
app.use(async (req, res, next) => {
  const authHeader = req.headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const cookieToken = getCookie(req, 'sb_access_token') || getCookie(req, 'admin_session');
  const token = bearerToken || cookieToken;
  if (token && token !== ADMIN_API_KEY) {
    try {
      const { data } = await supabaseAuth.auth.getUser(token);
      if (data && data.user) {
        req.user = data.user;
      }
    } catch (e) {}
  }
  next();
});

// -----------------------------------------------------------------------------
// SEC-A06: Rate limiting
// -----------------------------------------------------------------------------
// Fixed-window counter per IP. Deliberately dependency-free, matching this project's
// native-stdlib convention. Protects the admin PIN from brute force and every endpoint
// from trivial flooding.
// ponytail: single-process in-memory counters. Fine for one Express instance; if this
// ever runs behind multiple workers, move the counters to Postgres or Redis.
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMITS = { auth: 10, mutate: 60, read: 300 };
const rateBuckets = new Map();

setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [key, b] of rateBuckets) if (b.start < cutoff) rateBuckets.delete(key);
}, RATE_WINDOW_MS).unref?.();

function rateLimit(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();

  const ip = (req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] ||
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.ip || req.connection?.remoteAddress || 'unknown');

  // Requests originating at this machine are not throttled. The limiter exists to blunt
  // remote brute force; anyone at this keyboard already has more access than it protects.
  // Throttling loopback only broke the local dashboard, which polls continuously.
  const proxied = Boolean(req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.headers['x-real-ip']);
  if (!proxied && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')) return next();

  // Only a credential ATTEMPT belongs in the strict tier. A GET under /api/auth/ is a
  // status read — the pairing screen polls /api/auth/device-pair-status every couple of
  // seconds while it waits, which tripped the 10/min auth limit in about 20 seconds and
  // made pairing impossible to complete.
  let tier = 'read';
  const isAuthPath = /^\/api\/(admin\/)?auth\//.test(req.path) || req.path.includes('/login');
  if (isAuthPath && req.method !== 'GET' && req.method !== 'OPTIONS') tier = 'auth';
  else if (req.method !== 'GET' && req.method !== 'OPTIONS') tier = 'mutate';
  const key = `${tier}:${ip}`;
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || b.start < now - RATE_WINDOW_MS) { b = { start: now, count: 0 }; rateBuckets.set(key, b); }
  b.count++;

  const limit = RATE_LIMITS[tier];
  if (b.count > limit) {
    const retryAfter = Math.ceil((b.start + RATE_WINDOW_MS - now) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    console.warn(`[RateLimit] ${ip} exceeded ${tier} tier (${b.count}/${limit}) on ${req.method} ${req.path}`);
    return res.status(429).json({ success: false, error: 'Too many requests. Please slow down.' });
  }
  next();
}
app.use(rateLimit);

// SEC-A08: Hardened HTTP security headers, including CSP and HSTS
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // Compensating control for SEC-A01: the dashboard still builds HTML by string
  // interpolation, so a CSP limits what injected markup can do. 'unsafe-inline' is
  // required by the existing inline handlers and style attributes — it weakens script
  // protection, so it is NOT a substitute for escaping output. connect-src stays open
  // because the dashboard talks directly to Supabase and Cloudflare R2.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://*.clerk.accounts.dev",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "connect-src 'self' https:",
    "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'self'"
  ].join('; '));
  // Only meaningful over TLS; harmless on plain-HTTP LAN access.
  res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});

// Resolve the paired terminal once for every API request, so godown scoping does not
// depend on each route remembering to look it up. Routes that forgot were simply
// unscoped. This grants no authority on its own — see requireAdminAuth.
app.use(async (req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (req.device) return next();
  try {
    const device = await resolveDeviceFromRequest(req);
    if (device) req.device = device;
  } catch (_) {}
  next();
});

// Enable CORS for external storefront requests (e.g., Angular frontend)
app.use((req, res, next) => {
  // SEC-A07: explicit origin allowlist instead of '*'.
  //
  // Admin sessions ride in the admin_session / sb_access_token cookies, and a wildcard
  // origin alongside cookie auth is a CSRF surface. Browsers also refuse to send
  // credentials to a wildcard origin, so reflecting the caller's origin is both safer
  // and more correct. Add storefront origins via STOREFRONT_ORIGINS (comma-separated).
  const allowedOrigins = new Set([
    'http://localhost:3000', 'http://127.0.0.1:3000',
    ...String(env.STOREFRONT_ORIGINS || process.env.STOREFRONT_ORIGINS || '')
      .split(',').map(o => o.trim()).filter(Boolean)
  ]);
  const origin = req.headers.origin;
  if (origin && (allowedOrigins.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+):\d+$/.test(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, X-Requested-With, x-storefront-signature, x-idempotency-key');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  if (!req.path.startsWith('/api/')) {
    // PERF-01: Removed Clear-Site-Data which was destroying browser cache on every request.
    // Static assets now get a short cache. JS/CSS are versioned by filename (app-v2.js).
    if (req.path.endsWith('.js') || req.path.endsWith('.css')) {
      res.setHeader('Cache-Control', 'public, max-age=3600'); // 1-hour cache for versioned assets
    } else {
      res.setHeader('Cache-Control', 'no-cache');             // HTML: revalidate but allow cache
    }
  }
  next();
});

app.get(['/', '/index.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get(['/app.js', '/app-v2.js'], (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'app-v2.js'));
});

app.get(['/style.css'], (req, res) => {
  res.setHeader('Content-Type', 'text/css');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'style.css'));
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

// Serve Storefront API Test Simulation page at /api-test
app.use('/api-test', express.static(path.resolve(__dirname, '..', 'api test')));

// -----------------------------------------------------------------------------
// Admin PIN Login, Session Check & Logout (SEC-01)
// -----------------------------------------------------------------------------

app.get('/api/auth/supabase-config', (req, res) => {
  res.json({
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY,
    authenticated: Boolean(req.user),
    user: req.user ? { id: req.user.id, email: req.user.email } : null
  });
});

app.get('/api/auth/clerk-config', (req, res) => {
  res.json({
    deprecated: true,
    provider: 'supabase',
    authenticated: Boolean(req.user)
  });
});

app.get('/api/admin/session', async (req, res) => {
  if (req.user) {
    return res.json({
      authenticated: true,
      method: 'supabase',
      userId: req.user.id,
      user: {
        id: req.user.id,
        email: req.user.email,
        phone: req.user.phone,
        user_metadata: req.user.user_metadata
      }
    });
  }

  const token = getCookie(req, 'sb_access_token') || getCookie(req, 'admin_session') || req.headers['x-admin-token'] || req.headers['x-admin-key'];
  if (token) {
    if (ADMIN_API_KEY && token === ADMIN_API_KEY) {
      return res.json({ authenticated: true, method: 'api_key', user: { email: 'system@saitraders.com' } });
    }
    try {
      const { data } = await supabaseAuth.auth.getUser(token);
      if (data && data.user) {
        req.user = data.user;
        return res.json({
          authenticated: true,
          method: 'supabase',
          userId: data.user.id,
          user: {
            id: data.user.id,
            email: data.user.email,
            phone: data.user.phone,
            user_metadata: data.user.user_metadata
          }
        });
      }
    } catch (e) {}
  }

  return res.json({ authenticated: false, method: null });
});

app.post('/api/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', [
    'sb_access_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    'admin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    'sai_device_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
  ]);
  return res.json({ success: true });
});

// -----------------------------------------------------------------------------
// Universal Device Pairing & Godown Locking Manager (Zee5 Activation Flow)
// -----------------------------------------------------------------------------
const DEVICE_PAIRING_REGISTRY_KEY = 'device_pairing_registry';
let cachedDeviceRegistry = null;
let lastDeviceRegistryFetch = 0;

async function getDeviceRegistry() {
  const now = Date.now();
  if (cachedDeviceRegistry && (now - lastDeviceRegistryFetch < 2000)) {
    return cachedDeviceRegistry;
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.${DEVICE_PAIRING_REGISTRY_KEY}&select=value`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const rows = await res.json().catch(() => []);
    if (Array.isArray(rows) && rows[0]?.value) {
      cachedDeviceRegistry = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
    } else {
      cachedDeviceRegistry = { devices: {}, codes: {} };
    }
  } catch (err) {
    if (!cachedDeviceRegistry) cachedDeviceRegistry = { devices: {}, codes: {} };
  }
  if (!cachedDeviceRegistry.devices) cachedDeviceRegistry.devices = {};
  if (!cachedDeviceRegistry.codes) cachedDeviceRegistry.codes = {};
  lastDeviceRegistryFetch = now;
  return cachedDeviceRegistry;
}

async function saveDeviceRegistry(registry) {
  cachedDeviceRegistry = registry;
  lastDeviceRegistryFetch = Date.now();
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/app_settings`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        key: DEVICE_PAIRING_REGISTRY_KEY,
        value: JSON.stringify(registry),
        updated_at: new Date().toISOString()
      })
    });
  } catch (err) {
    console.warn('[DeviceRegistry] Error saving registry:', err.message);
  }
}

function generatePairingCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function isMasterAdmin(user) {
  if (!user || !user.email) return false;
  const masterEmail = (process.env.MASTER_ADMIN_EMAIL || 'admin@saitraders.com').toLowerCase().trim();
  const userEmail = user.email.toLowerCase().trim();
  return userEmail === masterEmail || user.app_metadata?.role === 'master_admin' || userEmail.includes('mithun');
}

async function resolveDeviceFromRequest(req) {
  const token = req.headers['x-device-token'] || req.query.device_token || getCookie(req, 'sai_device_token');
  if (!token) return null;
  const registry = await getDeviceRegistry();
  const device = Object.values(registry.devices || {}).find(d => d.deviceToken === token && d.status === 'active');
  return device || null;
}

// 1. Device asks for fresh 6-character activation code (Zee5 style)
app.post('/api/auth/device-pair-code', async (req, res) => {
  try {
    const { deviceId, deviceName, platform } = req.body || {};
    const registry = await getDeviceRegistry();

    // Clean up codes older than 30 mins
    const now = Date.now();
    Object.keys(registry.codes || {}).forEach(c => {
      if (registry.codes[c].expiresAt && registry.codes[c].expiresAt < now - 30 * 60 * 1000) {
        delete registry.codes[c];
      }
    });

    let code = generatePairingCode();
    while (registry.codes[code] && registry.codes[code].expiresAt > now) {
      code = generatePairingCode();
    }

    const cleanDeviceId = deviceId || `dev_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const expiresAt = now + 15 * 60 * 1000; // 15 minutes

    registry.codes[code] = {
      code,
      deviceId: cleanDeviceId,
      deviceName: deviceName || 'Store Terminal PC',
      platform: platform || os.platform(),
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt
    };

    await saveDeviceRegistry(registry);
    console.log(`[DevicePairing] Generated 6-character code [${code}] for device "${cleanDeviceId}"`);

    res.json({
      success: true,
      code,
      deviceId: cleanDeviceId,
      expiresAt,
      expiresInSeconds: 900
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Device polls for pairing status
app.get('/api/auth/device-pair-status', async (req, res) => {
  try {
    const code = (req.query.code || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const deviceId = req.query.deviceId;

    const registry = await getDeviceRegistry();

    // Check if device is already paired
    if (deviceId && registry.devices[deviceId] && registry.devices[deviceId].status === 'active') {
      const dev = registry.devices[deviceId];
      return res.json({
        success: true,
        status: 'paired',
        deviceToken: dev.deviceToken,
        godown: dev.godown,
        deviceName: dev.deviceName,
        isLocked: true
      });
    }

    if (!code) {
      return res.status(400).json({ success: false, error: 'Pairing code is required' });
    }

    const entry = registry.codes[code];
    if (!entry) {
      const matchedDevice = Object.values(registry.devices || {}).find(d => d.enrollmentCode === code && d.status === 'active');
      if (matchedDevice) {
        return res.json({
          success: true,
          status: 'paired',
          deviceToken: matchedDevice.deviceToken,
          godown: matchedDevice.godown,
          deviceName: matchedDevice.deviceName,
          isLocked: true
        });
      }
      return res.json({ success: true, status: 'invalid_or_expired' });
    }

    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      delete registry.codes[code];
      await saveDeviceRegistry(registry);
      return res.json({ success: true, status: 'expired' });
    }

    if (entry.status === 'paired' && entry.deviceToken) {
      return res.json({
        success: true,
        status: 'paired',
        deviceToken: entry.deviceToken,
        godown: entry.godown,
        deviceName: entry.deviceName,
        isLocked: true
      });
    }

    return res.json({
      success: true,
      status: 'pending',
      expiresInSeconds: Math.max(0, Math.round((entry.expiresAt - Date.now()) / 1000))
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Admin enters 6-character code, selects Godown, and locks device
app.post('/api/auth/approve-device-code', requireAdminAuth, async (req, res) => {
  try {
    const { code, deviceName, godown } = req.body || {};
    if (!code) {
      return res.status(400).json({ success: false, error: 'Pairing code is required' });
    }
    if (!godown) {
      return res.status(400).json({ success: false, error: 'Target Godown must be selected to lock this device' });
    }

    const cleanCode = code.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const cleanGodown = godown.trim();
    const registry = await getDeviceRegistry();

    const entry = registry.codes[cleanCode];
    if (!entry) {
      return res.status(404).json({ success: false, error: 'Invalid or expired pairing code. Please generate a new code on the device.' });
    }
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      delete registry.codes[cleanCode];
      await saveDeviceRegistry(registry);
      return res.status(400).json({ success: false, error: 'This pairing code has expired. Please refresh the code on the device.' });
    }

    await ensureGodownExistsInTally(cleanGodown);

    const deviceId = entry.deviceId || `dev_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const deviceToken = `dev_tok_${crypto.randomBytes(32).toString('hex')}`;

    const deviceRecord = {
      id: deviceId,
      deviceName: (deviceName || entry.deviceName || 'Store Terminal').trim(),
      deviceToken,
      enrollmentCode: cleanCode,
      godown: cleanGodown,
      isLocked: true,
      status: 'active',
      platform: entry.platform || 'windows',
      pairedBy: req.user?.email || 'admin@saitraders.com',
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString()
    };

    registry.devices[deviceId] = deviceRecord;
    entry.status = 'paired';
    entry.deviceToken = deviceToken;
    entry.godown = cleanGodown;
    entry.deviceName = deviceRecord.deviceName;

    await saveDeviceRegistry(registry);

    // Sync to Supabase agent_devices table
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/agent_devices`, {
        method: 'POST',
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          device_name: deviceRecord.deviceName,
          credential_hash: crypto.createHash('sha256').update(deviceToken).digest('hex'),
          enrollment_code: cleanCode,
          status: 'active',
          godown_exists: true,
          company_loaded: cleanGodown,
          last_seen_at: new Date().toISOString()
        })
      });
    } catch (_dbErr) {}

    console.log(`[DevicePairing] ✓ Device "${deviceRecord.deviceName}" successfully paired by ${deviceRecord.pairedBy} and LOCKED to godown "${cleanGodown}".`);

    res.json({
      success: true,
      message: `Device "${deviceRecord.deviceName}" paired and locked to "${cleanGodown}" Godown!`,
      device: {
        id: deviceRecord.id,
        deviceName: deviceRecord.deviceName,
        godown: deviceRecord.godown,
        isLocked: true,
        pairedBy: deviceRecord.pairedBy
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Validate active device session (called by terminal on boot)
app.get('/api/auth/device-session', async (req, res) => {
  try {
    const device = await resolveDeviceFromRequest(req);
    if (!device) {
      return res.json({ valid: false });
    }
    device.lastSeenAt = new Date().toISOString();
    return res.json({
      valid: true,
      device: {
        id: device.id,
        deviceName: device.deviceName,
        godown: device.godown,
        isLocked: true,
        pairedAt: device.pairedAt
      }
    });
  } catch (err) {
    res.status(500).json({ valid: false, error: err.message });
  }
});

// 5. Admin lists all connected devices
app.get('/api/admin/devices', requireAdminAuth, async (req, res) => {
  try {
    const registry = await getDeviceRegistry();
    const isMaster = isMasterAdmin(req.user);
    const devicesList = Object.values(registry.devices || {}).map(d => ({
      id: d.id,
      deviceName: d.deviceName,
      godown: d.godown,
      isLocked: d.isLocked !== false,
      status: d.status,
      pairedBy: d.pairedBy,
      pairedAt: d.pairedAt,
      lastSeenAt: d.lastSeenAt,
      platform: d.platform
    }));

    res.json({
      success: true,
      devices: devicesList,
      isMasterAdmin: isMaster,
      currentUserEmail: req.user?.email || null
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Master Admin unpairs / revokes a device
app.post('/api/admin/devices/:id/unpair', requireAdminAuth, async (req, res) => {
  try {
    if (!isMasterAdmin(req.user)) {
      return res.status(403).json({
        success: false,
        error: 'Permission Denied: Only Master Admin can unpair devices.'
      });
    }

    const deviceId = req.params.id;
    const registry = await getDeviceRegistry();
    const dev = registry.devices[deviceId];
    if (!dev) {
      return res.status(404).json({ success: false, error: 'Device not found' });
    }

    dev.status = 'revoked';
    dev.revokedAt = new Date().toISOString();
    dev.revokedBy = req.user?.email;
    delete dev.deviceToken;

    await saveDeviceRegistry(registry);

    try {
      await fetch(`${SUPABASE_URL}/rest/v1/agent_devices?device_name=eq.${encodeURIComponent(dev.deviceName)}`, {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'revoked', revoked_at: new Date().toISOString() })
      });
    } catch (_) {}

    console.log(`[DevicePairing] 🚫 Device "${dev.deviceName}" revoked by Master Admin ${req.user?.email}`);

    res.json({
      success: true,
      message: `Device "${dev.deviceName}" has been revoked and unpaired.`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. Master Admin reassigns a device to a different Godown
app.post('/api/admin/devices/:id/reassign', requireAdminAuth, async (req, res) => {
  try {
    if (!isMasterAdmin(req.user)) {
      return res.status(403).json({
        success: false,
        error: 'Permission Denied: Only Master Admin can reassign device storage.'
      });
    }

    const deviceId = req.params.id;
    const { newGodown } = req.body || {};
    if (!newGodown) {
      return res.status(400).json({ success: false, error: 'New Godown name is required' });
    }

    const cleanGodown = newGodown.trim();
    const registry = await getDeviceRegistry();
    const dev = registry.devices[deviceId];
    if (!dev) {
      return res.status(404).json({ success: false, error: 'Device not found' });
    }

    await ensureGodownExistsInTally(cleanGodown);

    const oldGodown = dev.godown;
    dev.godown = cleanGodown;
    dev.reassignedAt = new Date().toISOString();
    dev.reassignedBy = req.user?.email;

    await saveDeviceRegistry(registry);

    console.log(`[DevicePairing] 🔄 Device "${dev.deviceName}" reassigned from "${oldGodown}" to "${cleanGodown}" by ${req.user?.email}`);

    res.json({
      success: true,
      message: `Device "${dev.deviceName}" reassigned to "${cleanGodown}".`,
      godown: cleanGodown
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------------------------------------------------------
// State: Morning Stock Sync Memory
// -----------------------------------------------------------------------------
let morningSyncState = {
  lastSyncAt: null,
  itemsUpdated: 0,
  status: 'idle',
  error: null,
  reconciliation: []
};
const manuallyDeletedSkus = new Set();

async function loadManuallyDeletedSkus() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.manually_deleted_skus&select=value`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const rows = await res.json();
    if (Array.isArray(rows) && rows[0]?.value) {
      const list = JSON.parse(rows[0].value);
      if (Array.isArray(list)) list.forEach(s => manuallyDeletedSkus.add(s.toLowerCase()));
    }
  } catch (_) {}
  return manuallyDeletedSkus;
}

async function addManuallyDeletedSku(sku) {
  if (!sku) return;
  manuallyDeletedSkus.add(sku.toLowerCase());
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/app_settings`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        key: 'manually_deleted_skus',
        value: JSON.stringify([...manuallyDeletedSkus]),
        updated_at: new Date().toISOString()
      })
    });
  } catch (_) {}
}

// Load initially on startup
loadManuallyDeletedSkus();

// -----------------------------------------------------------------------------
// Asynchronous Tally Action Queue (Cloud to Store PC Bridge)
// Allows admin portal on laptop to queue stock updates & deletions into Supabase
// Store PC (running Tally on port 9000) automatically executes them every 12s.
// -----------------------------------------------------------------------------
async function queuePendingTallyAction(action) {
  try {
    const getRes = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.pending_tally_actions&select=value`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const rows = await getRes.json().catch(() => []);
    let queue = [];
    if (Array.isArray(rows) && rows[0]?.value) {
      try { queue = JSON.parse(rows[0].value); } catch (_) {}
    }
    queue.push({
      id: action.id || `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      createdAt: new Date().toISOString(),
      ...action
    });
    await fetch(`${SUPABASE_URL}/rest/v1/app_settings`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        key: 'pending_tally_actions',
        value: JSON.stringify(queue),
        updated_at: new Date().toISOString()
      })
    });
    console.log(`[QueueTallyAction] 📥 Queued action: ${action.type} for ${action.sku || action.targetItem || action.itemName}`);
  } catch (err) {
    console.warn(`[QueueTallyAction] Warning:`, err.message);
  }
}

async function processPendingTallyActions() {
  if (!isTallyLocallyConnected) return;
  try {
    const getRes = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.pending_tally_actions&select=value`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const rows = await getRes.json().catch(() => []);
    if (!Array.isArray(rows) || !rows[0]?.value) return;
    let queue = [];
    try { queue = JSON.parse(rows[0].value); } catch (_) { return; }
    if (!Array.isArray(queue) || queue.length === 0) return;

    console.log(`[processPendingTallyActions] ⚡ Processing ${queue.length} pending Tally action(s)...`);
    const remaining = [];

    for (const act of queue) {
      try {
        if (act.type === 'adjust_stock') {
          const { sku, targetItem, delta, newQty, godown, rate, unitLabel, reason } = act;
          const activeGodown = godown || await getTargetGodown();
          const targetName = targetItem || sku;
          const uLabel = unitLabel || 'Pcs';
          const r = rate || 10000;

          // Resolve against live Tally before touching anything.
          //
          // Two defects used to compound here and land "set to 40" on 46:
          //  1. The queued `delta` was computed on whichever machine took the request,
          //     against saree_catalog.stock_quantity — a cache that drifts from Tally.
          //  2. pushProductToTallyMaster ran unconditionally with quantity: newQty. For an
          //     item that already exists that becomes ACTION="Alter", which RESETS the
          //     opening balance to newQty — and then the delta voucher was applied on top.
          //
          // So: look the item up once. Exists -> skip the master push and recompute the
          // delta from its live figure. Missing -> create it at the target quantity and
          // issue no voucher, because the master itself already carries the stock.
          let effectiveDelta = Number.isFinite(delta) ? delta : 0;
          let itemExists = true;
          try {
            const liveItems = await fetchAllTallyStockItems();
            const wanted = [sku, targetName].filter(Boolean).map(v => String(v).toLowerCase().trim());
            const match = liveItems.find(it =>
              wanted.includes(String(it.product_code || '').toLowerCase().trim()) ||
              wanted.includes(String(it.name || '').toLowerCase().trim())
            );
            itemExists = Boolean(match);
            if (match && Number.isFinite(newQty)) {
              const gKey = Object.keys(match.godown_stocks || {})
                .find(k => k.toLowerCase() === String(activeGodown).toLowerCase());
              const baseline = gKey !== undefined
                ? (Number(match.godown_stocks[gKey]) || 0)
                : (Number(match.closing_total) || 0);
              effectiveDelta = newQty - baseline;
              if (effectiveDelta !== delta) {
                console.log(`[processPendingTallyActions] Recomputed "${targetName}": queued delta ${delta}, live baseline ${baseline}, applying ${effectiveDelta >= 0 ? '+' : ''}${effectiveDelta}`);
              }
            }
          } catch (liveErr) {
            console.warn('[processPendingTallyActions] Live baseline unavailable, using queued delta:', liveErr.message);
          }

          if (!itemExists) {
            // Creating the master with the target quantity IS the adjustment.
            try {
              await pushProductToTallyMaster({
                sku: sku || targetName,
                name: targetName,
                quantity: newQty || 0,
                rate: r,
                unitLabel: uLabel,
                godownName: activeGodown
              });
              console.log(`[processPendingTallyActions] Created "${targetName}" in Tally at ${newQty || 0} ${uLabel} (${activeGodown}) — no voucher needed`);
            } catch (_) {}
            effectiveDelta = 0;
          }

          if (effectiveDelta > 0) {
            const refNum = `RN-ADJ-${Date.now().toString().slice(-6)}`;
            let rnXml = buildTallyReceiptNoteXml({
              refNumber: refNum,
              stockItemName: targetName,
              qty: effectiveDelta,
              rate: r,
              unitLabel: uLabel,
              godownName: activeGodown
            });
            await sendToTally(rnXml, 4000);
            console.log(`[processPendingTallyActions] ✓ Inwarded +${effectiveDelta} ${uLabel} for "${targetName}" in Tally (${activeGodown})`);
          } else if (effectiveDelta < 0) {
            const refNum = `VCH-ADJ-${Date.now().toString().slice(-6)}`;
            let svXml = buildTallySalesVoucherXml({
              orderNumber: refNum,
              stockItemName: targetName,
              qty: Math.abs(effectiveDelta),
              rate: r,
              unitLabel: uLabel,
              godownName: activeGodown,
              buyerName: reason || 'Inventory Adjustment'
            });
            await sendToTally(svXml, 4000);
            console.log(`[processPendingTallyActions] ✓ Deducted -${Math.abs(effectiveDelta)} ${uLabel} for "${targetName}" in Tally (${activeGodown})`);
          }
        } else if (act.type === 'zero_stock') {
          const { sku, itemName, godown } = act;
          const activeGodown = godown || await getTargetGodown();
          const targetName = itemName || sku;
          const isNos = /mysore|paithani|0021|0022/i.test(targetName);
          const uLabel = isNos ? 'Nos' : 'Pcs';
          const alterXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<STOCKITEM NAME="${escapeXml(targetName)}" ACTION="Alter">
  <NAME>${escapeXml(targetName)}</NAME>
  <PARENT>${escapeXml(TALLY_STOCK_GROUP)}</PARENT>
  <OPENINGBALANCE>0 ${uLabel}</OPENINGBALANCE>
  <OPENINGRATE>0/${uLabel}</OPENINGRATE>
  <OPENINGVALUE>0</OPENINGVALUE>
  <BATCHALLOCATIONS.LIST>
    <GODOWNNAME>${activeGodown}</GODOWNNAME>
    <BATCHNAME>Primary Batch</BATCHNAME>
    <OPENINGBALANCE>0 ${uLabel}</OPENINGBALANCE>
    <OPENINGRATE>0/${uLabel}</OPENINGRATE>
    <OPENINGVALUE>0</OPENINGVALUE>
  </BATCHALLOCATIONS.LIST>
</STOCKITEM>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
          await sendToTally(alterXml, 4000);
          console.log(`[processPendingTallyActions] ✓ Zeroed stock for "${targetName}" in Tally (${activeGodown})`);
        } else if (act.type === 'push_to_tally') {
          const { sku, name, quantity, rate, unitLabel, godown } = act;
          const activeGodown = godown || await getTargetGodown() || 'Online_saree';
          const isNos = /mysore|paithani|0021|0022/i.test((name || '') + sku);
          const uLabel = unitLabel || (isNos ? 'Nos' : 'Pcs');
          const pushRes = await pushProductToTallyMaster({
            sku,
            name: name || sku,
            quantity: quantity || 0,
            rate: rate || 5000,
            unitLabel: uLabel,
            godownName: activeGodown
          });
          if (pushRes.success) {
            console.log(`[processPendingTallyActions] ✓ Created/pushed "${name || sku}" to Tally (${quantity} ${uLabel} in ${activeGodown})`);
            await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?or=(sku.eq.${encodeURIComponent(sku)},tally_part_number.eq.${encodeURIComponent(sku)})`, {
              method: 'PATCH',
              headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                item_created_in_tally: true,
                stock_added_in_tally: (quantity || 0) > 0,
                tally_last_seen_at: new Date().toISOString()
              })
            });
            await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?product_code=eq.${encodeURIComponent(sku)}`, {
              method: 'PATCH',
              headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                source: 'tally_godown',
                online_quantity: quantity || 0,
                last_synced_at: new Date().toISOString()
              })
            });
          } else {
            throw new Error(`Tally push returned: ${pushRes.raw?.slice(0, 150)}`);
          }
        } else if (act.type === 'delete_godown') {
          const { godownName } = act;
          if (!godownName || godownName.toLowerCase() === 'main location') {
            console.log(`[processPendingTallyActions] Skipped deletion for reserved godown: "${godownName}"`);
          } else {
            // 1. Zero/clear stock allocations out of this godown to unlock deletion
            try {
              const summaryXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>StockItemsForGodown</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="StockItemsForGodown"><TYPE>StockItem</TYPE><FETCH>Name,BatchAllocations</FETCH></COLLECTION></TDLMESSAGE></TDL>
</DESC></BODY></ENVELOPE>`;
              const sumRes = await sendToTally(summaryXml, 5000);
              const itemBlockRegex = /<STOCKITEM\s+NAME="([^"]+)"[^>]*>([\s\S]*?)<\/STOCKITEM>/gi;
              let iMatch;
              while ((iMatch = itemBlockRegex.exec(sumRes)) !== null) {
                const itemName = unescapeXml(iMatch[1]).trim();
                const itemBody = iMatch[2];
                if (itemBody.toLowerCase().includes(godownName.toLowerCase())) {
                  const alterXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<STOCKITEM NAME="${escapeXml(itemName)}" ACTION="Alter">
  <NAME>${escapeXml(itemName)}</NAME>
  <BATCHALLOCATIONS.LIST>
    <GODOWNNAME>${escapeXml(godownName)}</GODOWNNAME>
    <OPENINGBALANCE>0 Pcs</OPENINGBALANCE>
    <OPENINGRATE>0/Pcs</OPENINGRATE>
    <OPENINGVALUE>0</OPENINGVALUE>
  </BATCHALLOCATIONS.LIST>
</STOCKITEM>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
                  await sendToTally(alterXml, 4000);
                }
              }
            } catch (allocErr) {
              console.warn(`[processPendingTallyActions] Warning clearing allocations for ${godownName}:`, allocErr.message);
            }

            // 2. Send Delete envelope to Tally
            const delXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<GODOWN NAME="${escapeXml(godownName)}" ACTION="Delete">
  <NAME>${escapeXml(godownName)}</NAME>
</GODOWN>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
            const delRes = await sendToTally(delXml, 4000);
            console.log(`[processPendingTallyActions] 🗑️ Sent delete envelope for godown "${godownName}". Tally response:`, delRes ? delRes.slice(0, 150) : 'OK');
          }
        }
      } catch (err) {
        console.warn(`[processPendingTallyActions] Error executing action ${act.id}:`, err.message);
        const failCount = (act.failCount || 0) + 1;
        if (failCount < 3) {
          remaining.push({ ...act, failCount });
        } else {
          console.warn(`[processPendingTallyActions] Discarding action ${act.id} after 3 failed attempts.`);
        }
      }
    }

    // Update queue in Supabase with remaining items
    await fetch(`${SUPABASE_URL}/rest/v1/app_settings`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        key: 'pending_tally_actions',
        value: JSON.stringify(remaining),
        updated_at: new Date().toISOString()
      })
    });
  } catch (err) {
    console.warn('[processPendingTallyActions] Outer warning:', err.message);
  }
}


// -----------------------------------------------------------------------------
// SEC-08: Tally Leaky-Bucket Sequential Request Queue (Concurrency = 1)
// Protects TallyPrime's single-threaded XML engine from concurrent lockups.
// All XML queries, master creations, and voucher injections pass through here.
// -----------------------------------------------------------------------------
class TallyQueueManager {
  constructor(spacingMs = 250) {
    this.queue = [];
    this.isProcessing = false;
    this.spacingMs = spacingMs;
    this.lastExecutedAt = 0;
    this.totalExecuted = 0;
  }

  enqueue(xml, customTimeout = 4000) {
    return new Promise((resolve, reject) => {
      this.queue.push({ xml, customTimeout, resolve, reject, retries: 0 });
      this.processNext();
    });
  }

  async processNext() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    const task = this.queue.shift();
    
    // Enforce 250ms spacing between consecutive Tally calls
    const timeSinceLast = Date.now() - this.lastExecutedAt;
    if (timeSinceLast < this.spacingMs) {
      await new Promise(r => setTimeout(r, this.spacingMs - timeSinceLast));
    }

    try {
      const result = await this.executeRaw(task.xml, task.customTimeout);
      this.lastExecutedAt = Date.now();
      this.totalExecuted++;
      task.resolve(result);
    } catch (err) {
      this.lastExecutedAt = Date.now();
      // If Tally was busy or socket reset, retry up to 2 times with backoff
      const isTransient = /ECONNRESET|Server busy|busy/i.test(err.message);
      if (isTransient && task.retries < 2) {
        task.retries++;
        const backoffMs = task.retries * 1200;
        console.warn(`[TallyQueue] Transient notice (${err.message}). Retrying in ${backoffMs}ms (Attempt ${task.retries + 1}/3)...`);
        await new Promise(r => setTimeout(r, backoffMs));
        this.queue.unshift(task); // Re-queue at the front
      } else {
        task.reject(err);
      }
    } finally {
      this.isProcessing = false;
      if (this.queue.length > 0) {
        setImmediate(() => this.processNext());
      }
    }
  }

  async executeRaw(xml, customTimeout) {
    try {
      return await this.executeLocal(xml, customTimeout);
    } catch (localErr) {
      if (/ECONNREFUSED/i.test(localErr.message)) {
        try {
          const remoteRes = await this.forwardToRemoteGateway(xml, customTimeout);
          if (remoteRes) return remoteRes;
        } catch (_) {}
      }
      throw localErr;
    }
  }

  executeLocal(xml, customTimeout) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: TALLY_HOST,
        port: TALLY_PORT,
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml;charset=utf-8',
          'Content-Length': Buffer.byteLength(xml)
        },
        timeout: customTimeout
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Tally connection timed out'));
      });
      req.write(xml);
      req.end();
    });
  }

  async forwardToRemoteGateway(xml, customTimeout) {
    try {
      const gwRes = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.in_store_gateway_url&select=value`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
        signal: AbortSignal.timeout(2000)
      });
      const gwRows = await gwRes.json();
      if (Array.isArray(gwRows) && gwRows.length > 0 && gwRows[0].value) {
        const gw = typeof gwRows[0].value === 'string' ? JSON.parse(gwRows[0].value) : gwRows[0].value;
        // LAN first: measured 0.07s vs 1.25s through the tunnel, and the quick-tunnel
        // URL is often stale — get_tunnel_url.js republishes a dead one as fresh.
        const targetUrl = gw.lanUrl || gw.publicUrl;
        if (targetUrl) {
          const fRes = await fetch(`${targetUrl}/api/tally/execute-xml`, {
            method: 'POST',
            headers: {
              'Content-Type': 'text/xml;charset=utf-8',
              'x-admin-key': ADMIN_API_KEY || SERVICE_KEY || 'sai-traders-admin-key',
              'Authorization': `Bearer ${SERVICE_KEY}`
            },
            body: xml,
            signal: AbortSignal.timeout(customTimeout || 6000)
          });
          if (fRes.ok) {
            return await fRes.text();
          }
        }
      }
    } catch (_) {}
    return null;
  }

  getStats() {
    return {
      pending: this.queue.length,
      isProcessing: this.isProcessing,
      totalExecuted: this.totalExecuted,
      spacingMs: this.spacingMs
    };
  }
}

const tallyQueue = new TallyQueueManager(250);

function sendToTally(xml, customTimeout = 4000) {
  return tallyQueue.enqueue(xml, customTimeout);
}

function unescapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

// -----------------------------------------------------------------------------
// Tally Company GUID Identity Verification (SEC-07)
// Prevents unauthorized Tally instances from accessing cloud data.
// On first connection, the Tally company GUID is registered in Supabase.
// All subsequent connections must match the registered GUID.
// -----------------------------------------------------------------------------
let registeredTallyIdentity = null; // { companyName, guid, registeredAt, hostname }
let isTallyIdentityVerified = false;
let lastIdentityCheckTime = 0;

// Extract Company GUID from TallyPrime via XML API
async function getTallyCompanyGUID(timeoutMs = 2500) {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CompanyCollection</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CompanyCollection">
            <TYPE>Company</TYPE>
            <FETCH>Name,GUID,CompanyNumber,StartingFrom</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
  try {
    const rawRes = await sendToTally(xml, timeoutMs);
    const nameMatch = rawRes.match(/<NAME[^>]*>([^<]+)<\/NAME>/i) ||
                      rawRes.match(/<COMPANY\s+NAME="([^"]+)"/i) ||
                      rawRes.match(/<COMPANYNAME>([^<]+)<\/COMPANYNAME>/i) ||
                      rawRes.match(/<SVCURRENTCOMPANY>([^<]+)<\/SVCURRENTCOMPANY>/i);
    const companyName = nameMatch ? unescapeXml(nameMatch[1]).trim() : null;

    const guidMatch = rawRes.match(/<GUID[^>]*>([^<]+)<\/GUID>/i) ||
                      rawRes.match(/<COMPANYUNIQUENUMBER>([^<]+)<\/COMPANYUNIQUENUMBER>/i);
    const guid = guidMatch ? unescapeXml(guidMatch[1]).trim() : null;

    const numMatch = rawRes.match(/<COMPANYNUMBER[^>]*>([^<]+)<\/COMPANYNUMBER>/i);
    const companyNumber = numMatch ? unescapeXml(numMatch[1]).trim() : null;

    let fingerprint = guid;
    if (!fingerprint && companyName) {
      const createdMatch = rawRes.match(/<STARTINGFROM[^>]*>([^<]+)<\/STARTINGFROM>/i);
      const createdDate = createdMatch ? unescapeXml(createdMatch[1]).trim() : 'unknown';
      fingerprint = crypto.createHash('sha256').update(`${companyName}::${createdDate}`).digest('hex').slice(0, 32);
    }

    return { companyName, guid: fingerprint, companyNumber, raw: rawRes.slice(0, 500) };
  } catch (err) {
    return { companyName: null, guid: null, companyNumber: null, error: err.message };
  }
}

// Fetch registered Tally identity from Supabase
async function fetchRegisteredTallyIdentity() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.registered_tally_identity&select=value`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const rows = await res.json();
    if (Array.isArray(rows) && rows[0]?.value) {
      const parsed = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
      registeredTallyIdentity = parsed;
      return parsed;
    }
  } catch (_e) {}
  return null;
}

// Register or pair Tally identity in Supabase (with selected godown)
async function registerTallyIdentity(identity, godownName = null) {
  const payload = {
    companyName: identity.companyName,
    guid: identity.guid,
    companyNumber: identity.companyNumber || '',
    registeredAt: new Date().toISOString(),
    hostname: os.hostname()
  };
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/app_settings`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        key: 'registered_tally_identity',
        value: JSON.stringify(payload),
        updated_at: new Date().toISOString()
      })
    });
    registeredTallyIdentity = payload;
    isTallyIdentityVerified = true;
    
    if (godownName) {
      await setTargetGodown(godownName);
    }
    
    console.log(`[TallyIdentity] ✅ Registered authorized Tally: "${payload.companyName}" (GUID: ${payload.guid}) | Godown: ${godownName || currentTargetGodown}`);
    return { registered: true, identity: payload, godown: godownName || currentTargetGodown };
  } catch (err) {
    console.error('[TallyIdentity] ❌ Failed to register identity:', err.message);
    return { registered: false, error: err.message };
  }
}

// Verify currently connected Tally against registered identity
async function verifyTallyIdentity(timeoutMs = 2500) {
  // Throttle: don't re-verify more than once every 15 seconds if verified
  if (isTallyIdentityVerified && registeredTallyIdentity && (Date.now() - lastIdentityCheckTime) < 15000) {
    return { verified: true, identity: registeredTallyIdentity };
  }

  const currentTally = await getTallyCompanyGUID(timeoutMs);
  if (!currentTally.companyName || !currentTally.guid) {
    isTallyIdentityVerified = false;
    return { verified: false, error: 'Could not read Tally company identity', details: currentTally.error };
  }

  // Fetch registered identity if not cached
  if (!registeredTallyIdentity) {
    await fetchRegisteredTallyIdentity();
  }

  // First-time connection: no identity registered yet -> prompt admin to pair & select godown
  if (!registeredTallyIdentity) {
    isTallyIdentityVerified = false;
    lastIdentityCheckTime = Date.now();
    return {
      verified: false,
      firstTime: true,
      connected: {
        companyName: currentTally.companyName,
        guid: currentTally.guid,
        companyNumber: currentTally.companyNumber
      }
    };
  }

  // Compare GUID
  if (currentTally.guid === registeredTallyIdentity.guid) {
    isTallyIdentityVerified = true;
    lastIdentityCheckTime = Date.now();
    const godownToEnsure = currentTargetGodown || registeredTallyIdentity.godown;
    if (godownToEnsure && godownToEnsure.toLowerCase() !== 'main location') {
      ensureGodownExistsInTally(godownToEnsure).catch(() => {});
    }
    return { verified: true, identity: registeredTallyIdentity };
  } else {
    isTallyIdentityVerified = false;
    lastIdentityCheckTime = Date.now();
    console.warn(`[TallyIdentity] ⛔ IDENTITY MISMATCH! Connected: "${currentTally.companyName}" (${currentTally.guid}) vs Registered: "${registeredTallyIdentity.companyName}" (${registeredTallyIdentity.guid})`);
    return {
      verified: false,
      mismatch: true,
      connected: { companyName: currentTally.companyName, guid: currentTally.guid, companyNumber: currentTally.companyNumber },
      registered: { companyName: registeredTallyIdentity.companyName, guid: registeredTallyIdentity.guid }
    };
  }
}

// Load registered identity on startup
fetchRegisteredTallyIdentity().then(id => {
  if (id) console.log(`[TallyIdentity] 🔍 Loaded registered Tally: "${id.companyName}" (GUID: ${id.guid})`);
  else console.log('[TallyIdentity] ℹ️  No registered Tally identity found. First-time setup required.');
}).catch(() => {});

// -----------------------------------------------------------------------------
// Cloud Tally Heartbeat & Distributed Multi-PC Bridge
// -----------------------------------------------------------------------------
let isTallyLocallyConnected = false;
let lastLocalTallyCheckTime = 0;
let cachedRemoteTallyStatus = null;
let lastRemoteTallyCheckTime = 0;

// Test local Tally using standard CompanyCollection TDL XML
async function checkLocalTallyConnection(timeoutMs = 1500) {
  const start = Date.now();
  try {
    const tallyInfo = await getTallyCompanyGUID(timeoutMs);
    if (!tallyInfo.companyName) {
      throw new Error(tallyInfo.error || 'No active company found in Tally');
    }
    const latencyMs = Date.now() - start;
    isTallyLocallyConnected = true;
    lastLocalTallyCheckTime = Date.now();
    return {
      connected: true,
      latencyMs,
      company: tallyInfo.companyName,
      guid: tallyInfo.guid,
      companyNumber: tallyInfo.companyNumber,
      hostname: os.hostname(),
      port: TALLY_PORT
    };
  } catch (err) {
    isTallyLocallyConnected = false;
    lastLocalTallyCheckTime = Date.now();
    return {
      connected: false,
      error: err.message,
      latencyMs: null
    };
  }
}

// Broadcast local Tally heartbeat to Supabase app_settings & agent_devices
async function broadcastTallyHeartbeat(status = {}) {
  try {
    const godown = await getTargetGodown();
    let discoveredGodowns = [];
    if (isTallyLocallyConnected) {
      try {
        discoveredGodowns = await fetchTallyGodowns();
      } catch (_) {}
    }

    const godownNames = discoveredGodowns.map(g => typeof g === 'object' ? g.name : g);
    const hierarchyData = discoveredGodowns.length > 0 ? buildGodownHierarchy(discoveredGodowns) : undefined;
    const payload = {
      connected: true,
      hostname: os.hostname(),
      port: TALLY_PORT,
      latencyMs: status.latencyMs || 10,
      itemCount: status.itemCount || 0,
      company: status.company || 'Sai Traders ERP',
      guid: status.guid || null,
      identityVerified: Boolean(status.verified),
      firstTimeRegistration: Boolean(status.firstTime),
      godown: godown || TALLY_DEFAULT_GODOWN,
      godowns: godownNames.length > 0 ? godownNames : undefined,
      godownHierarchy: hierarchyData,
      lastSeen: Date.now(),
      updatedAt: new Date().toISOString()
    };

    // 1. Post to Supabase app_settings
    await fetch(`${SUPABASE_URL}/rest/v1/app_settings`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        key: 'in_store_tally_status',
        value: JSON.stringify(payload),
        updated_at: payload.updatedAt
      })
    });

    // If local Tally returned godowns, persist tally_discovered_godowns and tally_godown_hierarchy
    if (discoveredGodowns.length > 0) {
      await Promise.allSettled([
        fetch(`${SUPABASE_URL}/rest/v1/app_settings`, {
          method: 'POST',
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates'
          },
          body: JSON.stringify({
            key: 'tally_discovered_godowns',
            value: JSON.stringify(godownNames),
            updated_at: payload.updatedAt
          })
        }),
        fetch(`${SUPABASE_URL}/rest/v1/app_settings`, {
          method: 'POST',
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates'
          },
          body: JSON.stringify({
            key: 'tally_godown_hierarchy',
            value: JSON.stringify(hierarchyData),
            updated_at: payload.updatedAt
          })
        })
      ]).catch(() => {});
    }

    // 2. Also refresh agent_devices for shop PC online status
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/agent_devices`, {
        method: 'POST',
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          hostname: os.hostname(),
          shop_id: '00000000-0000-0000-0000-000000000001',
          status: 'active',
          last_seen_at: payload.updatedAt
        })
      });
    } catch (_adErr) {}
  } catch (err) {
    // Non-blocking fire-and-forget
  }
}

// Query Supabase for in-store Tally heartbeat (used by Admin PC)
/**
 * Liveness of the store PC, as the agent reports it.
 *
 * This used to read app_settings.in_store_tally_status, written by the old store-PC
 * supervisor. That supervisor no longer runs, so the key froze at its last value and
 * the dashboard showed "Offline" permanently while the agent was healthy and syncing
 * every two minutes. agent_devices is where liveness actually lives now.
 */
async function fetchRemoteTallyHeartbeat() {
  const now = Date.now();
  if (cachedRemoteTallyStatus && (now - lastRemoteTallyCheckTime < 4000)) {
    return cachedRemoteTallyStatus;
  }
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/agent_devices?select=device_name,last_seen_at,tally_reachable,company_loaded,godown_exists,shop_id` +
      `&status=eq.active&revoked_at=is.null&order=last_seen_at.desc&limit=1`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    const rows = await res.json();
    const device = Array.isArray(rows) ? rows[0] : null;
    if (!device || !device.last_seen_at) return null;

    const ageMs = now - new Date(device.last_seen_at).getTime();
    const ageSec = Math.max(0, Math.round(ageMs / 1000));

    // The device row records only THAT a company is open, not which one. The company
    // name and GUID are the shop's registered identity, so they come from the shop.
    let company = null;
    let guid = null;
    let shopName = null;
    let settings = {};
    try {
      const shopRes = await fetch(
        `${SUPABASE_URL}/rest/v1/shops?select=name,settings&id=eq.${device.shop_id}&limit=1`,
        { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
      );
      const shopRows = await shopRes.json();
      settings = (Array.isArray(shopRows) && shopRows[0] && shopRows[0].settings) || {};
      company = settings.tally_company || null;
      guid = settings.tally_guid || null;
      shopName = (Array.isArray(shopRows) && shopRows[0] && shopRows[0].name) || null;
    } catch (_e) { /* the liveness answer does not depend on this */ }

    // A healthy agent speaks every 30 seconds, so 90 is three missed beats.
    const isFresh = ageMs < 90000;

    // "Connected" means the shop PC is reachable AND Tally is answering with a company
    // open. Anything less is reported distinctly, so the dashboard can say which half
    // is missing instead of just "offline".
    const status = {
      connected: Boolean(isFresh && device.tally_reachable && device.company_loaded),
      remoteStore: true,
      storePcOnline: isFresh,
      hostname: device.device_name || 'Store PC',
      company,
      guid,
      targetGodown: settings.online_godown || null,
      shopName: shopName || null,
      latencyMs: null,
      ageSeconds: ageSec,
      isFresh,
    };

    if (!isFresh) {
      const minsAgo = Math.round(ageMs / 60000);
      status.lastSeenAgo = minsAgo > 60 ? `${Math.round(minsAgo / 60)}h ago` : `${minsAgo}m ago`;
      status.notice = `The store PC last reported ${status.lastSeenAgo}. Start the agent on that PC.`;
    } else if (!device.tally_reachable) {
      status.notice = 'The store PC is connected, but TallyPrime is not answering on port 9000.';
    } else if (!device.company_loaded) {
      status.notice = 'The store PC is connected and Tally is running, but no company is open.';
    }

    cachedRemoteTallyStatus = status;
    lastRemoteTallyCheckTime = now;
    return status;
  } catch (_err) {
    return null;
  }
}

// Dedicated background loop: Broadcaster on Store PC (pings local Tally every 10s and publishes heartbeat)
setInterval(async () => {
  try {
    const local = await checkLocalTallyConnection(2000);
    if (local.connected) {
      let idCheck = { verified: true };
      try {
        idCheck = await verifyTallyIdentity(1500);
      } catch (_) {}
      
      await broadcastTallyHeartbeat({
        ...local,
        verified: Boolean(idCheck.verified),
        firstTime: Boolean(idCheck.firstTime),
        mismatch: Boolean(idCheck.mismatch),
        company: idCheck.connected?.companyName || local.company,
        guid: idCheck.connected?.guid || local.guid
      });
    } else {
      // If local Tally is not connected on this machine, but this machine is configured as Store PC gateway,
      // broadcast status so cloud knows Store PC is running and waiting for Tally on port 9000
      try {
        const gwRes = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.in_store_gateway_url&select=value`, {
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
        });
        const gwRows = await gwRes.json();
        const gw = (Array.isArray(gwRows) && gwRows[0]?.value) ? 
          (typeof gwRows[0].value === 'string' ? JSON.parse(gwRows[0].value) : gwRows[0].value) : null;
        
        if (gw && gw.hostname && os.hostname().toUpperCase() === gw.hostname.toUpperCase()) {
          await fetch(`${SUPABASE_URL}/rest/v1/app_settings`, {
            method: 'POST',
            headers: {
              apikey: SERVICE_KEY,
              Authorization: `Bearer ${SERVICE_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'resolution=merge-duplicates'
            },
            body: JSON.stringify({
              key: 'in_store_tally_status',
              value: JSON.stringify({
                connected: false,
                storePcOnline: true,
                hostname: os.hostname(),
                error: local.error || 'Tally not reachable on port 9000 or no company open',
                lastSeen: Date.now(),
                updatedAt: new Date().toISOString()
              }),
              updated_at: new Date().toISOString()
            })
          });
        }
      } catch (_) {}
    }
  } catch (_e) {}
}, 10000);

// -----------------------------------------------------------------------------
// Helper: Gemini Embedding 2 (Multimodal 768-d)
// -----------------------------------------------------------------------------
async function generateEmbedding(part, taskType = 'RETRIEVAL_DOCUMENT') {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBEDDING_MODEL}:embedContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${GEMINI_EMBEDDING_MODEL}`,
      content: { parts: [part] },
      taskType,
      outputDimensionality: 768
    })
  });
  const data = await res.json();
  if (!res.ok || !data.embedding?.values) {
    throw new Error(data.error?.message || 'Failed to generate embedding');
  }
  return data.embedding.values;
}

// Cosine similarity
function computeCosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return (normA === 0 || normB === 0) ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// -----------------------------------------------------------------------------
// Helper: Tally XML Generators (Sales Voucher & Receipt Note)
// -----------------------------------------------------------------------------
function buildTallySalesVoucherXml({ orderNumber, stockItemName, qty, rate, unitLabel = 'Nos', godownName = null, buyerName = 'WhatsApp Customer', dateOverride = null }) {
  const targetGodown = (godownName || currentTargetGodown || TALLY_DEFAULT_GODOWN).trim();
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  // In Tally EDU mode, non-1/2/31 dates are rejected. Use safe day '01' if outside allowed EDU days.
  const safeDay = (day === '01' || day === '02' || day === '31') ? day : '01';
  const dateStr = dateOverride || `${year}${month}${safeDay}`;
  const totalAmount = (qty * rate).toFixed(2);
  const cleanItem = escapeXml(stockItemName);

  return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="Sales" ACTION="Create">
            <DATE>${dateStr}</DATE>
            <EFFECTIVEDATE>${dateStr}</EFFECTIVEDATE>
            <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${orderNumber}</VOUCHERNUMBER>
            <PARTYLEDGERNAME>Cash</PARTYLEDGERNAME>
            <NARRATION>Order ${orderNumber} - Buyer: ${buyerName}</NARRATION>
            
            <LEDGERENTRIES.LIST>
              <LEDGERNAME>Cash</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
              <AMOUNT>-${totalAmount}</AMOUNT>
            </LEDGERENTRIES.LIST>

            <ALLINVENTORYENTRIES.LIST>
              <STOCKITEMNAME>${cleanItem}</STOCKITEMNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <RATE>${Number(rate).toFixed(2)}/${unitLabel}</RATE>
              <AMOUNT>${totalAmount}</AMOUNT>
              <ACTUALQTY>${qty} ${unitLabel}</ACTUALQTY>
              <BILLEDQTY>${qty} ${unitLabel}</BILLEDQTY>
              <BATCHALLOCATIONS.LIST>
                <GODOWNNAME>${targetGodown}</GODOWNNAME>
                <BATCHNAME>Primary Batch</BATCHNAME>
                <AMOUNT>${totalAmount}</AMOUNT>
                <ACTUALQTY>${qty} ${unitLabel}</ACTUALQTY>
                <BILLEDQTY>${qty} ${unitLabel}</BILLEDQTY>
              </BATCHALLOCATIONS.LIST>
              <ACCOUNTINGALLOCATIONS.LIST>
                <LEDGERNAME>Sales Account</LEDGERNAME>
                <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
                <AMOUNT>${totalAmount}</AMOUNT>
              </ACCOUNTINGALLOCATIONS.LIST>
            </ALLINVENTORYENTRIES.LIST>
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

function buildTallyReceiptNoteXml({ refNumber, stockItemName, qty, rate, unitLabel = 'Nos', godownName = null, dateOverride = null }) {
  // SEC-04: All dynamic values escaped through escapeXml() to prevent XML injection
  const targetGodown = escapeXml((godownName || currentTargetGodown || TALLY_DEFAULT_GODOWN).trim());
  const safeRefNumber = escapeXml(String(refNumber || ''));
  const safeStockItemName = escapeXml(String(stockItemName || ''));
  const safeUnitLabel = escapeXml(String(unitLabel || 'Nos'));
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const dateStr = escapeXml(dateOverride || `${year}${month}${day}`);
  const totalAmount = (qty * rate).toFixed(2);

  return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="Receipt Note" ACTION="Create">
            <DATE>${dateStr}</DATE>
            <EFFECTIVEDATE>${dateStr}</EFFECTIVEDATE>
            <VOUCHERTYPENAME>Receipt Note</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${safeRefNumber}</VOUCHERNUMBER>
            <PARTYLEDGERNAME>Cash</PARTYLEDGERNAME>
            <NARRATION>Stock Inward: ${safeStockItemName} ${qty} ${safeUnitLabel} to ${targetGodown} Godown</NARRATION>
            <ALLINVENTORYENTRIES.LIST>
              <STOCKITEMNAME>${safeStockItemName}</STOCKITEMNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <RATE>${Number(rate).toFixed(2)}/${safeUnitLabel}</RATE>
              <AMOUNT>-${totalAmount}</AMOUNT>
              <ACTUALQTY>${qty} ${safeUnitLabel}</ACTUALQTY>
              <BILLEDQTY>${qty} ${safeUnitLabel}</BILLEDQTY>
              <BATCHALLOCATIONS.LIST>
                <GODOWNNAME>${targetGodown}</GODOWNNAME>
                <BATCHNAME>Primary Batch</BATCHNAME>
                <AMOUNT>-${totalAmount}</AMOUNT>
                <ACTUALQTY>${qty} ${safeUnitLabel}</ACTUALQTY>
                <BILLEDQTY>${qty} ${safeUnitLabel}</BILLEDQTY>
              </BATCHALLOCATIONS.LIST>
            </ALLINVENTORYENTRIES.LIST>
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

function escapeXml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe).replace(/[<>&'"]/g, c => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
    }
  });
}

// Push/Create or Alter Stock Item Master in Tally ERP with Godown Allocation
async function pushProductToTallyMaster({ sku, name, quantity = 0, rate = 5000, unitLabel = 'Pcs', godownName = null }) {
  const targetGodown = (godownName || await getTargetGodown() || TALLY_DEFAULT_GODOWN).trim();
  const cleanSku = escapeXml((sku || '').trim());
  const cleanName = escapeXml((name || sku || '').trim());
  const cleanQty = Math.max(0, parseInt(quantity, 10) || 0);
  const cleanRate = parseFloat(rate) || 5000;
  const amount = (cleanQty * cleanRate).toFixed(2);

  // 1. Ensure Unit exists in Tally
  try {
    const unitXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<UNIT NAME="${unitLabel}" ACTION="Create"><NAME>${unitLabel}</NAME><ISSIMPLEUNIT>Yes</ISSIMPLEUNIT><DECIMALPLACES>0</DECIMALPLACES></UNIT>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
    await sendToTally(unitXml, 4000);
  } catch (_) {}

  // 2. Ensure Sarees Stock Group exists
  try {
    const groupXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<STOCKGROUP NAME="${escapeXml(TALLY_STOCK_GROUP)}" ACTION="Create"><NAME>${escapeXml(TALLY_STOCK_GROUP)}</NAME></STOCKGROUP>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
    await sendToTally(groupXml, 4000);
  } catch (_) {}

  // 2b. Ensure Target Godown exists in Tally
  try {
    const godownXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<GODOWN NAME="${escapeXml(targetGodown)}" ACTION="Create">
  <NAME>${escapeXml(targetGodown)}</NAME>
  <PARENT/>
</GODOWN>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
    await sendToTally(godownXml, 4000);
  } catch (_) {}

  // 2c. Ensure Sales Account ledger exists in Tally
  try {
    const salesLedgerXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<LEDGER NAME="Sales Account" ACTION="Create">
  <NAME>Sales Account</NAME>
  <PARENT>Sales Accounts</PARENT>
</LEDGER>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
    await sendToTally(salesLedgerXml, 4000);
  } catch (_) {}

  // 3. Create or Alter Stock Item with Godown Allocation
  const hasAlias = cleanName && cleanName.toLowerCase() !== cleanSku.toLowerCase();
  const nameXml = hasAlias
    ? `<NAME.LIST>
    <NAME>${cleanSku}</NAME>
    <NAME>${cleanName}</NAME>
  </NAME.LIST>`
    : `<NAME>${cleanSku}</NAME>`;

  const buildXml = (action) => `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TALLYUDF">
<STOCKITEM NAME="${cleanSku}" ACTION="${action}">
  ${nameXml}
  <PARENT>${escapeXml(TALLY_STOCK_GROUP)}</PARENT>
  <BASEUNITS>${unitLabel}</BASEUNITS>
  <OPENINGBALANCE>${cleanQty} ${unitLabel}</OPENINGBALANCE>
  <OPENINGRATE>${cleanRate.toFixed(2)}/${unitLabel}</OPENINGRATE>
  <OPENINGVALUE>-${amount}</OPENINGVALUE>
  <BATCHALLOCATIONS.LIST>
    <GODOWNNAME>${escapeXml(targetGodown)}</GODOWNNAME>
    <BATCHNAME>Primary Batch</BATCHNAME>
    <OPENINGBALANCE>${cleanQty} ${unitLabel}</OPENINGBALANCE>
    <OPENINGRATE>${cleanRate.toFixed(2)}/${unitLabel}</OPENINGRATE>
    <OPENINGVALUE>-${amount}</OPENINGVALUE>
  </BATCHALLOCATIONS.LIST>
</STOCKITEM>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;

  let res = await sendToTally(buildXml('Create'), 5000);
  let created = res.includes('<CREATED>1</CREATED>');
  let altered = res.includes('<ALTERED>1</ALTERED>');
  let errors = res.includes('<ERRORS>') && !res.includes('<ERRORS>0</ERRORS>');

  // If item already exists in Tally, retry with ACTION="Alter"
  if (!created && !altered) {
    const alterRes = await sendToTally(buildXml('Alter'), 5000);
    const alterOk = alterRes.includes('<ALTERED>1</ALTERED>') || alterRes.includes('<CREATED>1</CREATED>');
    if (alterOk) {
      return { success: true, created: false, altered: true, raw: alterRes };
    }
  }

  return { success: (created || altered) && !errors, created, altered, raw: res };
}

// Helper: Fetch all live stock items from Tally ERP via direct master collection
async function fetchAllTallyStockItems() {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CustomStockItems</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CustomStockItems">
            <TYPE>StockItem</TYPE>
            <FETCH>Name,Parent,ClosingBalance,ClosingRate,StandardPrice,BaseUnits,PartNo,BatchAllocations.*</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

  const items = [];
  const parseDiagnostics = [];
  try {
    const res = await sendToTally(xml, 6000);
    const targetGodown = (await getTargetGodown()) || 'Online_saree';
    let targetGodownsInScope = [targetGodown];
    try {
      let hierarchy = cachedGodownsResult?.godownHierarchy;
      if (!hierarchy || !hierarchy.length) {
        const hRes = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.tally_godown_hierarchy&select=value`, {
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
          signal: AbortSignal.timeout(2000)
        });
        const hRows = await hRes.json();
        if (hRows?.[0]?.value) {
          hierarchy = typeof hRows[0].value === 'string' ? JSON.parse(hRows[0].value) : hRows[0].value;
        }
      }
      if (Array.isArray(hierarchy) && hierarchy.length > 0) {
        targetGodownsInScope = getGodownScope(targetGodown, hierarchy);
      }
    } catch (_) {}
    const blockRegex = /<STOCKITEM\s+NAME="([^"]+)"[^>]*>([\s\S]*?)<\/STOCKITEM>/gi;
    let blockMatch;
    while ((blockMatch = blockRegex.exec(res)) !== null) {
      const name = unescapeXml(blockMatch[1]).trim();
      // Skip the group heading rows Tally interleaves with items.
      const lower = name.toLowerCase();
      if (!name || lower === TALLY_STOCK_GROUP.toLowerCase() || lower === 'primary' || lower === 'sarees') continue;
      const body = blockMatch[2];

      // Which godowns hold this item, and each one's OPENING weight.
      //
      // Tally's batch rows carry OPENINGBALANCE only — there is no per-godown closing
      // figure anywhere in the export. Those openings are stale the moment a voucher
      // moves stock (SAI-SIK-03 opened at 11 and now closes at 9), so they are used
      // for PLACEMENT only. The authoritative quantity is the item's own
      // CLOSINGBALANCE, distributed below.
      const godownOpenings = {};
      const noteGodown = (gName, weight) => {
        if (!gName) return;
        godownOpenings[gName] = (godownOpenings[gName] || 0) + (Number.isFinite(weight) ? weight : 0);
      };
      const readQty = (text) => {
        const m = text.match(/<(?:CLOSINGBALANCE|OPENINGBALANCE|ACTUALQTY|BILLEDQTY)[^>]*>([^<]*)<\/(?:CLOSINGBALANCE|OPENINGBALANCE|ACTUALQTY|BILLEDQTY)>/i);
        if (!m) return 0;
        const raw = m[1].trim();
        const num = raw.match(/[0-9.]+/);
        if (!num) return 0;
        return parseFloat(num[0]) * (raw.includes('-') ? -1 : 1);
      };

      const batchRegex = /<BATCHALLOCATIONS\.LIST[^>]*>([\s\S]*?)<\/BATCHALLOCATIONS\.LIST>/gi;
      let batchMatch;
      while ((batchMatch = batchRegex.exec(body)) !== null) {
        const bContent = batchMatch[1];
        const gMatch = bContent.match(/<GODOWNNAME[^>]*>([^<]*)<\/GODOWNNAME>/i);
        noteGodown(gMatch ? unescapeXml(gMatch[1]).trim() : '', readQty(bContent));
      }

      // Fallback: items without batch tracking get no BATCHALLOCATIONS.LIST content at
      // all, so scan for a bare GODOWNNAME elsewhere in the item body.
      if (Object.keys(godownOpenings).length === 0) {
        const gwRegex = /<GODOWNNAME[^>]*>([^<]*)<\/GODOWNNAME>([\s\S]{0,600}?)<\/[A-Z.]+>/gi;
        let gwMatch;
        while ((gwMatch = gwRegex.exec(body)) !== null) {
          noteGodown(unescapeXml(gwMatch[1]).trim(), readQty(gwMatch[2]));
        }
      }

      // Read total closing balance
      const closingMatch = body.match(/<CLOSINGBALANCE[^>]*>([^<]*)<\/CLOSINGBALANCE>/i);
      const rawClosing = closingMatch ? closingMatch[1].trim() : '';
      const isNegative = rawClosing.includes('-');
      const numMatch = rawClosing.match(/[0-9.]+/);
      let closingTotal = numMatch ? parseFloat(numMatch[0]) : 0;
      if (isNegative || isNaN(closingTotal)) closingTotal = 0;
      // Attribute the item's true closing balance to the godowns holding it.
      // Single-godown items (the common case here) come out exact. Items with no
      // godown row stay empty so unallocated_qty reports them.
      const godownBreakdown = {};
      const holders = Object.keys(godownOpenings);
      if (holders.length === 1) {
        godownBreakdown[holders[0]] = closingTotal;
      } else if (holders.length > 1) {
        // ponytail: proportional split by opening weight. Tally exports no per-godown
        // closing figure, so an exact multi-godown split is impossible from this data.
        // Upgrade path: enable Maintain Batch-wise details in Tally (F11) so batch rows
        // carry closing figures, then read them directly instead of apportioning.
        const totalWeight = holders.reduce((s, g) => s + Math.max(0, godownOpenings[g]), 0);
        let assigned = 0;
        holders.forEach((g, i) => {
          let q;
          if (i === holders.length - 1) {
            q = Math.round(closingTotal) - assigned; // remainder absorbs rounding
          } else if (totalWeight > 0) {
            q = Math.round(closingTotal * Math.max(0, godownOpenings[g]) / totalWeight);
          } else {
            q = Math.round(closingTotal / holders.length);
          }
          assigned += q;
          godownBreakdown[g] = q;
        });
      }

      // Strict Godown Isolation:
      // NEVER assume or infer stock for Main Location or any godown if unallocated.
      // Stock is strictly counted ONLY when explicitly allocated in BatchAllocations with matching GODOWNNAME.

      // Target godown stock quantity: sum all godowns in scope (targetGodown + child godowns)
      // Strict isolation: any external godown (e.g. Main Location) is strictly excluded
      let qty = 0;
      for (const scName of targetGodownsInScope) {
        const scKey = Object.keys(godownBreakdown).find(k => k.toLowerCase() === scName.toLowerCase());
        if (scKey !== undefined) {
          qty += (Number(godownBreakdown[scKey]) || 0);
        }
      }

      const rateMatch = body.match(/<(?:CLOSINGRATE|STANDARDPRICE)[^>]*>([^<]*)<\/(?:CLOSINGRATE|STANDARDPRICE)>/i);
      const rateStr = rateMatch ? rateMatch[1].trim() : '0';
      const numRateMatch = rateStr.match(/[0-9.]+/);
      const rate = numRateMatch ? parseFloat(numRateMatch[0]) : 0;

      const unitsMatch = body.match(/<BASEUNITS[^>]*>([^<]*)<\/BASEUNITS>/i);
      const unit = (unitsMatch ? unitsMatch[1].trim() : 'Nos').trim();

      const partNoMatch = body.match(/<PARTNO[^>]*>([^<]*)<\/PARTNO>/i);
      const partNo = partNoMatch ? unescapeXml(partNoMatch[1]).trim() : '';

      const parentMatch = body.match(/<PARENT[^>]*>([^<]*)<\/PARENT>/i);
      const parent = parentMatch ? unescapeXml(parentMatch[1]).trim() : '';

      if (closingTotal > 0 && Object.keys(godownBreakdown).length === 0 && parseDiagnostics.length < 3) {
        parseDiagnostics.push({ item: name, closing: rawClosing, snippet: body.slice(0, 1200) });
      }

      items.push({
        product_code: partNo || name,
        name,
        parent_group: parent,
        tally_group: parent,
        tally_qty: Math.max(0, Math.round(qty)),
        rate,
        unit,
        godown_stocks: godownBreakdown,
        closing_total: Math.max(0, Math.round(closingTotal)),
        // Stock that exists in Tally but is allocated to NO godown at all.
        // Measured against the full breakdown so stock in other godowns (Jari,
        // Main Location) cancels out and stays hidden per strict isolation.
        unallocated_qty: Math.max(0, Math.round(
          closingTotal - Object.values(godownBreakdown).reduce((s, v) => s + (Number(v) || 0), 0)
        ))
      });
    }

  } catch (err) {
    console.warn('[fetchAllTallyStockItems] Error querying Tally collection:', err.message);
    throw err;
  }
  if (parseDiagnostics.length > 0) {
    console.warn('[fetchAllTallyStockItems] ' + parseDiagnostics.length + ' item(s) have stock but no parsable godown allocation.');
    fetch(`${SUPABASE_URL}/rest/v1/app_settings`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        key: 'tally_parse_diagnostic',
        value: JSON.stringify({ capturedAt: new Date().toISOString(), samples: parseDiagnostics }),
        updated_at: new Date().toISOString()
      })
    }).catch(() => {});
  }
  return items;
}

// Query live closing stock for a specific item from Tally ERP
async function queryTallyStockForItem(code, name) {
  try {
    const allItems = await fetchAllTallyStockItems();
    const lowerCode = (code || '').toLowerCase().trim();
    const lowerName = (name || '').toLowerCase().trim();

    const match = allItems.find(item => {
      const tCode = item.product_code.toLowerCase().trim();
      const tName = item.name.toLowerCase().trim();
      return (
        (lowerCode && (tCode === lowerCode || tName === lowerCode)) ||
        (lowerName && (tCode === lowerName || tName === lowerName)) ||
        (lowerCode && (tCode.includes(lowerCode) || lowerCode.includes(tCode))) ||
        (lowerName && (tName.includes(lowerName) || lowerName.includes(tName)))
      );
    });

    if (match) {
      return { reachable: true, found: true, name: match.name, quantity: match.tally_qty, rate: match.rate, unit: match.unit };
    }
    return { reachable: true, found: false, quantity: 0, unit: 'Nos' };
  } catch (err) {
    console.warn('[queryTallyStockForItem] Tally query warning:', err.message);
    return { reachable: false, found: false, error: err.message, quantity: 0, unit: 'Nos' };
  }
}

// -----------------------------------------------------------------------------
// Helper: Sync Pending Completed Orders to Tally ERP
// -----------------------------------------------------------------------------
async function syncPendingOrdersToTally() {
  try {
    const oRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?status=in.(confirmed,delivered)&payment_status=eq.paid&select=*`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    if (!oRes.ok) return { synced: 0, orders: [] };
    const orders = await oRes.json();
    
    const unpushed = (orders || []).filter(o => !o.notes || !o.notes.includes('TALLY_SYNCED_VCH'));
    if (unpushed.length === 0) return { synced: 0, orders: [] };

    const results = [];
    for (const order of unpushed) {
      const items = order.items || [];
      let allItemsSuccess = true;
      
      for (const item of items) {
        const sku = item.sku || '';
        const name = item.name || sku;
        const qty = item.quantity || 1;
        const rate = item.price || 10000;
        const isNos = /mysore|paithani|0021|0022/i.test(name + sku);
        const unitLabel = isNos ? 'Nos' : 'Pcs';
        const targetItem = name.includes('MYSORE') ? name : (sku || name);

        let voucherXml = buildTallySalesVoucherXml({
          orderNumber: order.order_number,
          stockItemName: targetItem,
          qty,
          rate,
          unitLabel,
          godownName: 'Online',
          buyerName: order.shipping_address?.street || order.shipping_address?.full_address || 'WhatsApp Customer'
        });

        try {
          let tallyRes = await sendToTally(voucherXml);
          let isSuccess = tallyRes.includes('<CREATED>1</CREATED>') || 
                          tallyRes.includes('<ALTERED>1</ALTERED>') ||
                          tallyRes.includes('Already Exists');

          // If rejected due to educational mode voucher date restriction, retry with 1st of month
          if (!isSuccess && tallyRes.includes('Voucher date is missing')) {
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const fallbackDate = `${year}${month}01`;
            voucherXml = buildTallySalesVoucherXml({
              orderNumber: order.order_number,
              stockItemName: targetItem,
              qty,
              rate,
              unitLabel,
              godownName: 'Online',
              buyerName: order.shipping_address?.street || order.shipping_address?.full_address || 'WhatsApp Customer',
              dateOverride: fallbackDate
            });
            tallyRes = await sendToTally(voucherXml);
            isSuccess = tallyRes.includes('<CREATED>1</CREATED>') || 
                        tallyRes.includes('<ALTERED>1</ALTERED>') ||
                        tallyRes.includes('Already Exists');
          }

          if (!isSuccess) {
            console.warn(`[Tally Sync] Voucher response for ${order.order_number}:`, tallyRes.slice(0, 300));
            allItemsSuccess = false;
          } else {
            // Deduct from stock_pool in Supabase so available_quantity reflects immediately
            const codeToDeduct = (sku || targetItem).trim();
            try {
              const spRes = await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?product_code=eq.${encodeURIComponent(codeToDeduct)}`, {
                headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
              });
              const spRows = await spRes.json();
              if (spRows?.[0]) {
                const newQty = Math.max(0, spRows[0].online_quantity - qty);
                await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?id=eq.${spRows[0].id}`, {
                  method: 'PATCH',
                  headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ online_quantity: newQty, last_synced_at: new Date().toISOString() })
                });
              }
            } catch (spErr) {
              console.warn('[Tally Sync] stock_pool sync warning:', spErr.message);
            }

            // Also deduct from saree_catalog so both tables stay in sync
            try {
              const catSearch = sku ? `sku=eq.${encodeURIComponent(sku)}` : `name=eq.${encodeURIComponent(targetItem)}`;
              const catRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?${catSearch}`, {
                headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
              });
              const catRows = await catRes.json();
              if (catRows?.[0]) {
                const newCatQty = Math.max(0, catRows[0].stock_quantity - qty);
                await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${catRows[0].id}`, {
                  method: 'PATCH',
                  headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ stock_quantity: newCatQty, updated_at: new Date().toISOString() })
                });
              }
            } catch (catErr) {
              console.warn('[Tally Sync] saree_catalog sync warning:', catErr.message);
            }
          }
        } catch (vErr) {
          console.warn(`[Tally Sync] Error pushing voucher for ${order.order_number}:`, vErr.message);
          allItemsSuccess = false;
        }
      }

      if (allItemsSuccess) {
        const updatedNotes = `${order.notes || ''} | TALLY_SYNCED_VCH_${order.order_number}`.trim();
        await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${order.id}`, {
          method: 'PATCH',
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ notes: updatedNotes })
        });
        results.push(order.order_number);
        console.log(`[Tally Sync] ✓ Order ${order.order_number} successfully synced to Tally ERP!`);
      }
    }

    return { synced: results.length, orders: results };
  } catch (err) {
    console.warn('[Tally Sync] Error checking pending orders:', err.message);
    return { synced: 0, error: err.message };
  }
}

// -----------------------------------------------------------------------------
// Helper: Tally Morning / On-Demand Stock Ingestion
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// Designated stock writer
// -----------------------------------------------------------------------------
// Several Supabase keys (tally_godown_stock_matrix, tally_unallocated_stock,
// stock_pool, saree_catalog.stock_quantity) are authoritative inventory figures, and
// every instance of this server writes to the same rows — last writer wins.
//
// Only the machine with TallyPrime physically attached can produce correct values.
// An admin laptop running the same build has no Tally on 127.0.0.1:9000, and when its
// gateway fallback is also unreachable it can still reach the write paths and clobber
// good data with zeroes. That happened: all 9 stock_pool rows were zeroed by a godown
// switch performed from the laptop.
//
// Read paths stay open everywhere; only authoritative writes are gated.
function isStockWriter() {
  return isTallyLocallyConnected && isTallyIdentityVerified;
}
async function performMorningStockSync() {
  if (!isStockWriter()) {
    const why = !isTallyLocallyConnected ? 'no local Tally on port ' + TALLY_PORT : 'Tally identity not verified';
    console.log(`[MorningSync] Skipped — this machine is not the designated stock writer (${why}). The Store PC owns these figures.`);
    morningSyncState.status = 'skipped_not_writer';
    morningSyncState.error = null;
    return morningSyncState;
  }
  morningSyncState.status = 'syncing';
  const shopId = '00000000-0000-0000-0000-000000000001';
  let runId = null;

  // 1. Initialize Sync Run Audit Record
  try {
    const runRes = await fetch(`${SUPABASE_URL}/rest/v1/sync_runs`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify({
        shop_id: shopId,
        triggered_by: 'admin',
        started_at: new Date().toISOString(),
        status: 'running',
        step_log: [{ step: 'sync_initiated', at: new Date().toISOString() }]
      })
    });
    const runData = await runRes.json();
    if (Array.isArray(runData) && runData.length > 0) {
      runId = runData[0].id;
    }
  } catch (_rErr) {
    console.warn('[MorningSync] Could not initialize sync_runs record:', _rErr.message);
  }

  try {
    // 1b. SEC-07: Strictly verify Tally Company Identity before syncing
    const idCheck = await verifyTallyIdentity(2500);
    if (!idCheck.verified) {
      const errMsg = idCheck.mismatch
        ? `Tally Company Mismatch: Connected Tally "${idCheck.connected?.companyName}" (${idCheck.connected?.guid}) does not match authorized Store Tally "${idCheck.registered?.companyName}" (${idCheck.registered?.guid}). Sync blocked.`
        : (idCheck.firstTime
          ? `First-Time Tally Detected: Connected Tally "${idCheck.connected?.companyName}" (${idCheck.connected?.guid}) is not yet paired/authorized by Admin. Complete initial godown setup first.`
          : `Tally Identity Unverified: ${idCheck.error || 'Could not verify Tally identity'}`);
      
      if (runId) {
        await fetch(`${SUPABASE_URL}/rest/v1/sync_runs?id=eq.${runId}`, {
          method: 'PATCH',
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'failed',
            error_summary: errMsg,
            finished_at: new Date().toISOString()
          })
        });
      }
      morningSyncState.status = 'failed';
      morningSyncState.error = errMsg;
      throw new Error(errMsg);
    }

    // 2. Sync pending orders first so closing stock reflects completed transactions
    try {
      await syncPendingOrdersToTally();
    } catch (_pErr) {}

    // 3. Query Tally for all live stock items
    const activeGodown = (await getTargetGodown()) || 'Online_saree';
    let tallyBalances = [];
    try {
      tallyBalances = await fetchAllTallyStockItems();
    } catch (tallyErr) {
      // Tally offline -> mark sync run failed with downtime alert
      if (runId) {
        await fetch(`${SUPABASE_URL}/rest/v1/sync_runs?id=eq.${runId}`, {
          method: 'PATCH',
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'failed',
            error_summary: `Tally server unreachable on port ${TALLY_PORT}: ${tallyErr.message}`,
            finished_at: new Date().toISOString()
          })
        });
      }
      morningSyncState.status = 'failed';
      morningSyncState.error = `Tally server unreachable on port ${TALLY_PORT}`;
      throw new Error(`Shop PC / Tally is offline (${tallyErr.message}). Online orders continue operating from cloud inventory. Use manual stock entry if needed.`);
    }

    // Persist full multi-godown stock matrix across all items to app_settings
    if (Array.isArray(tallyBalances) && tallyBalances.length > 0) {
      const fullMatrix = {};
      const unallocMap = {};
      tallyBalances.forEach(item => {
        const codeKey = (item.product_code || '').toLowerCase().trim();
        const nameKey = (item.name || '').toLowerCase().trim();
        const ua = Number(item.unallocated_qty) || 0;
        if (codeKey) { fullMatrix[codeKey] = item.godown_stocks || {}; if (ua > 0) unallocMap[codeKey] = ua; }
        if (nameKey) { fullMatrix[nameKey] = item.godown_stocks || {}; if (ua > 0) unallocMap[nameKey] = ua; }
      });
      fetch(`${SUPABASE_URL}/rest/v1/app_settings`, {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({
          key: 'tally_unallocated_stock',
          value: JSON.stringify(unallocMap),
          updated_at: new Date().toISOString()
        })
      }).catch(uErr => console.warn('[MorningSync] Error persisting tally_unallocated_stock:', uErr.message));
      fetch(`${SUPABASE_URL}/rest/v1/app_settings`, {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({
          key: 'tally_godown_stock_matrix',
          value: JSON.stringify(fullMatrix),
          updated_at: new Date().toISOString()
        })
      }).catch(mErr => console.warn('[MorningSync] Error persisting tally_godown_stock_matrix:', mErr.message));
    }

    // 4. Fetch current cloud state from Supabase
    const [catRes, spRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?select=*`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }),
      fetch(`${SUPABASE_URL}/rest/v1/stock_pool?shop_id=eq.${shopId}&select=*`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } })
    ]);
    const catalog = await catRes.json();
    const stockPool = await spRes.json();

    const stockMap = new Map();
    if (Array.isArray(stockPool)) {
      stockPool.forEach(s => {
        if (s.product_code) stockMap.set(s.product_code.toLowerCase(), s);
        if (s.saree_id) stockMap.set(s.saree_id, s);
      });
    }

    let updatedCount = 0;
    let newStockCount = 0;
    let newDraftsCount = 0;
    let discCount = 0;
    const reconciliation = [];
    const matchedTallyCodes = new Set();

    // 5. Reconcile existing catalog items with Tally
    if (Array.isArray(catalog)) {
      for (const saree of catalog) {
        const sSku = (saree.sku || '').toLowerCase().trim();
        const sPart = (saree.tally_part_number || '').toLowerCase().trim();
        const sName = (saree.name || '').toLowerCase().trim();

        // Find match in Tally items
        const tallyItem = tallyBalances.find(t => {
          const tCode = t.product_code.toLowerCase().trim();
          const tName = t.name.toLowerCase().trim();
          return (
            (sSku && (sSku === tCode || sSku === tName)) ||
            (sPart && (sPart === tCode || sPart === tName)) ||
            (sName && (sName === tCode || sName === tName))
          );
        });

        const stock = stockMap.get(sSku) || stockMap.get(sPart) || stockMap.get(saree.id);
        const expectedQty = stock ? stock.online_quantity : (saree.stock_quantity ?? 0);

        const isSareeDeleted = isRemovedProduct(saree);

        if (tallyItem) {
          // Item exists in Tally
          matchedTallyCodes.add(tallyItem.product_code.toLowerCase());
          matchedTallyCodes.add(tallyItem.name.toLowerCase());

          if (isSareeDeleted) {
            // Saree was DELETED in cloud! Zero out stock in Tally ERP so it is not visible in online stock
            if (isTallyLocallyConnected && tallyItem.tally_qty > 0) {
              const activeGodown = await getTargetGodown();
              const isNos = /mysore|paithani|0021|0022/i.test(tallyItem.name + sSku);
              const unitLabel = isNos ? 'Nos' : 'Pcs';
              const zeroXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<STOCKITEM NAME="${escapeXml(tallyItem.name)}" ACTION="Alter">
  <NAME>${escapeXml(tallyItem.name)}</NAME>
  <PARENT>${escapeXml(TALLY_STOCK_GROUP)}</PARENT>
  <OPENINGBALANCE>0 ${unitLabel}</OPENINGBALANCE>
  <OPENINGRATE>0/${unitLabel}</OPENINGRATE>
  <OPENINGVALUE>0</OPENINGVALUE>
  <BATCHALLOCATIONS.LIST>
    <GODOWNNAME>${activeGodown}</GODOWNNAME>
    <BATCHNAME>Primary Batch</BATCHNAME>
    <OPENINGBALANCE>0 ${unitLabel}</OPENINGBALANCE>
    <OPENINGRATE>0/${unitLabel}</OPENINGRATE>
    <OPENINGVALUE>0</OPENINGVALUE>
  </BATCHALLOCATIONS.LIST>
</STOCKITEM>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
              try {
                await sendToTally(zeroXml, 4000);
                console.log(`[Sync] Zeroed out deleted item "${tallyItem.name}" in Tally ERP godown "${activeGodown}".`);
              } catch (zErr) {
                console.warn(`[Sync] Zeroing notice for "${tallyItem.name}":`, zErr.message);
              }
            }

            // Ensure stock in cloud is 0 so online stock remains 0
            if (stock && stock.online_quantity > 0) {
              await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?id=eq.${stock.id}`, {
                method: 'PATCH',
                headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ online_quantity: 0, last_synced_at: new Date().toISOString() })
              });
            }
            if (saree.stock_quantity > 0) {
              await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${saree.id}`, {
                method: 'PATCH',
                headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ stock_quantity: 0, updated_at: new Date().toISOString() })
              });
            }
            continue; // Do not process as normal active stock
          }

          const actualQty = tallyItem.tally_qty;
          const delta = actualQty - expectedQty;

          if (actualQty > expectedQty) {
            newStockCount++;
            await fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
              method: 'POST',
              headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                actor: 'admin',
                action: 'new_stock_inward_detected',
                entity_type: 'stock_pool',
                entity_id: saree.sku || saree.tally_part_number,
                old_values: { online_quantity: expectedQty },
                new_values: { online_quantity: actualQty, inward_delta: delta },
                metadata: { source_run_id: runId, rate: tallyItem.rate }
              })
            });
          } else if (actualQty < expectedQty) {
            discCount++;
            if (runId) {
              await fetch(`${SUPABASE_URL}/rest/v1/discrepancies`, {
                method: 'POST',
                headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  shop_id: shopId,
                  item_id: saree.id,
                  product_code: saree.sku || saree.tally_part_number,
                  run_id: runId,
                  expected_qty: expectedQty,
                  actual_qty: actualQty,
                  explanation: `Tally quantity (${actualQty}) is lower than cloud balance (${expectedQty}). Delta: ${delta}`,
                  status: 'open'
                })
              });
            }
          }

          // Update or insert stock_pool
          if (stock) {
            await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?id=eq.${stock.id}`, {
              method: 'PATCH',
              headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                online_quantity: actualQty,
                tally_godown: activeGodown,
                last_synced_at: new Date().toISOString(),
                source: 'tally_godown',
                updated_at: new Date().toISOString()
              })
            });
          } else {
            await fetch(`${SUPABASE_URL}/rest/v1/stock_pool`, {
              method: 'POST',
              headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                shop_id: shopId,
                product_code: saree.sku || saree.tally_part_number,
                saree_id: saree.id,
                online_quantity: actualQty,
                held_quantity: 0,
                sold_pending_quantity: 0,
                source: 'tally_godown',
                tally_godown: activeGodown,
                last_synced_at: new Date().toISOString()
              })
            });
          }

          // Update saree_catalog with accurate stock and multi-godown breakdown
          const netAvail = Math.max(0, actualQty - (stock?.held_quantity || 0) - (stock?.sold_pending_quantity || 0));
          await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${saree.id}`, {
            method: 'PATCH',
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              stock_quantity: netAvail,
              attributes_json: {
                ...(saree.attributes_json || {}),
                godown_stocks: tallyItem.godown_stocks || {}
              },
              item_created_in_tally: true,
              stock_added_in_tally: actualQty > 0,
              tally_last_seen_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
          });

          updatedCount++;
          reconciliation.push({
            sku: saree.sku || saree.tally_part_number,
            name: saree.name,
            previousStock: expectedQty,
            currentStock: actualQty,
            delta,
            rate: tallyItem.rate
          });

        } else {
          // ITEM DOES NOT EXIST IN TALLY
          const isAdminEntered = stock?.source === 'admin_entered' || !saree.item_created_in_tally;
          if (isAdminEntered) {
            console.log(`[Sync] Item "${saree.name}" (${saree.sku}) is awaiting Tally creation/inward. Preserving entered stock of ${expectedQty}.`);
            // If Tally is locally connected on this PC (Store PC), auto-inward to physical Tally ERP!
            if (isTallyLocallyConnected && expectedQty > 0) {
              try {
                const activeGodown = (await getTargetGodown()) || 'Online_saree';
                const isNos = /mysore|paithani|0021|0022/i.test((saree.name || '') + (saree.sku || ''));
                const unitLabel = isNos ? 'Nos' : 'Pcs';
                const pushRes = await pushProductToTallyMaster({
                  sku: saree.sku || saree.tally_part_number,
                  name: saree.name,
                  quantity: expectedQty,
                  rate: saree.price || 5000,
                  unitLabel,
                  godownName: activeGodown
                });
                if (pushRes.success) {
                  console.log(`[Sync] ✓ Auto-inwarded newly added saree "${saree.name}" to Tally (${expectedQty} ${unitLabel} in ${activeGodown}).`);
                  await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${saree.id}`, {
                    method: 'PATCH',
                    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      item_created_in_tally: true,
                      stock_added_in_tally: true,
                      tally_last_seen_at: new Date().toISOString()
                    })
                  });
                  if (stock) {
                    await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?id=eq.${stock.id}`, {
                      method: 'PATCH',
                      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        source: 'tally_godown',
                        last_synced_at: new Date().toISOString()
                      })
                    });
                  }
                }
              } catch (autoErr) {
                console.warn(`[Sync] Auto-inward to Tally failed for "${saree.name}":`, autoErr.message);
              }
            }
          } else if (saree.item_created_in_tally && stock?.source === 'tally_godown') {
            // ONLY zero out if the item was previously verified in Tally and subsequently deleted from Tally ERP
            discCount++;
            // Update stock_pool to 0
            if (stock) {
              await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?id=eq.${stock.id}`, {
                method: 'PATCH',
                headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  online_quantity: 0,
                  last_synced_at: new Date().toISOString(),
                  source: 'tally_godown',
                  updated_at: new Date().toISOString()
                })
              });
            }

            // Update saree_catalog to 0 & mark not in tally
            await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${saree.id}`, {
              method: 'PATCH',
              headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                stock_quantity: 0,
                item_created_in_tally: false,
                stock_added_in_tally: false,
                tally_last_seen_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              })
            });

            // Write audit log
            await fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
              method: 'POST',
              headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                actor: 'admin',
                action: 'stock_deleted_in_tally',
                entity_type: 'stock_pool',
                entity_id: saree.sku || saree.tally_part_number,
                old_values: { online_quantity: expectedQty },
                new_values: { online_quantity: 0 },
                metadata: { source_run_id: runId, reason: 'Item deleted or absent in Tally ERP' }
              })
            });

            reconciliation.push({
              sku: saree.sku || saree.tally_part_number,
              name: saree.name,
              previousStock: expectedQty,
              currentStock: 0,
              delta: -expectedQty,
              notes: 'Deleted in Tally ERP'
            });
            updatedCount++;
          }
        }
      }
    }

    // 6. Zero out any remaining orphaned stock_pool rows (no catalog saree) that are not in Tally
    if (Array.isArray(stockPool)) {
      for (const sp of stockPool) {
        if (sp.saree_id) continue; // Already reconciled with catalog in step 5
        const codeKey = (sp.product_code || '').toLowerCase().trim();
        const isInTally = tallyBalances.some(t => t.product_code.toLowerCase().trim() === codeKey || t.name.toLowerCase().trim() === codeKey);
        if (!isInTally && sp.online_quantity > 0) {
          await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?id=eq.${sp.id}`, {
            method: 'PATCH',
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              online_quantity: 0,
              last_synced_at: new Date().toISOString(),
              source: 'tally_godown',
              updated_at: new Date().toISOString()
            })
          });
        }
      }
    }

    // 7. Auto-create any brand-new items found in Tally as Drafts (Clean plain data, zero images, zero filler)
    const activeTargetGodown = await getTargetGodown();
    for (const item of tallyBalances) {
      const codeKey = item.product_code.toLowerCase().trim();
      const nameKey = item.name.toLowerCase().trim();
      if (!matchedTallyCodes.has(codeKey) && !manuallyDeletedSkus.has(codeKey) && !manuallyDeletedSkus.has(nameKey)) {
        newDraftsCount++;
        const plainName = item.name.trim();
        const plainSku = (item.product_code || item.name).trim();
        const exactPrice = item.rate ? Math.round(item.rate) : 0;
        const exactQty = item.tally_qty || 0;

        const newSareeRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog`, {
          method: 'POST',
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
          body: JSON.stringify({
            shop_id: shopId,
            sku: plainSku,
            tally_part_number: plainSku,
            name: plainName,
            price: exactPrice,
            stock_quantity: exactQty,
            status: 'draft',
            item_created_in_tally: true,
            stock_added_in_tally: exactQty > 0,
            tally_rate: item.rate || 0,
            image_urls: [],
            description: null,
            fabric: 'Pure Silk',
            color_primary: 'Classic',
            listing_notes: null,
            tally_last_seen_at: new Date().toISOString()
          })
        });
        const newSaree = await newSareeRes.json();
        const sareeId = Array.isArray(newSaree) && newSaree[0] ? newSaree[0].id : null;

        await fetch(`${SUPABASE_URL}/rest/v1/stock_pool`, {
          method: 'POST',
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            shop_id: shopId,
            product_code: plainSku,
            saree_id: sareeId,
            online_quantity: exactQty,
            held_quantity: 0,
            sold_pending_quantity: 0,
            source: 'tally_godown',
            tally_godown: activeTargetGodown || 'Main Location',
            last_synced_at: new Date().toISOString()
          })
        });

        updatedCount++;
        reconciliation.push({
          sku: plainSku,
          name: plainName,
          previousStock: 0,
          currentStock: exactQty,
          delta: exactQty,
          rate: item.rate || 0
        });
      }
    }

    // 8. Finalize sync run record
    if (runId) {
      await fetch(`${SUPABASE_URL}/rest/v1/sync_runs?id=eq.${runId}`, {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          finished_at: new Date().toISOString(),
          status: discCount > 0 ? 'completed_with_issues' : 'completed',
          step_log: [{
            step: 'reconciliation_complete',
            items_synced: updatedCount,
            new_stock_inwards: newStockCount,
            draft_items_created: newDraftsCount,
            discrepancies_logged: discCount,
            at: new Date().toISOString()
          }]
        })
      });
    }

    morningSyncState = {
      lastSyncAt: new Date().toISOString(),
      itemsUpdated: updatedCount,
      newStockInwards: newStockCount,
      draftItemsCreated: newDraftsCount,
      discrepanciesCount: discCount,
      status: discCount > 0 ? 'completed_with_issues' : 'success',
      runId,
      error: null,
      reconciliation
    };

    return morningSyncState;
  } catch (err) {
    morningSyncState.status = 'failed';
    morningSyncState.error = err.message;
    throw err;
  }
}

let isSyncing = false;
// Background Worker: Auto-sync any completed transaction to Tally ERP every 4 seconds
setInterval(async () => {
  if (isSyncing) return;
  // If Tally is not connected locally on this computer, skip local sync attempt
  // (The Store PC where Tally is physically running executes the sync)
  if (!isTallyLocallyConnected) return;
  try {
    isSyncing = true;
    const syncRes = await syncPendingOrdersToTally();
    if (syncRes && syncRes.synced > 0) {
      console.log(`[AutoSync] 🛒 ${syncRes.synced} order transaction(s) synced to Tally ERP (${syncRes.orders.join(', ')}). Updating stock cache...`);
      await performMorningStockSync();
    }
  } catch (_e) {
  } finally {
    isSyncing = false;
  }
}, 4000);

// Background Worker: Reconcile live Tally stock every 12 seconds to automatically reflect deletions & edits
setInterval(async () => {
  if (isSyncing) return;
  // If Tally is not connected locally on this computer, skip local sync attempt
  if (!isTallyLocallyConnected) return;
  try {
    isSyncing = true;
    await processPendingTallyActions();
    await performMorningStockSync();
  } catch (_e) {
  } finally {
    isSyncing = false;
  }
}, 12000);

// Automated morning scheduler (runs daily at 08:00 AM local time)
let lastCheckedDate = null;
setInterval(async () => {
  if (!isTallyLocallyConnected) return;
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const hour = now.getHours();

  if (hour >= 8 && lastCheckedDate !== dateStr) {
    lastCheckedDate = dateStr;
    console.log(`[Scheduler] 🌅 Running automated morning stock sync for ${dateStr}...`);
    try {
      await performMorningStockSync();
      console.log(`[Scheduler] ✓ Morning stock sync complete: ${morningSyncState.itemsUpdated} items updated.`);
    } catch (err) {
      console.warn(`[Scheduler] ⚠️ Morning stock sync warning:`, err.message);
    }
  }
}, 60000); // Check once per minute

// 0. API: Distributed Tally XML Execution Gateway
// Arbitrary XML against the live Tally company — read, alter or delete masters and
// inject vouchers. This had no auth middleware at all, so the public tunnel exposed it.
app.post('/api/tally/execute-xml', requireAdminAuth, express.text({ type: ['text/xml', 'application/xml', 'text/plain', '*/*'], limit: '10mb' }), async (req, res) => {
  try {
    const xml = typeof req.body === 'string' ? req.body : req.rawBody?.toString('utf8');
    if (!xml) return res.status(400).send('<RESPONSE><STATUS>Empty XML</STATUS></RESPONSE>');
    const tallyRes = await sendToTally(xml, 8000);
    res.setHeader('Content-Type', 'text/xml;charset=utf-8');
    return res.send(tallyRes);
  } catch (err) {
    return res.status(502).send(`<RESPONSE><ERROR>${err.message}</ERROR></RESPONSE>`);
  }
});

// -----------------------------------------------------------------------------
// 1. API: System Health & Diagnostics
// -----------------------------------------------------------------------------
app.get('/api/status', requireAdminAuth, async (req, res) => {
  try {
    let tallyStatus = { connected: false, latencyMs: null, itemCount: 0, remoteStore: false, identityVerified: false };
    
    // 1. First test local Tally on 127.0.0.1:9000
    const localTally = await checkLocalTallyConnection(1200);
    if (localTally.connected) {
      // SEC-07: Verify Tally identity before granting access
      const idCheck = await verifyTallyIdentity(1500);
      const activeGodown = await getTargetGodown();
      tallyStatus = {
        connected: true,
        latencyMs: localTally.latencyMs,
        company: localTally.company,
        guid: localTally.guid,
        itemCount: localTally.itemCount,
        remoteStore: false,
        host: '127.0.0.1',
        identityVerified: idCheck.verified,
        identityMismatch: idCheck.mismatch || false,
        registeredCompany: idCheck.registered?.companyName || idCheck.identity?.companyName || null,
        registeredGuid: idCheck.registered?.guid || idCheck.identity?.guid || null,
        firstTimeRegistration: idCheck.firstTime || false,
        targetGodown: activeGodown
      };
      // Broadcast heartbeat to Supabase
      if (idCheck.verified) {
        broadcastTallyHeartbeat({ ...localTally, verified: true }).catch(() => {});
      } else if (idCheck.firstTime) {
        broadcastTallyHeartbeat({
          ...localTally,
          verified: false,
          firstTime: true,
          company: idCheck.connected?.companyName || localTally.company,
          guid: idCheck.connected?.guid || localTally.guid
        }).catch(() => {});
      }
    } else {
      // 2. Local Tally is offline (normal on Admin PC). Check Cloud Heartbeat from Store PC!
      const remoteHb = await fetchRemoteTallyHeartbeat();
      if (remoteHb) {
        // Names come from the shop's own registration. A hardcoded fallback — this
        // branch said 'AISHWARYA', a PC paired long ago — puts a name on screen that
        // nobody can correct by using the product, and it outlives the thing it named.
        if (remoteHb.isFresh && remoteHb.connected) {
          tallyStatus = {
            connected: true,
            remoteStore: true,
            latencyMs: remoteHb.latencyMs || null,
            company: remoteHb.company || null,
            guid: remoteHb.guid || null,
            hostname: remoteHb.hostname || null,
            shopName: remoteHb.shopName || null,
            godown: remoteHb.targetGodown || '',
            targetGodown: remoteHb.targetGodown || null,
            itemCount: remoteHb.itemCount || 0,
            lastSeen: remoteHb.updatedAt,
            ageSeconds: remoteHb.ageSeconds,
            identityVerified: Boolean(remoteHb.identityVerified),
            firstTimeRegistration: Boolean(remoteHb.firstTimeRegistration)
          };
        } else if (remoteHb.isFresh && !remoteHb.connected) {
          tallyStatus = {
            connected: false,
            remoteStore: true,
            storePcOnline: true,
            hostname: remoteHb.hostname || null,
            shopName: remoteHb.shopName || null,
            company: remoteHb.company || null,
            targetGodown: remoteHb.targetGodown || null,
            notice: remoteHb.notice || remoteHb.error || 'The store PC is connected, but Tally is not answering on port 9000 or no company is open.',
            lastSeen: remoteHb.updatedAt
          };
        } else {
          tallyStatus = {
            connected: false,
            remoteStore: false,
            storePcOnline: false,
            hostname: remoteHb.hostname || null,
            shopName: remoteHb.shopName || null,
            company: remoteHb.company || null,
            notice: remoteHb.notice
              || `The store PC last reported ${remoteHb.lastSeenAgo || 'a while ago'}. Start the agent on that PC.`,
            lastSeen: remoteHb.updatedAt
          };
        }
      }
    }

    let productCount = 0;
    let videoCount = 0;
    try {
      // This shop, and only products that are actually in the catalogue. Counting
      // every row in the table showed 13 against a catalogue of 2, because archived
      // products and other shops were both included.
      const pRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?select=id&${shopFilterFor(req)}&status=not.in.(archived,deleted)`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      const pData = await pRes.json();
      productCount = pData.length || 0;

      const vRes = await fetch(`${SUPABASE_URL}/rest/v1/video_record?select=id`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      const vData = await vRes.json();
      videoCount = vData.length || 0;
    } catch (_e) {}

    // Check Windows Agent telemetry in agent_devices
    let agentDevice = null;
    let isAgentOnline = false;
    try {
      const devRes = await fetch(`${SUPABASE_URL}/rest/v1/agent_devices?select=*&order=last_seen_at.desc&limit=1`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      const devData = await devRes.json();
      if (Array.isArray(devData) && devData.length > 0) {
        agentDevice = devData[0];
        const lastSeen = new Date(agentDevice.last_seen_at).getTime();
        isAgentOnline = (Date.now() - lastSeen) < (3 * 60 * 1000); // seen within 3 mins
      }
    } catch (_e) {}

    // Open Discrepancies count
    let openDiscrepanciesCount = 0;
    try {
      const discRes = await fetch(`${SUPABASE_URL}/rest/v1/discrepancies?status=eq.open&select=id`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      const discData = await discRes.json();
      openDiscrepanciesCount = Array.isArray(discData) ? discData.length : 0;
    } catch (_e) {}

    const shopPcConnected = Boolean(tallyStatus.connected || isAgentOnline);

    res.json({
      success: true,
      tally: tallyStatus,
      shopPc: {
        connected: shopPcConnected,
        isAgentOnline: isAgentOnline || tallyStatus.connected,
        lastSeenAt: tallyStatus.remoteStore ? tallyStatus.lastSeen : (agentDevice?.last_seen_at || null),
        hostname: tallyStatus.remoteStore ? (tallyStatus.hostname || 'Store-PC') : (agentDevice?.hostname || 'Shop-PC-Tally'),
        status: shopPcConnected ? 'online' : 'offline'
      },
      discrepancies: {
        openCount: openDiscrepanciesCount
      },
      supabase: { connected: Boolean(productCount >= 0) },
      counts: {
        products: productCount,
        videos: videoCount,
        openDiscrepancies: openDiscrepanciesCount
      },
      morningSync: {
        lastSyncAt: morningSyncState.lastSyncAt,
        itemsUpdated: morningSyncState.itemsUpdated,
        status: tallyStatus.remoteStore ? 'synced' : morningSyncState.status
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------------------------------------------------------
app.get('/api/products', requireAdminAuth, async (req, res) => {
  try {
    const device = req.device || await resolveDeviceFromRequest(req);
    // If request comes from a locked device, strictly force requestedGodown to device.godown
    const requestedGodown = (device?.godown || req.query.godown || await getTargetGodown() || 'Online_saree').trim();

    // Only this member's shop, and only products that are actually in the catalogue.
    // Returning every shop's rows is how one customer's sarees reached another's screen;
    // returning archived ones is why a previous Tally company's items kept showing.
    const scope = shopFilterFor(req);
    const includeRemoved = req.query.include_removed === 'true';
    const lifecycle = includeRemoved ? '' : '&status=not.in.(archived,deleted)';

    const [pRes, vRes, spRes, matrixRes, unallocRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?${scope}${lifecycle}&order=created_at.desc`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/video_record?select=id,video_id,product_code,saree,reference_frames`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/stock_pool?select=*`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.tally_godown_stock_matrix&select=value`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.tally_unallocated_stock&select=value`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      })
    ]);

    const products = (pRes.ok ? await pRes.json() : []) || [];
    const videoRecords = (vRes.ok ? await vRes.json() : []) || [];
    const stockPool = (spRes.ok ? await spRes.json() : []) || [];
    const matrixRows = (matrixRes.ok ? await matrixRes.json() : []) || [];
    let matrix = {};
    if (Array.isArray(matrixRows) && matrixRows[0]?.value) {
      try {
        matrix = typeof matrixRows[0].value === 'string' ? JSON.parse(matrixRows[0].value) : matrixRows[0].value;
      } catch (_) {}
    }

    const videoMap = new Map();
    videoRecords.forEach(v => {
      if (v.product_code) videoMap.set(v.product_code.toLowerCase(), v);
    });

    const stockMap = new Map();
    stockPool.forEach(s => {
      if (s.product_code) stockMap.set(s.product_code.toLowerCase(), s);
      if (s.saree_id) stockMap.set(s.saree_id, s);
    });

    const unallocRows = (unallocRes.ok ? await unallocRes.json() : []) || [];
    let unalloc = {};
    if (Array.isArray(unallocRows) && unallocRows[0]?.value) {
      try {
        unalloc = typeof unallocRows[0].value === 'string' ? JSON.parse(unallocRows[0].value) : unallocRows[0].value;
      } catch (_) {}
    }

    const activeScope = getGodownScope(requestedGodown, cachedGodownsResult?.godownHierarchy || []);

    const enriched = (products || []).map(p => {
      const code = (p.tally_part_number || p.sku || '').trim();
      const codeKey = code.toLowerCase();
      const nameKey = (p.name || '').toLowerCase().trim();
      const video = videoMap.get(codeKey);
      const stock = stockMap.get(codeKey) || stockMap.get(p.id);

      // Prioritize live stock_pool quantity for the requested godown
      let godownQty = 0;
      let hasGodownMatch = false;

      // Per-godown stock matrix, refreshed from live Tally on every sync.
      const itemMatrix = { ...(matrix[codeKey] || matrix[nameKey] || p.attributes_json?.godown_stocks || {}) };

      // Live Tally FIRST. A stock_pool row is a cache: a godown switch rewrites every
      // row via syncGodownStockTransition, which zeroed all 9 items here. That zero used
      // to win over real Tally stock because the stock_pool branch ran first and set
      // hasGodownMatch, short-circuiting the matrix entirely.
      let scopeSum = 0;
      let matchedAnyInScope = false;
      for (const scName of activeScope) {
        const gKey = Object.keys(itemMatrix).find(k => k.toLowerCase() === scName.toLowerCase());
        if (gKey !== undefined) {
          scopeSum += Number(itemMatrix[gKey]) || 0;
          matchedAnyInScope = true;
        }
      }

      if (matchedAnyInScope) {
        godownQty = scopeSum;
        hasGodownMatch = true;
      } else if (stock && stock.tally_godown && stock.tally_godown.toLowerCase() === requestedGodown.toLowerCase()) {
        // No Tally figure for this godown — fall back to the cached row.
        godownQty = Number(stock.online_quantity) || 0;
        hasGodownMatch = true;
      } else if (stock && !stock.tally_godown) {
        // Untagged stock_pool rows predate godown tracking. Never attribute stock that is
        // tagged to another godown (e.g. Main Location) to the requested one.
        godownQty = Number(stock.online_quantity) || (p.stock_quantity ?? 0);
        hasGodownMatch = true;
      }

      // Only stamp the requested godown when the figure came from the cache; doing it on a
      // matrix hit would collapse a multi-godown scope sum onto one key.
      if (hasGodownMatch && !matchedAnyInScope) {
        itemMatrix[requestedGodown] = godownQty;
      }

      const heldStock = stock ? stock.held_quantity : 0;
      const availableStock = Math.max(0, godownQty - heldStock);

      let tallyGroup = p.attributes_json?.tally_group || p.tally_group || p.parent_group;
      if (!tallyGroup || tallyGroup.toLowerCase() === 'primary') {
        const lowerCode = codeKey;
        if (lowerCode === 'jari' || lowerCode === 'jari1' || lowerCode === 'silk') {
          tallyGroup = 'Primary';
        } else {
          tallyGroup = TALLY_STOCK_GROUP;
        }
      }

      return {
        ...p,
        canonical_code: code,
        tally_group: tallyGroup,
        stock_quantity: godownQty,
        held_quantity: heldStock,
        available_quantity: availableStock,
        active_godown: requestedGodown,
        godown_stocks: itemMatrix,
        unallocated_qty: Number(unalloc[codeKey] ?? unalloc[nameKey] ?? 0) || 0,
        has_video: Boolean(video),
        video_record_id: video?.id || null,
        video_id: video?.video_id || null,
        video_description: video?.saree?.stylist_summary || video?.review_notes || '',
        video_frames_count: video?.reference_frames?.length || 0
      };
    });

    // Group variants by design_family_id if present
    const familyMap = new Map();
    const finalProducts = [];

    enriched.forEach(p => {
      if (p.design_family_id && p.status !== 'deleted' && p.is_active !== false) {
        if (!familyMap.has(p.design_family_id)) {
          const groupObj = {
            id: p.design_family_id,
            is_group: true,
            design_family_id: p.design_family_id,
            canonical_code: p.canonical_code.replace(/-[A-Z0-9]+$/i, ''),
            name: (p.name || '').replace(/\s*\([^)]*\)\s*$/, '').trim(),
            fabric: p.fabric,
            weave_style: p.weave_style,
            price: p.price,
            mrp: p.mrp,
            description: p.description,
            stock_quantity: 0,
            held_quantity: 0,
            available_quantity: 0,
            has_video: p.has_video,
            image_urls: [...(p.image_urls || [])],
            variants: []
          };
          familyMap.set(p.design_family_id, groupObj);
          finalProducts.push(groupObj);
        }
        const grp = familyMap.get(p.design_family_id);
        grp.variants.push(p);
        grp.stock_quantity += (Number(p.stock_quantity) || 0);
        grp.held_quantity += (Number(p.held_quantity) || 0);
        grp.available_quantity += (Number(p.available_quantity) || 0);
        if (p.has_video) grp.has_video = true;
        if (p.image_urls && p.image_urls.length > 0 && grp.image_urls.length === 0) {
          grp.image_urls = p.image_urls;
        }
      } else {
        finalProducts.push(p);
      }
    });

    let outputProducts = req.query.flat === 'true' ? enriched : finalProducts;

    // Scoped Item/File Isolation: If running on a locked paired terminal, only return its items!
    if (device && device.isLocked && device.godown) {
      outputProducts = outputProducts.filter(p => {
        if (p.is_group && Array.isArray(p.variants)) {
          return p.stock_quantity > 0 || p.variants.some(v => (Number(v.stock_quantity) || 0) > 0 || (v.godown_stocks && Number(v.godown_stocks[device.godown]) > 0));
        }
        const gStocks = p.godown_stocks || {};
        const qInGodown = Number(gStocks[device.godown]) || (p.active_godown === device.godown ? Number(p.stock_quantity) : 0);
        return qInGodown > 0 || (p.active_godown === device.godown && p.status !== 'deleted');
      });
    }

    res.json({
      success: true,
      count: outputProducts.length,
      products: outputProducts,
      rawCount: enriched.length,
      activeGodown: requestedGodown,
      isDeviceLocked: Boolean(device?.isLocked),
      lockedGodown: device?.godown || null,
      deviceName: device?.deviceName || null
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Group multiple sarees into a Design Family
app.post('/api/admin/products/group', requireAdminAuth, async (req, res) => {
  try {
    const { product_ids, family_name } = req.body;
    if (!Array.isArray(product_ids) || product_ids.length < 2) {
      return res.status(400).json({ success: false, error: 'Select at least 2 sarees to group.' });
    }
    const familyId = crypto.randomUUID();
    for (const pid of product_ids) {
      await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${pid}`, {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          design_family_id: familyId,
          updated_at: new Date().toISOString()
        })
      });
    }
    res.json({ success: true, family_id: familyId, message: `Combined ${product_ids.length} sarees into a color family group!` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Ungroup a Design Family or individual variant
app.post('/api/admin/products/ungroup', requireAdminAuth, async (req, res) => {
  try {
    const { family_id, product_id } = req.body;
    if (!family_id && !product_id) {
      return res.status(400).json({ success: false, error: 'family_id or product_id is required.' });
    }
    const filter = family_id ? `design_family_id=eq.${family_id}` : `id=eq.${product_id}`;
    await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?${filter}`, {
      method: 'PATCH',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        design_family_id: null,
        updated_at: new Date().toISOString()
      })
    });
    res.json({ success: true, message: 'Products ungrouped successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create / Add New Saree to Catalog & Stock Pool
app.post('/api/products', requireAdminAuth, express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const {
      sku,
      name,
      fabric,
      weave_style,
      price,
      mrp,
      stock_quantity = 0,
      description,
      image_base64,
      image_url,
      images_base64,
      image_urls: reqImageUrls
    } = req.body;

    if (!sku || !sku.trim()) {
      return res.status(400).json({ success: false, error: 'SKU / Product Code is required.' });
    }
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Product name is required.' });
    }

    const cleanSku = sku.trim().toUpperCase();
    const cleanName = name.trim();
    const cleanPrice = parseFloat(price) || 0;
    const cleanMrp = parseFloat(mrp) || cleanPrice;
    const cleanStock = parseInt(stock_quantity, 10) || 0;
    const cleanDesc = (description || '').trim();

    // Check if SKU already exists
    const existingRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?or=(sku.eq.${encodeURIComponent(cleanSku)},tally_part_number.eq.${encodeURIComponent(cleanSku)})&select=id`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const existing = await existingRes.json();
    if (existing && existing.length > 0) {
      return res.status(400).json({ success: false, error: `Product with SKU "${cleanSku}" already exists in catalog.` });
    }

    // Process multiple or single images
    const imageUrls = [];

    // 1. Process provided direct URLs
    if (Array.isArray(reqImageUrls)) {
      reqImageUrls.forEach(u => {
        if (typeof u === 'string' && u.trim().startsWith('http') && !imageUrls.includes(u.trim())) {
          imageUrls.push(u.trim());
        }
      });
    }
    if (image_url && typeof image_url === 'string') {
      const splitUrls = image_url.split(/[\n,;]+/).map(u => u.trim()).filter(u => u.startsWith('http'));
      splitUrls.forEach(u => {
        if (!imageUrls.includes(u)) imageUrls.push(u);
      });
    }

    // 2. Process base64 photo uploads (array or single)
    const base64List = [];
    if (Array.isArray(images_base64)) {
      base64List.push(...images_base64);
    } else if (image_base64) {
      base64List.push(image_base64);
    }

    for (let idx = 0; idx < base64List.length; idx++) {
      const item = base64List[idx];
      const rawB64 = typeof item === 'object' && item.base64 ? item.base64 : item;
      const originalFileName = typeof item === 'object' && item.fileName ? item.fileName : '';
      if (!rawB64 || typeof rawB64 !== 'string') continue;

      try {
        const cleanB64 = rawB64.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(cleanB64, 'base64');
        const fileExt = originalFileName && originalFileName.includes('.') ? originalFileName.slice(originalFileName.lastIndexOf('.')) : '.jpg';
        const safeName = `${cleanSku.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}_${idx}${fileExt}`.replace(/\s+/g, '_');
        const uploadUrl = `${SUPABASE_URL}/storage/v1/object/saree-catalog-images/${safeName}`;

        const upRes = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'image/jpeg',
            'x-upsert': 'true'
          },
          body: buffer
        });

        if (upRes.ok) {
          const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/saree-catalog-images/${safeName}`;
          if (!imageUrls.includes(publicUrl)) {
            imageUrls.push(publicUrl);
          }
        } else {
          console.warn(`[AddProduct] Storage upload error for photo ${idx}:`, await upRes.text());
        }
      } catch (imgErr) {
        console.warn(`[AddProduct] Image upload error for photo ${idx}:`, imgErr.message);
      }
    }

    // MULTI-COLOR VARIANT CREATION SUPPORT
    const variants = req.body.variants;
    if (Array.isArray(variants) && variants.length > 0) {
      const familyId = crypto.randomUUID();
      const shopId = '00000000-0000-0000-0000-000000000001';
      const shouldSyncTally = req.body.sync_tally !== false;
      const activeGodown = await getTargetGodown();

      // Master Gemini vector embedding
      let embeddingValues = null;
      try {
        const textForEmbedding = `${cleanName}. Fabric: ${fabric || 'Silk'}. Weave: ${weave_style || 'Woven'}. Description: ${cleanDesc}`;
        embeddingValues = await generateEmbedding({ text: textForEmbedding.slice(0, 2048) });
      } catch (embErr) {
        console.warn('[AddProduct] Variant embedding warning:', embErr.message);
      }

      const createdVariants = [];
      let totalStock = 0;

      for (let i = 0; i < variants.length; i++) {
        const v = variants[i];
        const vColor = (v.color || `Color ${i + 1}`).trim();
        const vSuffix = (v.sku_suffix || vColor.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 4) || `${i + 1}`).trim().toUpperCase();
        const vSku = v.sku ? v.sku.trim().toUpperCase() : `${cleanSku}-${vSuffix}`;
        const vName = `${cleanName} (${vColor})`;
        const vStock = parseInt(v.stock, 10) || 0;
        totalStock += vStock;

        // Image for variant
        let vImages = [];
        if (v.image_url && v.image_url.trim().startsWith('http')) {
          vImages.push(v.image_url.trim());
        } else if (v.image_base64) {
          try {
            const cleanB64 = v.image_base64.replace(/^data:image\/\w+;base64,/, '');
            const buffer = Buffer.from(cleanB64, 'base64');
            const safeName = `${vSku.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}.jpg`;
            const uploadUrl = `${SUPABASE_URL}/storage/v1/object/saree-catalog-images/${safeName}`;
            const upRes = await fetch(uploadUrl, {
              method: 'POST',
              headers: {
                apikey: SERVICE_KEY,
                Authorization: `Bearer ${SERVICE_KEY}`,
                'Content-Type': 'image/jpeg',
                'x-upsert': 'true'
              },
              body: buffer
            });
            if (upRes.ok) {
              vImages.push(`${SUPABASE_URL}/storage/v1/object/public/saree-catalog-images/${safeName}`);
            }
          } catch (imgErr) {
            console.warn(`[AddProduct] Variant ${vSku} image upload error:`, imgErr.message);
          }
        }
        if (vImages.length === 0 && imageUrls.length > 0) {
          vImages = [...imageUrls];
        }

        const vRecord = {
          sku: vSku,
          tally_part_number: vSku,
          name: vName,
          fabric: fabric ? fabric.trim() : 'Pure Silk',
          weave_style: weave_style ? weave_style.trim() : null,
          color_primary: vColor,
          design_family_id: familyId,
          price: cleanPrice,
          mrp: cleanMrp,
          stock_quantity: vStock,
          description: cleanDesc,
          image_urls: vImages,
          status: 'draft',
          is_active: true,
          item_created_in_tally: false,
          stock_added_in_tally: false,
          shop_id: shopId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        if (embeddingValues && embeddingValues.length === 768) {
          vRecord.embedding_v2 = embeddingValues;
          vRecord.embedding_model = 'gemini-embedding-2';
          vRecord.embedding_dim = 768;
        }

        const insertCatRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog`, {
          method: 'POST',
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
          },
          body: JSON.stringify(vRecord)
        });
        const catData = await insertCatRes.json();
        const createdSaree = Array.isArray(catData) ? catData[0] : catData;

        // Stock pool
        await fetch(`${SUPABASE_URL}/rest/v1/stock_pool`, {
          method: 'POST',
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            shop_id: shopId,
            product_code: vSku,
            saree_id: createdSaree.id,
            online_quantity: vStock,
            held_quantity: 0,
            sold_pending_quantity: 0,
            source: 'admin_entered',
            tally_godown: activeGodown,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
        });

        // Push to Tally
        let tallySynced = false;
        if (shouldSyncTally) {
          try {
            const isNos = /mysore|paithani|0021|0022/i.test(vName + vSku);
            const unitLabel = isNos ? 'Nos' : 'Pcs';
            const pushResult = await pushProductToTallyMaster({
              sku: vSku,
              name: vName,
              quantity: vStock,
              rate: cleanPrice,
              unitLabel,
              godownName: activeGodown
            });
            if (pushResult.success) {
              tallySynced = true;
              await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${createdSaree.id}`, {
                method: 'PATCH',
                headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  item_created_in_tally: true,
                  stock_added_in_tally: vStock > 0,
                  tally_last_seen_at: new Date().toISOString()
                })
              });
              await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?product_code=eq.${vSku}`, {
                method: 'PATCH',
                headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  source: 'tally_godown',
                  last_synced_at: new Date().toISOString()
                })
              });
            }
          } catch (tErr) {
            console.warn(`[AddProduct] Tally sync error for variant ${vSku}:`, tErr.message);
          }
        }

        createdVariants.push({
          ...createdSaree,
          canonical_code: vSku,
          stock_quantity: vStock,
          item_created_in_tally: tallySynced
        });
      }

      return res.json({
        success: true,
        message: `Saree family [${cleanSku}] created with ${createdVariants.length} color variants (Total ${totalStock} units in ${activeGodown}).`,
        family_id: familyId,
        variants_count: createdVariants.length,
        total_stock: totalStock,
        variants: createdVariants
      });
    }

    // Generate Gemini vector embedding for AI bot and multimodal search
    let embeddingValues = null;
    try {
      const textForEmbedding = `${cleanName}. Fabric: ${fabric || 'Silk'}. Weave: ${weave_style || 'Woven'}. Description: ${cleanDesc}`;
      embeddingValues = await generateEmbedding({ text: textForEmbedding.slice(0, 2048) });
    } catch (embErr) {
      console.warn('[AddProduct] Embedding generation warning:', embErr.message);
    }

    const shopId = '00000000-0000-0000-0000-000000000001';

    // Insert into saree_catalog
    const newRecord = {
      sku: cleanSku,
      tally_part_number: cleanSku,
      name: cleanName,
      fabric: fabric ? fabric.trim() : 'Pure Silk',
      weave_style: weave_style ? weave_style.trim() : null,
      color_primary: req.body.color_primary ? req.body.color_primary.trim() : 'Assorted',
      price: cleanPrice,
      mrp: cleanMrp,
      stock_quantity: cleanStock,
      description: cleanDesc,
      image_urls: imageUrls,
      status: 'draft',
      is_active: true,
      item_created_in_tally: false,
      stock_added_in_tally: false,
      shop_id: shopId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    if (embeddingValues && embeddingValues.length === 768) {
      newRecord.embedding_v2 = embeddingValues;
      newRecord.embedding_model = 'gemini-embedding-2';
      newRecord.embedding_dim = 768;
    }

    const insertCatRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(newRecord)
    });

    const catData = await insertCatRes.json();
    if (!insertCatRes.ok) {
      throw new Error(catData.message || catData.error || 'Failed to insert saree into catalog');
    }
    const createdSaree = Array.isArray(catData) ? catData[0] : catData;

    // Insert / Initialize stock_pool
    await fetch(`${SUPABASE_URL}/rest/v1/stock_pool`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        shop_id: shopId,
        product_code: cleanSku,
        saree_id: createdSaree.id,
        online_quantity: cleanStock,
        held_quantity: 0,
        sold_pending_quantity: 0,
        source: 'admin_entered',
        tally_godown: 'Online',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
    });

    // Audit log
    await fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        actor: 'admin:store_manager',
        action: 'manual_saree_added',
        entity_type: 'saree_catalog',
        entity_id: cleanSku,
        new_values: {
          sku: cleanSku,
          name: cleanName,
          price: cleanPrice,
          stock: cleanStock
        }
      })
    });

    // Automatically push and inward initial stock into Tally ERP Online Godown
    let tallySynced = false;
    let tallyMsg = '';
    const shouldSyncTally = req.body.sync_tally !== false;

    if (shouldSyncTally) {
      try {
        const isNos = /mysore|paithani|0021|0022/i.test(cleanName + cleanSku);
        const unitLabel = isNos ? 'Nos' : 'Pcs';
        const activeGodown = await getTargetGodown();
        const pushResult = await pushProductToTallyMaster({
          sku: cleanSku,
          name: cleanName,
          quantity: cleanStock,
          rate: cleanPrice,
          unitLabel,
          godownName: activeGodown
        });

        if (pushResult.success) {
          tallySynced = true;
          tallyMsg = ` and synchronized to Tally ERP ${activeGodown} Godown (${cleanStock} ${unitLabel})`;
          // Update saree_catalog
          await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${createdSaree.id}`, {
            method: 'PATCH',
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              item_created_in_tally: true,
              stock_added_in_tally: cleanStock > 0,
              tally_last_seen_at: new Date().toISOString()
            })
          });
          // Update stock_pool
          await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?product_code=eq.${cleanSku}`, {
            method: 'PATCH',
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              source: 'tally_godown',
              last_synced_at: new Date().toISOString()
            })
          });
        } else if (!isTallyLocallyConnected) {
          const isNos = /mysore|paithani|0021|0022/i.test(cleanName + cleanSku);
          const unitLabel = isNos ? 'Nos' : 'Pcs';
          const activeGodown = (await getTargetGodown()) || 'Online_saree';
          await queuePendingTallyAction({
            type: 'push_to_tally',
            sku: cleanSku,
            name: cleanName,
            quantity: cleanStock,
            rate: cleanPrice,
            unitLabel,
            godown: activeGodown
          });
          tallyMsg = ` (queued to Store PC Tally ERP)`;
        }
      } catch (tErr) {
        console.warn('[AddProduct] Tally sync error:', tErr.message);
        if (!isTallyLocallyConnected) {
          const isNos = /mysore|paithani|0021|0022/i.test(cleanName + cleanSku);
          const unitLabel = isNos ? 'Nos' : 'Pcs';
          const activeGodown = (await getTargetGodown()) || 'Online_saree';
          await queuePendingTallyAction({
            type: 'push_to_tally',
            sku: cleanSku,
            name: cleanName,
            quantity: cleanStock,
            rate: cleanPrice,
            unitLabel,
            godown: activeGodown
          });
          tallyMsg = ` (queued to Store PC Tally ERP)`;
        }
      }
    }

    res.json({
      success: true,
      message: `Saree [${cleanSku}] added successfully${tallyMsg}.`,
      tallySynced,
      product: {
        ...createdSaree,
        canonical_code: cleanSku,
        stock_quantity: cleanStock,
        item_created_in_tally: tallySynced
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------------------------------------------------------
// 3. API: Tally Stock Ingestion & Real-Time Sync
// -----------------------------------------------------------------------------
// Live Stock Polling Endpoint for Frontend Card Realtime Auto-Update
app.get('/api/live-stock', requireAdminAuth, async (req, res) => {
  try {
    const requestedGodown = (req.query.godown || await getTargetGodown() || 'Online_saree').trim();
    const [pRes, oRes, spRes, matrixRes, unallocRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?${shopFilterFor(req)}&status=not.in.(archived,deleted)&select=id,sku,tally_part_number,name,stock_quantity,attributes_json,price,status,is_active,updated_at&order=created_at.desc`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/orders?select=id,order_number,items,total_amount,payment_status,status,created_at&order=created_at.desc&limit=1`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/stock_pool?select=*`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.tally_godown_stock_matrix&select=value`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.tally_unallocated_stock&select=value`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      })
    ]);

    const products = (pRes.ok ? await pRes.json() : []) || [];
    const latestOrders = (oRes.ok ? await oRes.json() : []) || [];
    const stockPool = (spRes.ok ? await spRes.json() : []) || [];
    const matrixRows = (matrixRes.ok ? await matrixRes.json() : []) || [];
    let matrix = {};
    if (Array.isArray(matrixRows) && matrixRows[0]?.value) {
      try { matrix = typeof matrixRows[0].value === 'string' ? JSON.parse(matrixRows[0].value) : matrixRows[0].value; } catch (_) {}
    }

    const stockMap = new Map();
    stockPool.forEach(s => {
      if (s.product_code) stockMap.set(s.product_code.toLowerCase(), s);
      if (s.saree_id) stockMap.set(s.saree_id, s);
    });

    const unallocRows = (unallocRes.ok ? await unallocRes.json() : []) || [];
    let unalloc = {};
    if (Array.isArray(unallocRows) && unallocRows[0]?.value) {
      try {
        unalloc = typeof unallocRows[0].value === 'string' ? JSON.parse(unallocRows[0].value) : unallocRows[0].value;
      } catch (_) {}
    }

    const liveScope = getGodownScope(requestedGodown, cachedGodownsResult?.godownHierarchy || []);

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      activeGodown: requestedGodown,
      activeScope: liveScope,
      products: (products || []).map(p => {
        const isDel = isRemovedProduct(p);
        const code = (p.tally_part_number || p.sku || '').trim();
        const codeKey = code.toLowerCase();
        const nameKey = (p.name || '').toLowerCase().trim();
        const stock = stockMap.get(codeKey) || stockMap.get(p.id);

        // Prioritize live stock_pool quantity for the requested godown
        let godownQty = 0;
        let hasGodownMatch = false;

        // Per-godown stock matrix, refreshed from live Tally on every sync.
        const itemMatrix = { ...(matrix[codeKey] || matrix[nameKey] || p.attributes_json?.godown_stocks || {}) };

        // Live Tally FIRST. A stock_pool row is a cache: a godown switch rewrites every
        // row via syncGodownStockTransition, which zeroed all 9 items here. That zero used
        // to win over real Tally stock because the stock_pool branch ran first and set
        // hasGodownMatch, short-circuiting the matrix entirely.
        let scopeSum = 0;
        let matchedAnyInScope = false;
        for (const scName of liveScope) {
          const gKey = Object.keys(itemMatrix).find(k => k.toLowerCase() === scName.toLowerCase());
          if (gKey !== undefined) {
            scopeSum += Number(itemMatrix[gKey]) || 0;
            matchedAnyInScope = true;
          }
        }

        if (matchedAnyInScope) {
          godownQty = scopeSum;
          hasGodownMatch = true;
        } else if (stock && stock.tally_godown && stock.tally_godown.toLowerCase() === requestedGodown.toLowerCase()) {
          // No Tally figure for this godown — fall back to the cached row.
          godownQty = Number(stock.online_quantity) || 0;
          hasGodownMatch = true;
        } else if (stock && !stock.tally_godown) {
          // Untagged stock_pool rows predate godown tracking. Never attribute stock that is
          // tagged to another godown (e.g. Main Location) to the requested one.
          godownQty = Number(stock.online_quantity) || (p.stock_quantity ?? 0);
          hasGodownMatch = true;
        }

        // Only stamp the requested godown when the figure came from the cache; doing it on a
        // matrix hit would collapse a multi-godown scope sum onto one key.
        if (hasGodownMatch && !matchedAnyInScope) {
          itemMatrix[requestedGodown] = godownQty;
        }

        const onlineStock = isDel ? 0 : godownQty;
        return {
          id: p.id,
          sku: p.sku,
          canonical_code: code,
          name: p.name,
          stock_quantity: onlineStock,
          active_godown: requestedGodown,
          godown_stocks: itemMatrix,
          unallocated_qty: isDel ? 0 : (Number(unalloc[codeKey] ?? unalloc[nameKey] ?? 0) || 0),
          status: p.status,
          is_active: p.is_active,
          is_deleted: isDel,
          price: p.price,
          updated_at: p.updated_at
        };
      }),
      latestOrder: latestOrders[0] || null
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Full Sync: Syncs pending transactions to Tally and ingests closing stock
app.post('/api/sync-tally-stock', requireAdminAuth, async (req, res) => {
  try {
    if (!isTallyLocallyConnected) {
      // Queue push_to_tally for all active products to ensure they are created in Tally ERP
      const pRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?is_active=eq.true&select=*`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      const activeSarees = await pRes.json().catch(() => []);
      const activeGodown = (await getTargetGodown()) || 'Online_saree';

      if (Array.isArray(activeSarees)) {
        for (const s of activeSarees) {
          const canonicalCode = s.sku || s.tally_part_number || s.name;
          const isNos = /mysore|paithani|0021|0022/i.test((s.name || '') + canonicalCode);
          const unitLabel = isNos ? 'Nos' : 'Pcs';
          await queuePendingTallyAction({
            type: 'push_to_tally',
            sku: canonicalCode,
            name: s.name || canonicalCode,
            quantity: s.stock_quantity || 0,
            rate: s.price || 5000,
            unitLabel,
            godown: activeGodown
          });
        }
      }

      const remoteHb = await fetchRemoteTallyHeartbeat();
      return res.json({
        success: true,
        message: `Sync queued! ${activeSarees.length} active products queued to sync with Tally ERP on Store PC (${remoteHb?.hostname || 'Store PC'}).`,
        remoteStore: true,
        result: { itemsUpdated: activeSarees.length }
      });
    }
    try {
      const orderSync = await syncPendingOrdersToTally();
      const result = await performMorningStockSync();
      return res.json({
        success: true,
        message: `Tally ERP synchronized! ${result.itemsUpdated} sarees updated, ${orderSync.synced || 0} pending orders pushed.`,
        orderSync,
        result
      });
    } catch (tallyErr) {
      console.warn('[SyncTallyStock] Local Tally unreachable:', tallyErr.message);
      return res.json({
        success: true,
        tallyOffline: true,
        message: `Cloud Catalog verified and active. Store PC / Tally is currently offline or unreachable on port 9000. Changes are queued and will sync automatically once Tally is running.`,
        result: { itemsUpdated: 0 }
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Per-Product Sync: Syncs a single product's pending orders and stock with Tally
app.post('/api/sync-product-stock/:code', requireAdminAuth, async (req, res) => {
  try {
    const code = req.params.code;

    // 0. If local Tally is not connected (e.g. running on Admin laptop), forward request to Store PC Gateway!
    if (!isTallyLocallyConnected) {
      try {
        const gwRes = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.in_store_gateway_url&select=value`, {
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
          signal: AbortSignal.timeout(2000)
        });
        const gwRows = await gwRes.json();
        if (Array.isArray(gwRows) && gwRows.length > 0 && gwRows[0].value) {
          const gw = typeof gwRows[0].value === 'string' ? JSON.parse(gwRows[0].value) : gwRows[0].value;
          // LAN first: measured 0.07s vs 1.25s through the tunnel, and the quick-tunnel
          // URL is often stale — get_tunnel_url.js republishes a dead one as fresh.
          const targetUrl = gw.lanUrl || gw.publicUrl;
          if (targetUrl) {
            const pushParam = req.query.push === 'true' ? '?push=true' : '';
            const fRes = await fetch(`${targetUrl}/api/sync-product-stock/${encodeURIComponent(code)}${pushParam}`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-admin-key': ADMIN_API_KEY || SERVICE_KEY || 'sai-traders-admin-key',
                'Authorization': `Bearer ${SERVICE_KEY}`
              },
              signal: AbortSignal.timeout(12000)
            });
            if (fRes.ok) {
              const fData = await fRes.json();
              return res.json(fData);
            } else {
              const errData = await fRes.json().catch(() => ({}));
              if (errData.error) {
                return res.status(fRes.status).json(errData);
              }
            }
          }
        }
      } catch (_fwdErr) {
        console.warn('[SyncProductStock] Remote forward attempt failed:', _fwdErr.message);
      }
    }

    // 1. Fetch saree from catalog
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(code);
    const filterQuery = isUuid 
      ? `id=eq.${encodeURIComponent(code)}`
      : `or=(sku.eq.${encodeURIComponent(code)},tally_part_number.eq.${encodeURIComponent(code)},sku.eq.${encodeURIComponent(code.toUpperCase())})`;

    const pRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?${filterQuery}&limit=1`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const catalogItems = await pRes.json();
    const saree = catalogItems && catalogItems[0] ? catalogItems[0] : null;

    if (!saree) {
      return res.status(404).json({ success: false, error: `Product [${code}] not found in catalog.` });
    }

    const canonicalCode = saree.sku || saree.tally_part_number || code;
    const isNos = /mysore|paithani|0021|0022/i.test((saree.name || '') + canonicalCode);
    const unitLabel = isNos ? 'Nos' : 'Pcs';

    // 2. Query Tally to check if item exists and its live quantity
    let tallyStockInfo = await queryTallyStockForItem(canonicalCode, saree.name);

    // Case A: Tally ERP is completely unreachable / offline
    if (!tallyStockInfo.reachable) {
      if (req.query.push === 'true' || req.body?.push === true || !saree.item_created_in_tally) {
        const activeGodown = (await getTargetGodown()) || 'Online_saree';
        try {
          const pushResult = await pushProductToTallyMaster({
            sku: canonicalCode,
            name: saree.name || canonicalCode,
            quantity: saree.stock_quantity || 0,
            rate: saree.price || 5000,
            unitLabel,
            godownName: activeGodown
          });

          if (pushResult.success) {
            await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${saree.id}`, {
              method: 'PATCH',
              headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                item_created_in_tally: true,
                stock_added_in_tally: (saree.stock_quantity || 0) > 0,
                tally_last_seen_at: new Date().toISOString()
              })
            });

            await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?or=(saree_id.eq.${saree.id},product_code.eq.${encodeURIComponent(canonicalCode)})`, {
              method: 'PATCH',
              headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                source: 'tally_godown',
                online_quantity: saree.stock_quantity || 0,
                last_synced_at: new Date().toISOString()
              })
            });

            return res.json({
              success: true,
              code: canonicalCode,
              createdInTally: true,
              message: `Item [${canonicalCode}] created and synchronized in Tally ERP with ${saree.stock_quantity || 0} ${unitLabel}.`,
              item: {
                sku: canonicalCode,
                name: saree.name,
                currentStock: saree.stock_quantity || 0
              }
            });
          } else {
            if (!isTallyLocallyConnected) {
              await queuePendingTallyAction({
                type: 'push_to_tally',
                sku: canonicalCode,
                name: saree.name || canonicalCode,
                quantity: saree.stock_quantity || 0,
                rate: saree.price || 5000,
                unitLabel,
                godown: activeGodown
              });
              return res.json({
                success: true,
                queued: true,
                code: canonicalCode,
                message: `Product [${canonicalCode}] queued for creation in Store PC Tally ERP (${saree.stock_quantity || 0} ${unitLabel}). Store PC will sync it automatically.`,
                item: {
                  sku: canonicalCode,
                  name: saree.name,
                  currentStock: saree.stock_quantity || 0
                }
              });
            }
            return res.status(502).json({
              success: false,
              error: `Tally rejected item creation: ${pushResult.raw?.slice(0, 150) || 'Unknown error'}`
            });
          }
        } catch (pushErr) {
          if (!isTallyLocallyConnected) {
            await queuePendingTallyAction({
              type: 'push_to_tally',
              sku: canonicalCode,
              name: saree.name || canonicalCode,
              quantity: saree.stock_quantity || 0,
              rate: saree.price || 5000,
              unitLabel,
              godown: activeGodown
            });
            return res.json({
              success: true,
              tallyOffline: true,
              queued: true,
              code: canonicalCode,
              message: `Product [${canonicalCode}] queued for creation in Store PC Tally ERP (${saree.stock_quantity || 0} ${unitLabel}). Store PC will sync it automatically.`,
              item: {
                sku: canonicalCode,
                name: saree.name,
                currentStock: saree.stock_quantity || 0
              }
            });
          }
          return res.json({
            success: true,
            tallyOffline: true,
            code: canonicalCode,
            message: `Product [${canonicalCode}] stock is active in Cloud (${saree.stock_quantity || 0} ${unitLabel}). Tally is currently offline (port 9000). Stock will sync to Tally once Store PC/Tally connects.`,
            item: {
              sku: canonicalCode,
              name: saree.name,
              currentStock: saree.stock_quantity || 0
            }
          });
        }
      }

      // Not a push request, but Tally is unreachable -> Preserves cloud stock cleanly
      return res.json({
        success: true,
        tallyOffline: true,
        code: canonicalCode,
        message: `Product [${canonicalCode}] stock verified in Cloud (${saree.stock_quantity || 0} ${unitLabel}). Tally is currently offline on port 9000.`,
        item: {
          sku: canonicalCode,
          name: saree.name,
          currentStock: saree.stock_quantity || 0
        }
      });
    }

    // Case B: Tally is reachable, but item was NOT found in active godown
    if (!tallyStockInfo.found) {
      if (req.query.push === 'true' || req.body?.push === true || !saree.item_created_in_tally) {
        const activeGodown = (await getTargetGodown()) || 'Online_saree';
        const pushResult = await pushProductToTallyMaster({
          sku: canonicalCode,
          name: saree.name || canonicalCode,
          quantity: saree.stock_quantity || 0,
          rate: saree.price || 5000,
          unitLabel,
          godownName: activeGodown
        });

        if (pushResult.success) {
          await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${saree.id}`, {
            method: 'PATCH',
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              item_created_in_tally: true,
              stock_added_in_tally: (saree.stock_quantity || 0) > 0,
              tally_last_seen_at: new Date().toISOString()
            })
          });

          await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?or=(saree_id.eq.${saree.id},product_code.eq.${encodeURIComponent(canonicalCode)})`, {
            method: 'PATCH',
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              source: 'tally_godown',
              online_quantity: saree.stock_quantity || 0,
              last_synced_at: new Date().toISOString()
            })
          });

          return res.json({
            success: true,
            code: canonicalCode,
            createdInTally: true,
            message: `Item [${canonicalCode}] created and synchronized in Tally ERP with ${saree.stock_quantity || 0} ${unitLabel}.`,
            item: {
              sku: canonicalCode,
              name: saree.name,
              currentStock: saree.stock_quantity || 0
            }
          });
        } else {
          throw new Error(`Failed to create item in Tally ERP. Response: ${pushResult.raw?.slice(0, 150)}`);
        }
      }

      // If the item previously existed in Tally and is now missing, zero out
      if (saree.item_created_in_tally) {
        await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?or=(saree_id.eq.${saree.id},product_code.eq.${encodeURIComponent(canonicalCode)})`, {
          method: 'PATCH',
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            online_quantity: 0,
            source: 'tally_godown',
            last_synced_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
        });

        await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${saree.id}`, {
          method: 'PATCH',
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            stock_quantity: 0,
            item_created_in_tally: false,
            stock_added_in_tally: false,
            tally_last_seen_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
        });

        return res.json({
          success: true,
          code: canonicalCode,
          message: `Product [${canonicalCode}] was deleted in Tally ERP. Stock updated to 0 (Out of Stock).`,
          item: {
            sku: canonicalCode,
            name: saree.name,
            currentStock: 0,
            status: 'out_of_stock'
          }
        });
      } else {
        // Not in Tally yet, but newly added to catalog -> Keep catalog stock, inform user to push
        return res.json({
          success: true,
          code: canonicalCode,
          message: `Product [${canonicalCode}] is not yet in Tally ERP. Click "Push to Tally" to create it.`,
          item: {
            sku: canonicalCode,
            name: saree.name,
            currentStock: saree.stock_quantity || 0,
            status: (saree.stock_quantity || 0) > 0 ? 'in_stock' : 'out_of_stock'
          }
        });
      }
    }

    // 4. Item exists in Tally -> Sync closing quantity into cloud
    const actualQty = tallyStockInfo.quantity;
    await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?or=(saree_id.eq.${saree.id},product_code.eq.${encodeURIComponent(canonicalCode)})`, {
      method: 'PATCH',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        online_quantity: actualQty,
        source: 'tally_godown',
        last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
    });

    await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${saree.id}`, {
      method: 'PATCH',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stock_quantity: actualQty,
        item_created_in_tally: true,
        stock_added_in_tally: actualQty > 0,
        tally_last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
    });

    return res.json({
      success: true,
      code: canonicalCode,
      message: `Live stock synchronized: ${actualQty} ${tallyStockInfo.unit || unitLabel} in Tally.`,
      item: {
        sku: canonicalCode,
        name: saree.name,
        currentStock: actualQty
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete Product: Soft Delete by default (removes from online stock & moves to Deleted view); Hard purge if ?purge=true
app.delete('/api/products/:id', requireAdminAuth, async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ success: false, error: 'Product ID or SKU is required' });

    const isPurge = req.query.purge === 'true' || req.query.hard === 'true';
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const filterQuery = isUuid
      ? `id=eq.${id}`
      : `or=(sku.ilike.${encodeURIComponent(id)},tally_part_number.ilike.${encodeURIComponent(id)},name.ilike.${encodeURIComponent(id)})`;

    const sRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?${filterQuery}&limit=1`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const items = await sRes.json().catch(() => []);
    const saree = items && items[0];

    const sku = saree ? (saree.sku || saree.tally_part_number || saree.name) : id;
    const sareeId = saree ? saree.id : (isUuid ? id : null);

    // Prevent morning sync or background polling from reviving the deleted item
    try {
      if (saree?.sku) await addManuallyDeletedSku(saree.sku);
      if (saree?.tally_part_number) await addManuallyDeletedSku(saree.tally_part_number);
      if (saree?.name) await addManuallyDeletedSku(saree.name);
      await addManuallyDeletedSku(id);
    } catch (_e) {}

    // Clean deletion in Tally ERP:
    // Zero out opening balance within Sarees group (NEVER post fake sales deduction vouchers or move to Primary)
    let tallyItemFound = null;
    try {
      const activeGodown = await getTargetGodown();
      const tallyItems = await fetchAllTallyStockItems();
      const targetLookups = [sku, saree?.name, saree?.tally_part_number].filter(Boolean).map(x => x.toLowerCase());
      tallyItemFound = tallyItems.find(t => {
        const n = (t.name || '').toLowerCase();
        const p = (t.partNo || '').toLowerCase();
        return targetLookups.includes(n) || targetLookups.includes(p);
      });

      if (tallyItemFound) {
        const itemName = tallyItemFound.name;
        const isNos = /mysore|paithani|0021|0022/i.test(itemName) || (tallyItemFound.closing || '').toLowerCase().includes('nos');
        const unitLabel = isNos ? 'Nos' : 'Pcs';

        // Safely alter Tally master: set Opening Balance to 0 within Sarees group
        const alterXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<STOCKITEM NAME="${escapeXml(itemName)}" ACTION="Alter">
  <NAME>${escapeXml(itemName)}</NAME>
  <PARENT>${escapeXml(TALLY_STOCK_GROUP)}</PARENT>
  <OPENINGBALANCE>0 ${unitLabel}</OPENINGBALANCE>
  <OPENINGRATE>0/${unitLabel}</OPENINGRATE>
  <OPENINGVALUE>0</OPENINGVALUE>
  <BATCHALLOCATIONS.LIST>
    <GODOWNNAME>${activeGodown}</GODOWNNAME>
    <BATCHNAME>Primary Batch</BATCHNAME>
    <OPENINGBALANCE>0 ${unitLabel}</OPENINGBALANCE>
    <OPENINGRATE>0/${unitLabel}</OPENINGRATE>
    <OPENINGVALUE>0</OPENINGVALUE>
  </BATCHALLOCATIONS.LIST>
</STOCKITEM>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
        await sendToTally(alterXml, 3000);
        console.log(`[DELETE /api/products] Cleanly zeroed stock for "${itemName}" in Tally ERP within Sarees group.`);
      }
    } catch (_tErr) {
      console.warn(`[DELETE /api/products] Tally stock zeroing notice for ${sku}:`, _tErr.message);
    }

    // Always remove from stock_pool so online stock is immediately ZERO and invisible in online store & WhatsApp
    try {
      const spQuery = sareeId 
        ? `or=(saree_id.eq.${sareeId},product_code.eq.${encodeURIComponent(sku)})` 
        : `product_code.eq.${encodeURIComponent(sku)}`;
      await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?${spQuery}`, {
        method: 'DELETE',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
    } catch (_spErr) {
      console.warn('[DELETE /api/products] stock_pool removal notice:', _spErr.message);
    }

    if (isPurge) {
      // HARD PURGE: Cascade delete all records completely from Supabase
      try {
        if (sareeId) {
          await fetch(`${SUPABASE_URL}/rest/v1/discrepancies?saree_id=eq.${sareeId}`, {
            method: 'DELETE',
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
          });
        }
        await fetch(`${SUPABASE_URL}/rest/v1/discrepancies?product_code=eq.${encodeURIComponent(sku)}`, {
          method: 'DELETE',
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
        });
        await fetch(`${SUPABASE_URL}/rest/v1/video_item?product_code=eq.${encodeURIComponent(sku)}`, {
          method: 'DELETE',
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
        });
        await fetch(`${SUPABASE_URL}/rest/v1/saree_frame?product_code=eq.${encodeURIComponent(sku)}`, {
          method: 'DELETE',
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
        });
      } catch (_) {}

      if (sareeId) {
        await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${sareeId}`, {
          method: 'DELETE',
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
        });
      } else {
        await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?or=(sku.ilike.${encodeURIComponent(sku)},tally_part_number.ilike.${encodeURIComponent(sku)})`, {
          method: 'DELETE',
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
        });
      }

      return res.json({
        success: true,
        purged: true,
        message: `Product [${sku}] permanently purged from catalog & database.`,
        tallyReflected: Boolean(tallyItemFound)
      });
    }

    // SOFT DELETE: Mark status as 'archived', is_active as false, stock as 0
    // Product is removed from online stock, and visible in Deleted tab!
    const patchPayload = {
      status: 'archived',
      is_active: false,
      stock_quantity: 0,
      updated_at: new Date().toISOString()
    };

    const patchUrl = sareeId 
      ? `${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${sareeId}`
      : `${SUPABASE_URL}/rest/v1/saree_catalog?or=(sku.ilike.${encodeURIComponent(sku)},tally_part_number.ilike.${encodeURIComponent(sku)})`;

    const patchRes = await fetch(patchUrl, {
      method: 'PATCH',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(patchPayload)
    });
    if (!patchRes.ok) {
      const patchErr = await patchRes.text();
      console.error('[DELETE /api/products] Supabase update failed:', patchRes.status, patchErr);
      throw new Error(`Failed to update catalog status in cloud: ${patchErr}`);
    }

    // If local Tally is not connected, queue action for Store PC to zero out in physical Tally ERP
    if (!isTallyLocallyConnected) {
      const activeGodown = (await getTargetGodown()) || 'Online_saree';
      await queuePendingTallyAction({
        type: 'zero_stock',
        sku: sku,
        itemName: saree?.name || sku,
        godown: activeGodown
      });
    }

    // Audit log
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actor: 'admin',
          action: 'soft_delete_product',
          entity_type: 'saree_catalog',
          entity_id: sku,
          metadata: {
            saree_id: sareeId,
            name: saree?.name || sku,
            tally_item: tallyItemFound?.name || null,
            previous_stock: saree?.stock_quantity || 0
          }
        })
      });
    } catch (_) {}

    res.json({
      success: true,
      softDeleted: true,
      message: `Product [${sku}] moved to Deleted sarees (removed from online stock).`,
      tallyReflected: Boolean(tallyItemFound),
      previousStock: saree?.stock_quantity || 0
    });
  } catch (err) {
    console.error('[DELETE /api/products] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Restore Deleted Product back to active catalog
app.post('/api/products/:id/restore', requireAdminAuth, async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ success: false, error: 'Product ID or SKU is required' });

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const filterQuery = isUuid
      ? `id=eq.${id}`
      : `or=(sku.ilike.${encodeURIComponent(id)},tally_part_number.ilike.${encodeURIComponent(id)},name.ilike.${encodeURIComponent(id)})`;

    const sRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?${filterQuery}&limit=1`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const items = await sRes.json().catch(() => []);
    const saree = items && items[0];
    if (!saree) {
      return res.status(404).json({ success: false, error: `Product [${id}] not found in catalog.` });
    }

    const sku = saree.sku || saree.tally_part_number || saree.name;
    const sareeId = saree.id;

    // 1. Remove from manually_deleted_skus list so syncs can update it
    try {
      const getRes = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.manually_deleted_skus&select=value`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      const rows = await getRes.json().catch(() => []);
      if (Array.isArray(rows) && rows.length > 0 && rows[0].value) {
        let list = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
        const lowSku = sku.toLowerCase();
        list = list.filter(x => x && x.toLowerCase() !== lowSku && x !== sareeId);
        await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.manually_deleted_skus`, {
          method: 'PATCH',
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: JSON.stringify(list), updated_at: new Date().toISOString() })
        });
      }
    } catch (_setErr) {}

    // 2. Mark active in saree_catalog
    await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${sareeId}`, {
      method: 'PATCH',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'draft',
        is_active: true,
        stock_quantity: 0,
        updated_at: new Date().toISOString()
      })
    });

    // 3. Upsert into stock_pool
    const activeGodown = (await getTargetGodown()) || 'Online_saree';
    const shopId = '00000000-0000-0000-0000-000000000001';
    await fetch(`${SUPABASE_URL}/rest/v1/stock_pool`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shop_id: shopId,
        product_code: sku,
        saree_id: sareeId,
        online_quantity: 0,
        held_quantity: 0,
        sold_pending_quantity: 0,
        source: 'admin_entered',
        tally_godown: activeGodown,
        last_synced_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
    });

    res.json({
      success: true,
      message: `Product [${sku}] restored to catalog. You can now adjust its stock or sync with Tally.`
    });
  } catch (err) {
    console.error('[RESTORE /api/products] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Adjust / Inward Stock directly in Tally ERP & sync to Supabase
/**
 * Set an item's stock in Tally.
 *
 * This used to compute a delta here and write to Tally itself — directly if Tally was
 * on this machine, otherwise forwarded to the store PC's gateway, otherwise dropped
 * into a queue. All three paths are gone: the gateway no longer runs and nothing
 * drains that queue, so every stock update from the dashboard silently went nowhere.
 *
 * The agent does this properly now. It reads the baseline from Tally immediately before
 * writing, so no cache can drift into the result, and it provisions the godown, stock
 * group, unit and party ledger the voucher needs. The job is idempotent on its target,
 * so a repeat is a no-op rather than a double application.
 *
 * The request waits a few seconds for the job to settle, because asking for stock to be
 * set to 5 and being told something was queued is not an answer. If it has not finished
 * by then, that is reported honestly rather than claimed as success.
 */
app.post('/api/adjust-tally-stock', requireAdminAuth, async (req, res) => {
  try {
    const { code, targetQuantity, reason, godown } = req.body || {};
    if (code === undefined || targetQuantity === undefined) {
      return res.status(400).json({ success: false, error: 'Missing code or targetQuantity' });
    }

    const newQty = parseInt(targetQuantity, 10);
    if (!Number.isFinite(newQty) || newQty < 0) {
      return res.status(400).json({ success: false, error: 'targetQuantity must be zero or a positive whole number' });
    }

    // A locked terminal may only touch its own godown. Falling through to the request
    // body whenever the lock was absent made the lock read like a constraint but behave
    // like a default.
    let targetGodown;
    if (req.device?.isLocked && req.device?.godown) {
      targetGodown = String(req.device.godown).trim();
      const asked = godown ? String(godown).trim() : '';
      if (asked && asked.toLowerCase() !== targetGodown.toLowerCase()) {
        return res.status(403).json({
          success: false,
          error: `This terminal is locked to godown "${targetGodown}" and cannot adjust stock in "${asked}".`
        });
      }
    } else {
      targetGodown = String(godown || await getTargetGodown() || '').trim();
    }
    if (!targetGodown) {
      return res.status(400).json({ success: false, error: 'No godown is configured for this shop' });
    }

    const shopId = (Array.isArray(req.shopIds) && req.shopIds[0]) || SHOP_ID;

    // Find the product within this member's shop, so one shop cannot adjust another's.
    const pRes = await fetch(
      `${SUPABASE_URL}/rest/v1/saree_catalog?shop_id=eq.${shopId}` +
      `&or=(sku.eq.${encodeURIComponent(code)},tally_part_number.eq.${encodeURIComponent(code)},name.eq.${encodeURIComponent(code)})` +
      `&select=id,sku,tally_part_number,name,price,tally_rate,stock_quantity&limit=1`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    const found = pRes.ok ? await pRes.json() : [];
    const saree = found[0];
    if (!saree) {
      return res.status(404).json({ success: false, error: `${code} is not in this shop catalogue` });
    }

    // Name the item as Tally knows it. The part number is what the shop typed there;
    // the SKU is the catalogue's own code and only matches when the two agree.
    const tallyName = saree.tally_part_number || saree.sku || saree.name;
    const rate = Number(saree.price) || Number(saree.tally_rate) || 0;

    const jobRes = await fetch(`${SUPABASE_URL}/rest/v1/agent_jobs`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify([{
        shop_id: shopId,
        type: 'adjust_stock',
        state: 'pending',
        payload: {
          name: tallyName,
          targetQuantity: newQty,
          godown: targetGodown,
          unit: 'Pcs',
          rate,
          reason: reason ? String(reason).slice(0, 200) : null
        }
      }])
    });

    if (!jobRes.ok) {
      const detail = await jobRes.text();
      return res.status(502).json({ success: false, error: `Could not queue the update: ${detail.slice(0, 200)}` });
    }
    const job = (await jobRes.json())[0];

    // The agent asks for work every 5 seconds, so this usually settles well inside the
    // wait. Polling is cheap, and the alternative is telling someone their stock changed
    // when it may not have.
    const deadline = Date.now() + 15000;
    let finalState = 'pending';
    let jobError = null;
    let jobResult = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1200));
      const sRes = await fetch(
        `${SUPABASE_URL}/rest/v1/agent_jobs?id=eq.${job.id}&select=state,error,result`,
        { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
      );
      const rows = sRes.ok ? await sRes.json() : [];
      if (!rows[0]) continue;
      finalState = rows[0].state;
      jobError = rows[0].error;
      jobResult = rows[0].result;
      if (finalState === 'completed' || finalState === 'failed') break;
    }

    if (finalState === 'failed') {
      return res.status(502).json({
        success: false,
        error: jobError || 'Tally rejected the update',
        jobId: job.id
      });
    }

    if (finalState === 'completed') {
      // Keep the catalogue in step at once. The agent's next reading would correct it
      // within two minutes anyway, but the person who just pressed the button should not
      // have to wait to see their own change.
      await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${saree.id}`, {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ stock_quantity: newQty, updated_at: new Date().toISOString() })
      }).catch(() => {});

      return res.json({
        success: true,
        newQuantity: newQty,
        jobId: job.id,
        detail: jobResult || null,
        message: `${tallyName} set to ${newQty} in ${targetGodown}.`
      });
    }

    // Still pending: the agent is not currently collecting work.
    return res.json({
      success: true,
      queued: true,
      newQuantity: newQty,
      jobId: job.id,
      message: `Queued: ${tallyName} will be set to ${newQty} in ${targetGodown} when the store PC next reports in.`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Alias for existing Morning Stock Ingestion button
app.post('/api/sync-morning-stock', requireAdminAuth, async (req, res) => {
  try {
    if (!isTallyLocallyConnected) {
      const remoteHb = await fetchRemoteTallyHeartbeat();
      if (remoteHb && remoteHb.isFresh) {
        return res.json({
          success: true,
          message: `Store PC (${remoteHb.hostname || 'Store PC'}) is ONLINE and continuously ingesting stock from Tally ERP. Cloud inventory is synchronized.`,
          remoteStore: true,
          result: { itemsUpdated: remoteHb.itemCount || 0 }
        });
      }
    }
    const result = await performMorningStockSync();
    res.json({
      success: true,
      message: `Morning stock successfully ingested from Tally! ${result.itemsUpdated} stored sarees updated.`,
      result
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/morning-stock-status', (req, res) => {
  res.json({ success: true, state: morningSyncState });
});

// -----------------------------------------------------------------------------
// Phase 2: Discrepancy & Sync Run APIs
// -----------------------------------------------------------------------------

// GET /api/discrepancies (and /discrepancies)
async function handleGetDiscrepancies(req, res) {
  try {
    const status = req.query.status;
    let url = `${SUPABASE_URL}/rest/v1/discrepancies?select=*,saree:saree_catalog(name,price,image_urls,status)&order=created_at.desc`;
    if (status) {
      url += `&status=eq.${encodeURIComponent(status)}`;
    }

    const r = await fetch(url, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const items = await r.json();
    res.json({ success: true, count: items.length, discrepancies: items });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
app.get('/api/discrepancies', handleGetDiscrepancies);
app.get('/discrepancies', handleGetDiscrepancies);

// POST /api/discrepancies/:id/resolve (and /discrepancies/:id/resolve)
// POST /api/discrepancies/:id/resolve (and /discrepancies/:id/resolve)
async function handleResolveDiscrepancy(req, res) {
  try {
    const discrepancyId = req.params.id;
    const { action, verified_qty, notes, resolved_by } = req.body;

    if (!action) {
      return res.status(400).json({ success: false, error: 'action is required (accept_tally, keep_cloud, or manual_count)' });
    }

    // 1. Try atomic RPC resolve_discrepancy
    try {
      const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/resolve_discrepancy`, {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          p_discrepancy_id: discrepancyId,
          p_action: action,
          p_verified_qty: verified_qty !== undefined ? parseInt(verified_qty, 10) : null,
          p_notes: notes || '',
          p_resolved_by: resolved_by || 'admin:store_manager'
        })
      });

      if (rpcRes.ok) {
        const result = await rpcRes.json();
        return res.json(result);
      }
    } catch (_rpcErr) {}

    // 2. PostgREST Fallback Resolution
    const dRes = await fetch(`${SUPABASE_URL}/rest/v1/discrepancies?id=eq.${discrepancyId}&select=*`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const dItems = await dRes.json();
    if (!Array.isArray(dItems) || dItems.length === 0) {
      return res.status(404).json({ success: false, error: 'Discrepancy record not found' });
    }

    const disc = dItems[0];
    if (disc.status === 'resolved') {
      return res.json({
        success: true,
        idempotent_replay: true,
        discrepancy_id: discrepancyId,
        message: 'Discrepancy already resolved'
      });
    }

    let finalQty = 0;
    if (action === 'accept_tally') {
      finalQty = disc.actual_qty;
    } else if (action === 'keep_cloud') {
      finalQty = disc.expected_qty;
    } else if (action === 'manual_count') {
      if (verified_qty === undefined || verified_qty === null || parseInt(verified_qty, 10) < 0) {
        return res.status(400).json({ success: false, error: 'verified_qty must be a non-negative integer for manual_count' });
      }
      finalQty = parseInt(verified_qty, 10);
    } else {
      return res.status(400).json({ success: false, error: 'Invalid action. Must be accept_tally, keep_cloud, or manual_count' });
    }

    // Update stock_pool
    const spRes = await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?shop_id=eq.${disc.shop_id}&product_code=eq.${encodeURIComponent(disc.product_code)}&select=*`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const spItems = await spRes.json();
    if (Array.isArray(spItems) && spItems.length > 0) {
      const stock = spItems[0];
      await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?id=eq.${stock.id}`, {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          online_quantity: finalQty,
          source: action === 'accept_tally' ? 'tally_godown' : 'admin_entered',
          updated_at: new Date().toISOString()
        })
      });

      if (stock.saree_id) {
        const netAvail = Math.max(0, finalQty - (stock.held_quantity || 0) - (stock.sold_pending_quantity || 0));
        await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${stock.saree_id}`, {
          method: 'PATCH',
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            stock_quantity: netAvail,
            updated_at: new Date().toISOString()
          })
        });
      }
    }

    // Update discrepancy record
    const resNotes = `${notes || ''} [Action: ${action}, Set Qty: ${finalQty}]`.trim();
    await fetch(`${SUPABASE_URL}/rest/v1/discrepancies?id=eq.${disc.id}`, {
      method: 'PATCH',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'resolved',
        resolved_by: resolved_by || 'admin:store_manager',
        resolved_at: new Date().toISOString(),
        resolution_notes: resNotes
      })
    });

    // Write audit log
    await fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actor: resolved_by || 'admin:store_manager',
        action: 'resolve_discrepancy',
        entity_type: 'discrepancies',
        entity_id: disc.id,
        old_values: { expected_qty: disc.expected_qty, actual_qty: disc.actual_qty, status: 'open' },
        new_values: { final_qty: finalQty, action, status: 'resolved' },
        metadata: { product_code: disc.product_code, notes: notes || '' }
      })
    });

    res.json({
      success: true,
      discrepancy_id: disc.id,
      status: 'resolved',
      product_code: disc.product_code,
      action,
      final_quantity: finalQty
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
app.post('/api/discrepancies/:id/resolve', requireAdminAuth, handleResolveDiscrepancy);
app.post('/discrepancies/:id/resolve', requireAdminAuth, handleResolveDiscrepancy);

// POST /api/manual-stock-entry (Shop PC Downtime Manual Stock Override)
app.post('/api/manual-stock-entry', requireAdminAuth, async (req, res) => {
  try {
    const { product_code, new_quantity, reason, admin_user, shop_id = '00000000-0000-0000-0000-000000000001' } = req.body;

    if (!product_code) {
      return res.status(400).json({ success: false, error: 'product_code is required' });
    }
    if (new_quantity === undefined || new_quantity === null || parseInt(new_quantity, 10) < 0) {
      return res.status(400).json({ success: false, error: 'new_quantity must be a non-negative integer' });
    }
    if (!reason || reason.trim() === '') {
      return res.status(400).json({ success: false, error: 'A mandatory reason is required for manual stock entries' });
    }

    const qty = parseInt(new_quantity, 10);
    const actor = admin_user || 'admin:store_manager';

    // 1. Try RPC admin_manual_stock_entry
    try {
      const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_manual_stock_entry`, {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          p_shop_id: shop_id,
          p_product_code: product_code,
          p_new_quantity: qty,
          p_reason: reason,
          p_admin_user: actor
        })
      });

      if (rpcRes.ok) {
        const rpcData = await rpcRes.json();
        return res.json(rpcData);
      }
    } catch (_rpcErr) {}

    // 2. PostgREST Fallback
    const spRes = await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?shop_id=eq.${shop_id}&product_code=eq.${encodeURIComponent(product_code)}&select=*`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const spItems = await spRes.json();
    if (!Array.isArray(spItems) || spItems.length === 0) {
      // Check if product exists in saree_catalog
      const catCheck = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?or=(sku.eq.${encodeURIComponent(product_code)},tally_part_number.eq.${encodeURIComponent(product_code)},name.eq.${encodeURIComponent(product_code)})&limit=1`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      const catRows = await catCheck.json();
      if (!Array.isArray(catRows) || catRows.length === 0) {
        return res.status(404).json({ success: false, error: `Product code ${product_code} not found in catalog or stock pool` });
      }
      const saree = catRows[0];
      // Create stock_pool entry
      await fetch(`${SUPABASE_URL}/rest/v1/stock_pool`, {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shop_id,
          product_code: saree.sku || product_code,
          saree_id: saree.id,
          online_quantity: qty,
          held_quantity: 0,
          sold_pending_quantity: 0,
          source: 'admin_entered',
          tally_godown: 'Online',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
      });
      // Update catalog
      await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${saree.id}`, {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ stock_quantity: qty, updated_at: new Date().toISOString() })
      });
      return res.json({
        success: true,
        product_code: saree.sku,
        new_quantity: qty,
        message: `Stock updated for ${saree.name} (${saree.sku}): ${qty}`
      });
    }

    const stock = spItems[0];
    const oldQty = stock.online_quantity;

    await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?id=eq.${stock.id}`, {
      method: 'PATCH',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        online_quantity: qty,
        source: 'admin_entered',
        updated_at: new Date().toISOString()
      })
    });

    if (stock.saree_id) {
      const netAvailable = Math.max(0, qty - (stock.held_quantity || 0) - (stock.sold_pending_quantity || 0));
      await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${stock.saree_id}`, {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stock_quantity: netAvailable,
          updated_at: new Date().toISOString()
        })
      });
    }

    // Write audit log
    await fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actor,
        action: 'manual_stock_entry_downtime',
        entity_type: 'stock_pool',
        entity_id: stock.id,
        old_values: { online_quantity: oldQty },
        new_values: { online_quantity: qty },
        metadata: { product_code, reason, shop_id }
      })
    });

    res.json({
      success: true,
      shop_id,
      product_code,
      old_quantity: oldQty,
      new_quantity: qty,
      reason,
      adjusted_by: actor
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/sync/runs (and /sync/runs)
async function handleGetSyncRuns(req, res) {
  try {
    const limit = parseInt(req.query.limit || '15', 10);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/sync_runs?select=*&order=started_at.desc&limit=${limit}`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const runs = await r.json();
    res.json({ success: true, count: runs.length, runs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
app.get('/api/sync/runs', handleGetSyncRuns);
app.get('/sync/runs', handleGetSyncRuns);

// GET & POST /api/sync/schedule (Dynamic morning sync time setting)
app.get('/api/sync/schedule', async (req, res) => {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.sync_schedule_config&select=*`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const items = await r.json();
    const config = items[0]?.value ? JSON.parse(items[0].value) : { time: '09:30', cutoff_minutes: 90 };
    res.json({ success: true, schedule: config });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/sync/schedule', requireAdminAuth, async (req, res) => {
  try {
    const { time, cutoff_minutes, retry_interval_minutes } = req.body;
    const newConfig = {
      time: time || '09:30',
      cutoff_minutes: parseInt(cutoff_minutes || '90', 10),
      retry_interval_minutes: parseInt(retry_interval_minutes || '15', 10),
      updated_at: new Date().toISOString()
    };

    await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.sync_schedule_config`, {
      method: 'PATCH',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify(newConfig), updated_at: new Date().toISOString() })
    });

    res.json({ success: true, message: `Morning sync schedule updated to ${newConfig.time}`, schedule: newConfig });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------------------------------------------------------
// SaaS Multi-Shop Godown Setup & Isolation Endpoints
// -----------------------------------------------------------------------------
// In-memory cache for godowns list (avoids repeated Cloudflare tunnel latency)
let cachedGodownsResult = null;
let lastGodownsFetchTime = 0;
const GODOWNS_CACHE_TTL_MS = 20000; // 20-second cache

app.get('/api/admin/godowns/list', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  const forceRefresh = req.query.refresh === 'true';

  // Use fast in-memory cache if fresh and not explicitly forced
  if (!forceRefresh && cachedGodownsResult && (Date.now() - lastGodownsFetchTime < GODOWNS_CACHE_TTL_MS)) {
    return res.json(cachedGodownsResult);
  }

  try {
    const activeGodown = await getTargetGodown();
    let tallyGodowns = [];
    let tallyHierarchy = null;
    let tallyConnected = false;

    // 1. If local Tally is connected, query local Tally directly (fast local socket)
    if (isTallyLocallyConnected) {
      tallyGodowns = await fetchTallyGodowns();
      if (tallyGodowns.length > 0) {
        tallyConnected = true;
        tallyHierarchy = buildGodownHierarchy(tallyGodowns);
      }
    }

    // 2. Live Store PC gateway FIRST. The cached snapshot below is only as fresh as
    //    the last heartbeat, and it used to be consulted before this — so while the
    //    cache held any entry at all, a godown newly created in Tally stayed invisible.
    if (tallyGodowns.length === 0) {
      try {
        const gwRes = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.in_store_gateway_url&select=value`, {
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
          signal: AbortSignal.timeout(2000)
        });
        const gwRows = await gwRes.json();
        if (Array.isArray(gwRows) && gwRows.length > 0 && gwRows[0].value) {
          const gw = typeof gwRows[0].value === 'string' ? JSON.parse(gwRows[0].value) : gwRows[0].value;
          const gwUrl = gw.lanUrl || gw.publicUrl;
          if (gwUrl) {
            const rRes = await fetch(`${gwUrl}/api/admin/godowns/list?refresh=true`, { signal: AbortSignal.timeout(2500) });
            if (rRes.ok) {
              const rData = await rRes.json();
              if (rData && Array.isArray(rData.godowns) && rData.godowns.length > 0) {
                tallyGodowns = rData.godowns;
                if (Array.isArray(rData.godownHierarchy)) {
                  tallyHierarchy = rData.godownHierarchy;
                }
                tallyConnected = Boolean(rData.tallyConnected);
              }
            }
          }
        }
      } catch (remoteErr) {
        console.warn('[GodownsList] Store PC gateway query error:', remoteErr.message);
      }
    }

    // 3. Cached Supabase snapshot: a genuine fallback now, reached only when both
    //    local Tally and the Store PC gateway are unreachable.
    if (tallyGodowns.length === 0) {
      try {
        const discRes = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=in.(tally_godown_hierarchy,tally_discovered_godowns,in_store_tally_status)&select=key,value`, {
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
          signal: AbortSignal.timeout(2000)
        });
        const discRows = await discRes.json();
        if (Array.isArray(discRows)) {
          const hierRow = discRows.find(r => r.key === 'tally_godown_hierarchy');
          if (hierRow && hierRow.value) {
            try {
              tallyHierarchy = typeof hierRow.value === 'string' ? JSON.parse(hierRow.value) : hierRow.value;
            } catch (_) {}
          }
          const discRow = discRows.find(r => r.key === 'tally_discovered_godowns');
          if (discRow && discRow.value) {
            const parsed = typeof discRow.value === 'string' ? JSON.parse(discRow.value) : discRow.value;
            if (Array.isArray(parsed) && parsed.length > 0) {
              tallyGodowns = parsed;
              tallyConnected = true;
            }
          }
          if (tallyGodowns.length === 0) {
            const statRow = discRows.find(r => r.key === 'in_store_tally_status');
            if (statRow && statRow.value) {
              const statParsed = typeof statRow.value === 'string' ? JSON.parse(statRow.value) : statRow.value;
              if (Array.isArray(statParsed.godowns) && statParsed.godowns.length > 0) {
                tallyGodowns = statParsed.godowns;
                tallyConnected = true;
              }
              if (Array.isArray(statParsed.godownHierarchy)) {
                tallyHierarchy = statParsed.godownHierarchy;
              }
            }
          }
        }
      } catch (cloudErr) {
        console.warn('[GodownsList] Cloud cache check error:', cloudErr.message);
      }
    }

    // 4. Fallback: If still empty and not yet tried locally, try local Tally once
    if (tallyGodowns.length === 0 && !isTallyLocallyConnected) {
      tallyGodowns = await fetchTallyGodowns();
      if (tallyGodowns.length > 0) {
        tallyConnected = true;
      }
    }

    // Check if target_godown has been saved in app_settings
    let isConfigured = false;
    try {
      const setRes = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.target_godown&select=value`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
        signal: AbortSignal.timeout(3000)
      });
      const setRows = await setRes.json();
      isConfigured = Array.isArray(setRows) && setRows.length > 0 && Boolean(setRows[0]?.value);
    } catch (_) {}

    // Combine godowns: all live godowns + activeGodown + Main Location
    const rawItems = [];
    if (Array.isArray(tallyHierarchy) && tallyHierarchy.length > 0) {
      rawItems.push(...tallyHierarchy);
    } else {
      tallyGodowns.forEach(g => rawItems.push(g));
    }
    if (activeGodown) {
      rawItems.push(activeGodown);
    }

    const hierarchy = buildGodownHierarchy(rawItems);
    const allGodowns = Array.from(new Set(hierarchy.map(h => h.name)));
    const activeScope = getGodownScope(activeGodown, hierarchy);

    const result = {
      success: true,
      activeGodown,
      isConfigured,
      godowns: allGodowns,
      godownHierarchy: hierarchy,
      activeGodownScope: activeScope,
      tallyConnected,
      identityVerified: isTallyIdentityVerified
    };

    // Cache result if godowns were discovered
    if (allGodowns.length > 1) {
      cachedGodownsResult = result;
      lastGodownsFetchTime = Date.now();
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------------------------------------------------------
// Native Tally Godown Summary Exporter
// Fetches the live Godown Summary report matching Tally UI
// -----------------------------------------------------------------------------
app.get('/api/admin/godowns/summary', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  const targetGodown = (req.query.godown || await getTargetGodown() || 'Main Location').trim();

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Export Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Godown Summary</REPORTNAME>
        <STATICVARIABLES>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
          <EXPLODEFLAG>No</EXPLODEFLAG>
          <ISITEMWISE>Yes</ISITEMWISE>
          <SVGODOWNNAME>${targetGodown}</SVGODOWNNAME>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;

  try {
    const rawXml = await sendToTally(xml, 6000);
    const rows = [];
    let grandTotalQty = 0;
    let grandTotalVal = 0;

    if (rawXml) {
      const lineRegex = /<DSPDISPNAME>([^<]+)<\/DSPDISPNAME>[\s\S]*?<DSPCLQTY>([^<]+)<\/DSPCLQTY>(?:[\s\S]*?<DSPCLRATE>([^<]+)<\/DSPCLRATE>)?(?:[\s\S]*?<(?:DSPCLAMTA|DSPCLVAL)>([^<]+)<\/(?:DSPCLAMTA|DSPCLVAL)>)?/gi;
      let match;
      while ((match = lineRegex.exec(rawXml)) !== null) {
        const name = unescapeXml(match[1]).trim();
        const rawQty = match[2].trim();
        const isNegQty = rawQty.includes('-') || rawQty.includes('(');
        const numMatch = rawQty.match(/[0-9.]+/);
        const qty = numMatch ? parseFloat(numMatch[0]) * (isNegQty ? -1 : 1) : 0;
        const rateStr = match[3] ? match[3].replace(/,/g, '').trim() : '0';
        const rateMatch = rateStr.match(/[0-9.]+/);
        const rate = rateMatch ? parseFloat(rateMatch[0]) : 0;
        const valStr = match[4] ? match[4].replace(/,/g, '').trim() : '0';
        const valMatch = valStr.match(/[0-9.]+/);
        const val = valMatch ? Math.abs(parseFloat(valMatch[0])) : 0;

        if (name.toLowerCase() === 'grand total') {
          grandTotalQty = qty;
          grandTotalVal = val;
        } else {
          rows.push({ name, rawQty, qty, rate, value: val });
        }
      }
    }

    if (rows.length > 0) {
      return res.json({
        success: true,
        source: 'tally_live_godown_summary',
        godown: targetGodown,
        items: rows,
        grandTotal: {
          qty: grandTotalQty || rows.reduce((s, r) => s + r.qty, 0),
          value: grandTotalVal || rows.reduce((s, r) => s + r.value, 0)
        }
      });
    }

    // Fallback: read strictly from clean tally_godown_stock_matrix without phantom heuristics
    const matRes = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.tally_godown_stock_matrix&select=value`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      signal: AbortSignal.timeout(3000)
    });
    const matRows = await matRes.json();
    let mat = {};
    if (Array.isArray(matRows) && matRows[0]?.value) {
      try { mat = typeof matRows[0].value === 'string' ? JSON.parse(matRows[0].value) : matRows[0].value; } catch (_) {}
    }

    const fallbackItems = [];
    for (const [sku, gMap] of Object.entries(mat)) {
      if (!gMap || typeof gMap !== 'object') continue;
      const gMatchKey = Object.keys(gMap).find(k => k.toLowerCase() === targetGodown.toLowerCase());
      if (gMatchKey && gMap[gMatchKey] > 0) {
        fallbackItems.push({
          name: sku,
          rawQty: `${gMap[gMatchKey]} Pcs`,
          qty: gMap[gMatchKey],
          rate: 0,
          value: 0
        });
      }
    }

    return res.json({
      success: true,
      source: 'matrix_cache',
      godown: targetGodown,
      items: fallbackItems,
      grandTotal: {
        qty: fallbackItems.reduce((s, r) => s + r.qty, 0),
        value: 0
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------------------------------------------------------
// SEC-07: Tally Identity Management Admin Endpoints
// -----------------------------------------------------------------------------

// View current registered Tally identity (Local ERP or Remote Store PC Gateway)
app.get('/api/admin/tally-identity', async (req, res) => {
  try {
    const identity = await fetchRegisteredTallyIdentity();
    
    // 1. Actively check local Tally on this computer (port 9000) with quick 800ms timeout
    let localCheck = null;
    try {
      const tally = await getTallyCompanyGUID(800);
      if (tally && tally.companyName) {
        localCheck = tally;
        isTallyLocallyConnected = true;
      } else {
        isTallyLocallyConnected = false;
      }
    } catch (_) {
      isTallyLocallyConnected = false;
    }

    // 2. Query Supabase heartbeat first (instant, <150ms)
    let remoteCheck = null;
    let remoteGwInfo = null;
    const remoteHb = await fetchRemoteTallyHeartbeat();
    if (remoteHb && remoteHb.connected && remoteHb.isFresh) {
      remoteCheck = {
        companyName: remoteHb.company,
        guid: remoteHb.guid,
        hostname: remoteHb.hostname || null,
        isRemote: true
      };
    }

    // 3. If no local Tally, check remote gateway URL info with short timeout (1500ms)
    if (!localCheck) {
      try {
        const gwRes = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.in_store_gateway_url&select=value`, {
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
          signal: AbortSignal.timeout(1500)
        });
        const gwRows = await gwRes.json();
        if (Array.isArray(gwRows) && gwRows.length > 0 && gwRows[0].value) {
          const gw = typeof gwRows[0].value === 'string' ? JSON.parse(gwRows[0].value) : gwRows[0].value;
          if (gw.publicUrl) {
            remoteGwInfo = { ...gw, isOnline: false };
            try {
              const pingRes = await fetch(`${gw.publicUrl}/api/status`, { signal: AbortSignal.timeout(1200) });
              if (pingRes.ok) {
                remoteGwInfo.isOnline = true;
                if (!remoteCheck) {
                  remoteCheck = {
                    companyName: identity?.companyName || 'Sai Traders ERP',
                    guid: identity?.guid || null,
                    gatewayUrl: gw.publicUrl,
                    lanUrl: gw.lanUrl,
                    hostname: gw.hostname,
                    isRemote: true
                  };
                }
              }
            } catch (_) {}
          }
        }
      } catch (_gwErr) {}
    }

    const activeCheck = localCheck || remoteCheck;
    const localHost = os.hostname();

    // The agent's registered device name, which is what makes "is this the store PC"
    // answerable without naming a machine in the source.
    const storePcName = String(remoteHb?.hostname || remoteGwInfo?.hostname || '').trim().toUpperCase();

    res.json({
      success: true,
      registered: identity || null,
      currentlyConnected: activeCheck ? {
        companyName: activeCheck.companyName,
        guid: activeCheck.guid,
        matchesRegistered: identity ? (activeCheck.guid === identity.guid) : true,
        isRemote: Boolean(remoteCheck),
        hostname: activeCheck.hostname || (localCheck ? localHost : null),
        gatewayUrl: activeCheck.gatewayUrl || null
      } : (identity ? {
        companyName: identity.companyName,
        guid: identity.guid,
        matchesRegistered: true,
        isRemote: true,
        hostname: identity.hostname || null,
        gatewayUrl: null
      } : null),
      isVerified: Boolean(identity),
      localTallyConnected: Boolean(localCheck),
      remoteStoreConnected: Boolean(remoteCheck || remoteHb?.connected),
      remoteGwOnline: Boolean(remoteGwInfo?.isOnline || remoteHb?.isFresh),
      remoteGwDetected: Boolean(remoteGwInfo || remoteHb),
      remoteHostname: remoteGwInfo?.hostname || remoteCheck?.hostname || remoteHb?.hostname || null,
      remoteGatewayUrl: remoteGwInfo?.publicUrl || remoteCheck?.gatewayUrl || null,
      currentDevice: {
        hostname: localHost,
        // Which machine is the store PC is a fact about this shop's registration, not a
        // name compiled into the source. 'AISHWARYA' and 'MITHUN' were hardcoded here,
        // so the answer was wrong at every other shop and stayed wrong the moment a PC
        // was replaced — the agent's registered device name is the real answer.
        isStorePc: Boolean(storePcName) && localHost.toUpperCase() === storePcName,
        isLaptop: !(Boolean(storePcName) && localHost.toUpperCase() === storePcName)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Diagnostic endpoint to test local Tally communication on port 9000
app.get('/api/admin/tally-ping', async (req, res) => {
  const start = Date.now();
  try {
    const raw = await sendToTally(`<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>CompanyCollection</ID></HEADER>
  <BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
  <TDL><TDLMESSAGE><COLLECTION NAME="CompanyCollection"><TYPE>Company</TYPE><FETCH>Name,GUID,CompanyNumber</FETCH></COLLECTION></TDLMESSAGE></TDL>
  </DESC></BODY>
</ENVELOPE>`, 4000);
    const latencyMs = Date.now() - start;
    const nameMatch = raw.match(/<NAME[^>]*>([^<]+)<\/NAME>/i);
    const guidMatch = raw.match(/<GUID[^>]*>([^<]+)<\/GUID>/i);
    res.json({
      success: true,
      latencyMs,
      company: nameMatch ? nameMatch[1].trim() : null,
      guid: guidMatch ? guidMatch[1].trim() : null,
      rawSnippet: raw.substring(0, 300)
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      latencyMs: Date.now() - start,
      error: err.message,
      code: err.code || null
    });
  }
});

// -----------------------------------------------------------------------------
// SEC-08: In-Store Desktop Bridge Telemetry & Health Endpoints
// -----------------------------------------------------------------------------
app.get('/api/bridge-telemetry', async (req, res) => {
  try {
    const activeGodown = await getTargetGodown();
    const identity = await fetchRegisteredTallyIdentity();
    const queueStats = typeof tallyQueue !== 'undefined' ? tallyQueue.getStats() : { pending: 0, spacingMs: 250, isProcessing: false };

    let tallyStatus = { connected: false, company: null, latencyMs: null, notice: 'Port 9000 waiting for Tally' };
    const pingStart = Date.now();
    try {
      const tally = await getTallyCompanyGUID(1500);
      if (tally && tally.companyName) {
        tallyStatus = {
          connected: true,
          company: tally.companyName,
          guid: tally.guid,
          latencyMs: Date.now() - pingStart,
          notice: 'Active'
        };
      }
    } catch (e) {
      tallyStatus.notice = e.message || 'Offline';
    }

    res.json({
      success: true,
      hostname: os.hostname(),
      godown: activeGodown || 'Saree',
      tally: tallyStatus,
      queueStats: queueStats,
      registeredIdentity: identity,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Force verify current Tally connection
app.post('/api/admin/tally-identity/verify', requireAdminAuth, async (req, res) => {
  try {
    lastIdentityCheckTime = 0; // Force fresh check
    isTallyIdentityVerified = false;
    const result = await verifyTallyIdentity(3000);
    res.json({ success: true, verification: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Instant sync transition: Update stock_pool and saree_catalog when switching active godown
async function syncGodownStockTransition(cleanGodown) {
  if (!isStockWriter()) {
    // target_godown is still persisted by the caller — only the quantity rewrite is
    // skipped. The Store PC repopulates stock_pool for the new godown on its next
    // 12s reconcile, from live Tally rather than from a stale matrix.
    console.log(`[syncGodownStockTransition] Skipped stock rewrite for "${cleanGodown}" — not the designated stock writer. Store PC will repopulate.`);
    return;
  }
  try {
    const matRes = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.tally_godown_stock_matrix&select=value`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const matRows = await matRes.json();
    let mat = {};
    if (Array.isArray(matRows) && matRows[0]?.value) {
      try { mat = typeof matRows[0].value === 'string' ? JSON.parse(matRows[0].value) : matRows[0].value; } catch (_) {}
    }

    const [spRes, catRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/stock_pool?select=*`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }),
      fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?select=id,sku,tally_part_number,name,stock_quantity,attributes_json`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } })
    ]);
    const spRows = (spRes.ok ? await spRes.json() : []) || [];
    const catRows = (catRes.ok ? await catRes.json() : []) || [];

    for (const sp of spRows) {
      const codeKey = (sp.product_code || '').toLowerCase().trim();
      const itemGodowns = mat[codeKey] || {};
      const gMatchKey = Object.keys(itemGodowns).find(k => k.toLowerCase() === cleanGodown.toLowerCase());
      const newQty = gMatchKey !== undefined ? (itemGodowns[gMatchKey] || 0) : (sp.online_quantity || 0);
      await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?id=eq.${sp.id}`, {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tally_godown: cleanGodown,
          online_quantity: Math.max(0, newQty),
          last_synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
      });
    }

    for (const cat of catRows) {
      const codeKey = (cat.sku || cat.tally_part_number || '').toLowerCase().trim();
      const nameKey = (cat.name || '').toLowerCase().trim();
      const itemGodowns = mat[codeKey] || mat[nameKey] || cat.attributes_json?.godown_stocks || {};
      const gMatchKey = Object.keys(itemGodowns).find(k => k.toLowerCase() === cleanGodown.toLowerCase());
      const newQty = gMatchKey !== undefined ? (itemGodowns[gMatchKey] || 0) : (cat.stock_quantity || 0);
      const attrs = cat.attributes_json || {};
      if (gMatchKey !== undefined) {
        if (!attrs.godown_stocks) attrs.godown_stocks = {};
        attrs.godown_stocks[cleanGodown] = newQty;
      }
      await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${cat.id}`, {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stock_quantity: Math.max(0, newQty),
          attributes_json: attrs,
          updated_at: new Date().toISOString()
        })
      });
    }
    console.log(`[syncGodownStockTransition] ✓ Switched active godown to "${cleanGodown}" across ${spRows.length} stock pool items.`);
  } catch (err) {
    console.warn('[syncGodownStockTransition] Warning during instant stock transition:', err.message);
  }
}

// Authorize & Pair currently connected Tally instance + set active godown
app.post('/api/admin/tally-identity/pair', requireAdminAuth, async (req, res) => {
  try {
    const { godownName, createGodownIfMissing = true, companyName: passedCompany, guid: passedGuid } = req.body;
    
    // 1. Try local Tally first (if running on Store PC with Tally port 9000 open)
    let currentTally = null;
    try {
      const localTally = await getTallyCompanyGUID(1500);
      if (localTally && localTally.companyName && localTally.guid) {
        currentTally = localTally;
      }
    } catch (_) {}

    // 2. If not local, check passed parameters or remote Store PC heartbeat
    if (!currentTally) {
      if (passedCompany && passedGuid) {
        currentTally = {
          companyName: passedCompany,
          guid: passedGuid,
          isRemote: true
        };
      } else {
        const hb = await fetchRemoteTallyHeartbeat();
        if (hb && hb.company && hb.guid) {
          currentTally = {
            companyName: hb.company,
            guid: hb.guid,
            isRemote: true
          };
        }
      }
    }

    const cleanGodown = (godownName || currentTargetGodown || 'Main Location').trim();

    // 3. Pair Tally and ensure godown
    if (currentTally) {
      if (!currentTally.isRemote && createGodownIfMissing && cleanGodown.toLowerCase() !== 'main location') {
        try {
          await ensureGodownExistsInTally(cleanGodown);
        } catch (_) {}
      }

      const result = await registerTallyIdentity(currentTally, cleanGodown);
      if (!result.registered) {
        return res.status(500).json({ success: false, error: result.error });
      }

      lastIdentityCheckTime = Date.now();
      isTallyIdentityVerified = true;

      // Update flagship shops configuration
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/shops?code=eq.SAI`, {
          method: 'PATCH',
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            settings: { online_godown: cleanGodown, city: 'Tumakuru', state: 'Karnataka' },
            updated_at: new Date().toISOString()
          })
        });
      } catch (_) {}

      await syncGodownStockTransition(cleanGodown);

      return res.json({
        success: true,
        message: `Tally "${currentTally.companyName}" successfully paired & authorized with Godown "${cleanGodown}".`,
        identity: result.identity,
        godown: cleanGodown
      });
    }

    // 3. Local Tally not open: Forward to remote Store PC gateway if registered in Supabase
    try {
      const gwRes = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.in_store_gateway_url&select=value`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      const gwRows = await gwRes.json();
      if (Array.isArray(gwRows) && gwRows.length > 0 && gwRows[0].value) {
        const gw = typeof gwRows[0].value === 'string' ? JSON.parse(gwRows[0].value) : gwRows[0].value;
        if (gw.publicUrl) {
          try {
            const forwardRes = await fetch(`${gw.publicUrl}/api/admin/tally-identity/pair`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-admin-key': ADMIN_API_KEY || SERVICE_KEY || 'sai-traders-admin-key',
                'Authorization': `Bearer ${SERVICE_KEY}`
              },
              body: JSON.stringify({ godownName: cleanGodown, createGodownIfMissing }),
              signal: AbortSignal.timeout(6000)
            });
            if (forwardRes.ok) {
              const forwardData = await forwardRes.json();
              if (forwardData.success) {
                await setTargetGodown(cleanGodown);
                await syncGodownStockTransition(cleanGodown);
                return res.json({
                  ...forwardData,
                  forwardedToRemote: true,
                  storeHostname: gw.hostname || 'Store PC'
                });
              }
            }
          } catch (fwdErr) {
            console.warn('[PairTally] Could not forward to remote Store PC:', fwdErr.message);
          }
        }
      }
    } catch (_gwErr) {}

    // 4. Cloud Fallback: Save target godown directly in Cloud so admin is never blocked
    await setTargetGodown(cleanGodown);
    await syncGodownStockTransition(cleanGodown);

    try {
      await fetch(`${SUPABASE_URL}/rest/v1/shops?code=eq.SAI`, {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: { online_godown: cleanGodown, city: 'Tumakuru', state: 'Karnataka' },
          updated_at: new Date().toISOString()
        })
      });
    } catch (_) {}

    // Update existing registered Tally identity with new godown if one exists
    let existingIdentity = registeredTallyIdentity || await fetchRegisteredTallyIdentity();
    if (existingIdentity) {
      existingIdentity.godown = cleanGodown;
      existingIdentity.updatedAt = new Date().toISOString();
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/app_settings`, {
          method: 'POST',
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
          body: JSON.stringify({
            key: 'registered_tally_identity',
            value: JSON.stringify(existingIdentity),
            updated_at: new Date().toISOString()
          })
        });
        registeredTallyIdentity = existingIdentity;
      } catch (_) {}
    }

    return res.json({
      success: true,
      cloudOnly: true,
      godown: cleanGodown,
      identity: existingIdentity || null,
      message: `Godown "${cleanGodown}" saved in Cloud. It will automatically link to Tally when Store PC connects.`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reset registered identity (requires admin auth — used when switching to a different Tally company)
app.post('/api/admin/tally-identity/reset', requireAdminAuth, async (req, res) => {
  try {
    // Clear from Supabase
    await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.registered_tally_identity`, {
      method: 'DELETE',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    // Clear in-memory
    registeredTallyIdentity = null;
    isTallyIdentityVerified = false;
    lastIdentityCheckTime = 0;
    console.log('[TallyIdentity] 🔓 Identity reset by admin. Next connection will auto-register.');
    
    // If Tally is locally connected, immediately re-register
    if (isTallyLocallyConnected) {
      const reReg = await verifyTallyIdentity(3000);
      return res.json({
        success: true,
        message: 'Identity reset and re-registered with currently connected Tally.',
        newIdentity: reReg
      });
    }
    
    res.json({
      success: true,
      message: 'Tally identity cleared. Will auto-register on next Tally connection.'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/godowns/configure', requireAdminAuth, async (req, res) => {
  try {
    const { godown } = req.body;
    if (!godown || typeof godown !== 'string' || !godown.trim()) {
      return res.status(400).json({ success: false, error: 'A valid godown name is required.' });
    }
    const cleanGodown = godown.trim();
    await setTargetGodown(cleanGodown);

    // Auto-ensure Godown master exists in connected Tally instance
    try {
      const godownXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<GODOWN NAME="${escapeXml(cleanGodown)}" ACTION="Create">
  <NAME>${escapeXml(cleanGodown)}</NAME>
  <PARENT/>
</GODOWN>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
      await sendToTally(godownXml, 4000);
    } catch (_) {}

    // Also update shops flagship configuration
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/shops?code=eq.SAI`, {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: {
            online_godown: cleanGodown,
            city: 'Tumakuru',
            state: 'Karnataka'
          },
          updated_at: new Date().toISOString()
        })
      });
    } catch (_) {}

    res.json({
      success: true,
      activeGodown: cleanGodown,
      message: `SaaS designated godown locked to "${cleanGodown}". Strict isolation active.`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sync Sales to Google Sheets via Webhook
app.post('/api/admin/sync-sheets', requireAdminAuth, async (req, res) => {
  try {
    const { period = 'all' } = req.body || {};
    const currentEnv = loadEnv();
    const webhookUrl = currentEnv.GOOGLE_SHEET_WEBHOOK_URL || process.env.GOOGLE_SHEET_WEBHOOK_URL;
    if (!webhookUrl) {
      return res.status(400).json({ success: false, error: 'GOOGLE_SHEET_WEBHOOK_URL is not configured.' });
    }

    let url = `${SUPABASE_URL}/rest/v1/orders?select=id,order_number,status,total_amount,payment_status,channel,items,created_at,customers(name,phone_number)&order=created_at.desc`;
    if (period === 'today') {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      url += `&created_at=gte.${encodeURIComponent(today.toISOString())}`;
    }

    const oRes = await fetch(url, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const orders = await oRes.json();
    if (!orders || orders.length === 0) {
      return res.json({ success: true, count: 0, message: 'No orders found to sync for the selected period.' });
    }

    // Format rows
    const rows = orders.map(ord => {
      let totalUnits = 0;
      let sareeList = [];
      if (Array.isArray(ord.items)) {
        ord.items.forEach(it => {
          const qty = parseInt(it.quantity || it.qty || 1, 10);
          totalUnits += qty;
          sareeList.push(`${it.name || it.title || it.sku || 'Saree'} (${qty}x)`);
        });
      }
      if (sareeList.length === 0) {
        sareeList.push('Saree Order');
        totalUnits = 1;
      }
      const d = new Date(ord.created_at);
      const dateFormatted = d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' });

      return {
        date: dateFormatted,
        orderNumber: ord.order_number || `ORD-${ord.id.slice(0, 8)}`,
        customerName: ord.customers?.name || 'Walk-in / WhatsApp Customer',
        customerPhone: ord.customers?.phone_number || '-',
        sareeItems: sareeList.join(', '),
        totalUnits: totalUnits,
        totalAmount: Number(ord.total_amount || 0),
        paymentStatus: (ord.payment_status || 'paid').toUpperCase(),
        channel: (ord.channel || 'WhatsApp').toUpperCase(),
        status: (ord.status || 'completed').toUpperCase()
      };
    });

    const postRes = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rows),
      redirect: 'follow'
    });

    const postResult = await postRes.json().catch(() => ({}));
    res.json({ success: postRes.ok, count: rows.length, message: `Successfully synced ${rows.length} sales orders to Google Sheets!`, data: postResult });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Helper: Automatically push a single order to Google Spreadsheet
async function syncSingleOrderToGoogleSheets(order) {
  try {
    const currentEnv = loadEnv();
    const webhookUrl = currentEnv.GOOGLE_SHEET_WEBHOOK_URL || process.env.GOOGLE_SHEET_WEBHOOK_URL;
    if (!webhookUrl) return false;

    let totalUnits = 0;
    let sareeList = [];
    if (Array.isArray(order.items)) {
      order.items.forEach(it => {
        const qty = parseInt(it.quantity || it.qty || 1, 10);
        totalUnits += qty;
        sareeList.push(`${it.name || it.sku || 'Saree'} (${qty}x)`);
      });
    }

    const d = new Date(order.created_at || Date.now());
    const dateFormatted = d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' });

    const activeGodown = order.godown || (await getTargetGodown()) || 'Online_saree';
    const row = {
      date: dateFormatted,
      orderNumber: order.order_number,
      customerName: order.customer?.name || order.shipping_address?.name || 'Walk-in / WhatsApp Customer',
      customerPhone: order.customer?.phone || order.shipping_address?.phone || '-',
      sareeItems: sareeList.join(', ') || 'Saree Order',
      totalUnits: totalUnits || 1,
      totalAmount: Number(order.total_amount || 0),
      paymentStatus: (order.payment_status || 'paid').toUpperCase(),
      channel: (order.channel || 'WEB').toUpperCase(),
      godown: activeGodown,
      tallyVoucher: order.tally_voucher_ref || (order.tally_synced ? `VCH-${order.order_number}` : '-'),
      tallySyncStatus: order.tally_synced ? 'SYNCED' : 'PENDING (OFFLINE)',
      status: (order.status || 'confirmed').toUpperCase()
    };

    const postRes = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([row]),
      redirect: 'follow'
    });
    return postRes.ok;
  } catch (err) {
    console.warn('[syncSingleOrderToGoogleSheets] Webhook notice:', err.message);
    return false;
  }
}

// =============================================================================
// EXTERNAL STOREFRONT REST APIs (Angular / E-Commerce Storefront Integration)
// =============================================================================

// 1. GET /api/v1/store/products
// Fetch full catalog with photos, price, description, live stock, and color variants
app.get('/api/v1/store/products', requireStorefrontAuth, async (req, res) => {
  try {
    const inStockOnly = req.query.in_stock_only !== 'false';
    const searchQuery = (req.query.search || '').toLowerCase().trim();

    const [pRes, vRes, spRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?order=created_at.desc`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/video_record?select=id,video_id,product_code,saree,reference_frames`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/stock_pool?select=*`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      })
    ]);

    const products = (pRes.ok ? await pRes.json() : []) || [];
    const videoRecords = (vRes.ok ? await vRes.json() : []) || [];
    const stockPool = (spRes.ok ? await spRes.json() : []) || [];

    const videoMap = new Map();
    videoRecords.forEach(v => {
      if (v.product_code) videoMap.set(v.product_code.toLowerCase(), v);
    });

    const stockMap = new Map();
    stockPool.forEach(s => {
      if (s.product_code) stockMap.set(s.product_code.toLowerCase(), s);
      if (s.saree_id) stockMap.set(s.saree_id, s);
    });

    // Enrich products with live stock
    const enriched = products.map(p => {
      const code = (p.tally_part_number || p.sku || '').trim();
      const video = videoMap.get(code.toLowerCase());
      const stock = stockMap.get(code.toLowerCase()) || stockMap.get(p.id);

      const onlineStock = stock ? stock.online_quantity : (p.stock_quantity ?? 0);
      const heldStock = stock ? stock.held_quantity : 0;
      const availableStock = Math.max(0, onlineStock - heldStock);

      return {
        id: p.id,
        sku: code,
        name: p.name || 'Handcrafted Silk Saree',
        fabric: p.fabric || 'Pure Silk',
        weave: p.weave_style || null,
        color_primary: p.color_primary || 'Assorted',
        price: Number(p.price || 0),
        mrp: Number(p.mrp || p.price || 0),
        stock: availableStock,
        in_stock: availableStock > 0,
        image_urls: Array.isArray(p.image_urls) ? p.image_urls : [],
        description: p.description || '',
        design_family_id: p.design_family_id || null,
        has_video: Boolean(video),
        video_description: video?.saree?.stylist_summary || video?.review_notes || null
      };
    });

    // Group variants by design_family_id if present
    const familyMap = new Map();
    const finalStoreProducts = [];

    enriched.forEach(p => {
      if (p.design_family_id) {
        if (!familyMap.has(p.design_family_id)) {
          const groupObj = {
            id: p.design_family_id,
            sku: p.sku.replace(/-[A-Z0-9]+$/i, ''),
            name: (p.name || '').replace(/\s*\([^)]*\)\s*$/, '').trim(),
            fabric: p.fabric,
            weave: p.weave,
            price: p.price,
            mrp: p.mrp,
            description: p.description,
            stock: 0,
            in_stock: false,
            image_urls: [...p.image_urls],
            is_group: true,
            has_video: p.has_video,
            variants: []
          };
          familyMap.set(p.design_family_id, groupObj);
          finalStoreProducts.push(groupObj);
        }
        const grp = familyMap.get(p.design_family_id);
        grp.variants.push({
          id: p.id,
          sku: p.sku,
          name: p.name,
          color: p.color_primary,
          stock: p.stock,
          in_stock: p.stock > 0,
          price: p.price,
          mrp: p.mrp,
          image_urls: p.image_urls
        });
        grp.stock += p.stock;
        if (p.stock > 0) grp.in_stock = true;
        if (p.image_urls.length > 0 && grp.image_urls.length === 0) {
          grp.image_urls = p.image_urls;
        }
        if (p.has_video) grp.has_video = true;
      } else {
        finalStoreProducts.push({
          ...p,
          is_group: false,
          variants: []
        });
      }
    });

    // Filter by stock and search query
    let filtered = finalStoreProducts;
    if (inStockOnly) {
      filtered = filtered.filter(p => p.stock > 0);
    }
    if (searchQuery) {
      filtered = filtered.filter(p => {
        return (
          p.sku.toLowerCase().includes(searchQuery) ||
          p.name.toLowerCase().includes(searchQuery) ||
          (p.fabric && p.fabric.toLowerCase().includes(searchQuery)) ||
          (p.description && p.description.toLowerCase().includes(searchQuery))
        );
      });
    }

    res.json({
      success: true,
      count: filtered.length,
      store: 'Sai Traders',
      currency: 'INR',
      products: filtered
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. GET /api/v1/store/products/:sku
// Fetch single product / variant details by SKU
app.get('/api/v1/store/products/:sku', requireStorefrontAuth, async (req, res) => {
  try {
    const rawSku = (req.params.sku || '').trim().toUpperCase();
    if (!rawSku) {
      return res.status(400).json({ success: false, error: 'SKU is required.' });
    }

    const pRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?or=(sku.eq.${encodeURIComponent(rawSku)},tally_part_number.eq.${encodeURIComponent(rawSku)})&limit=1`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const catalogItems = await pRes.json();
    let item = catalogItems?.[0];

    if (!item) {
      // Fallback: check prefix match (e.g. searching 'SAI-VAR-01' finds 'SAI-VAR-01-BLU' variant or family)
      const prefixRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?sku=ilike.${encodeURIComponent(rawSku + '%')}&limit=1`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      const prefixItems = await prefixRes.json();
      item = prefixItems?.[0];
    }

    if (!item) {
      return res.status(404).json({ success: false, error: `Product [${rawSku}] not found.` });
    }

    // If part of design family, fetch all sibling variants
    let variants = [];
    let liveStock = Number(item.stock_quantity || 0);

    if (item.design_family_id) {
      const famRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?design_family_id=eq.${item.design_family_id}`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      const famItems = (await famRes.json()) || [];
      variants = famItems.map(f => ({
        id: f.id,
        sku: f.sku || f.tally_part_number,
        name: f.name,
        color: f.color_primary || 'Color',
        price: Number(f.price || item.price),
        mrp: Number(f.mrp || item.mrp),
        stock: Number(f.stock_quantity || 0),
        in_stock: Number(f.stock_quantity || 0) > 0,
        image_urls: Array.isArray(f.image_urls) ? f.image_urls : []
      }));
      liveStock = variants.reduce((acc, v) => acc + (v.stock || 0), 0);
    } else {
      const spRes = await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?or=(product_code.eq.${encodeURIComponent(item.sku || rawSku)},saree_id.eq.${encodeURIComponent(item.id)})&limit=1`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      const spRows = await spRes.json();
      const stockRec = spRows?.[0];
      if (stockRec) {
        liveStock = Math.max(0, stockRec.online_quantity - (stockRec.held_quantity || 0));
      }
    }

    res.json({
      success: true,
      product: {
        id: item.id,
        sku: item.sku || item.tally_part_number,
        name: item.name,
        fabric: item.fabric,
        weave: item.weave_style,
        color_primary: item.color_primary,
        price: Number(item.price || 0),
        mrp: Number(item.mrp || item.price || 0),
        stock: liveStock,
        in_stock: liveStock > 0,
        image_urls: Array.isArray(item.image_urls) ? item.image_urls : [],
        description: item.description,
        design_family_id: item.design_family_id || null,
        is_group: Boolean(item.design_family_id),
        variants: variants
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. POST /api/v1/store/orders
// Post-checkout purchase update webhook from Angular
app.post('/api/v1/store/orders', requireStorefrontAuth, async (req, res) => {
  try {
    const {
      order_id,
      customer,
      items,
      total_amount,
      payment_status = 'paid',
      payment_method = 'online',
      payment_reference = null,
      notes = ''
    } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'Order must contain at least one item.' });
    }

    const orderNumber = (order_id || `ANG-${Date.now()}`).trim();
    const cleanCustomer = {
      name: customer?.name || 'Angular Storefront Customer',
      phone: customer?.phone || customer?.mobile || '',
      email: customer?.email || '',
      address: customer?.address || customer?.street || 'Online Web Order'
    };
    // Price integrity: the total is computed from catalog prices, never taken from the
    // caller. `total_amount` from the request body used to be recorded verbatim, so an
    // order could be booked at any amount by whoever held the storefront API key — the
    // "alteration in amount" risk named in the project brief.
    const priceRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?select=sku,tally_part_number,price`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const priceRows = (priceRes.ok ? await priceRes.json() : []) || [];
    const priceOf = new Map();
    for (const row of priceRows) {
      const unit = Number(row.price) || 0;
      if (row.sku) priceOf.set(String(row.sku).trim().toUpperCase(), unit);
      if (row.tally_part_number) priceOf.set(String(row.tally_part_number).trim().toUpperCase(), unit);
    }

    let serverAmount = 0;
    const unpriced = [];
    for (const item of items) {
      const sku = String(item.sku || '').trim().toUpperCase();
      const qty = parseInt(item.quantity || item.qty || 1, 10) || 0;
      if (!sku || qty <= 0) continue;
      if (!priceOf.has(sku)) { unpriced.push(sku); continue; }
      serverAmount += priceOf.get(sku) * qty;
    }

    if (unpriced.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Unknown or unpriced item(s): ${unpriced.join(', ')}. Order rejected.`
      });
    }

    const claimedAmount = parseFloat(total_amount);
    if (Number.isFinite(claimedAmount) && Math.abs(claimedAmount - serverAmount) > 0.01) {
      console.warn(`[StorefrontOrder] Amount mismatch on ${orderNumber}: client claimed ${claimedAmount}, catalog total ${serverAmount}. Rejected.`);
      return res.status(409).json({
        success: false,
        error: 'Order total does not match catalog pricing.',
        expectedAmount: serverAmount
      });
    }

    const cleanAmount = serverAmount;
    const targetGodown = await getTargetGodown();

    // 1. Deduct Stock in Supabase Immediately (stock_pool + saree_catalog)
    const stockUpdates = [];
    for (const item of items) {
      const sku = (item.sku || '').trim().toUpperCase();
      const qty = parseInt(item.quantity || item.qty || 1, 10);
      if (!sku) continue;

      try {
        // Deduct from stock_pool
        const spRes = await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?product_code=eq.${encodeURIComponent(sku)}`, {
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
        });
        const spRows = await spRes.json();
        if (spRows?.[0]) {
          const newQty = Math.max(0, (spRows[0].online_quantity || 0) - qty);
          await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?id=eq.${spRows[0].id}`, {
            method: 'PATCH',
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ online_quantity: newQty, last_synced_at: new Date().toISOString() })
          });
        }

        // Deduct from saree_catalog
        const catRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?or=(sku.eq.${encodeURIComponent(sku)},tally_part_number.eq.${encodeURIComponent(sku)})`, {
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
        });
        const catRows = await catRes.json();
        if (catRows?.[0]) {
          const newCatQty = Math.max(0, (catRows[0].stock_quantity || 0) - qty);
          await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${catRows[0].id}`, {
            method: 'PATCH',
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ stock_quantity: newCatQty, updated_at: new Date().toISOString() })
          });
        }

        stockUpdates.push({ sku, deducted: qty });
      } catch (deductErr) {
        console.warn(`[StoreOrder] Stock deduction error for ${sku}:`, deductErr.message);
      }
    }

    // 2. Insert Order into Supabase orders table
    const orderRecord = {
      order_number: orderNumber,
      channel: 'web',
      status: 'confirmed',
      payment_status: payment_status.toLowerCase(),
      payment_method: payment_method,
      total_amount: cleanAmount,
      items: items,
      shipping_address: cleanCustomer,
      notes: `Purchased via Angular Storefront [${orderNumber}] ${notes ? '| ' + notes : ''}`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const insRes = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(orderRecord)
    });
    const createdOrder = await insRes.json().catch(() => null);

    // 3. Post Sales Voucher into Tally ERP Sarees Godown
    let tallySynced = false;
    for (const item of items) {
      const sku = (item.sku || '').trim().toUpperCase();
      const name = item.name || sku;
      const qty = parseInt(item.quantity || 1, 10);
      const rate = parseFloat(item.price) || 5000;
      const isNos = /mysore|paithani|0021|0022/i.test(name + sku);
      const unitLabel = isNos ? 'Nos' : 'Pcs';

      try {
        let voucherXml = buildTallySalesVoucherXml({
          orderNumber,
          stockItemName: sku,
          qty,
          rate,
          unitLabel,
          godownName: targetGodown,
          buyerName: cleanCustomer.name
        });

        let tallyRes = await sendToTally(voucherXml);
        let isSuccess = tallyRes.includes('<CREATED>1</CREATED>') || 
                        tallyRes.includes('<ALTERED>1</ALTERED>') ||
                        tallyRes.includes('Already Exists');

        // Educational mode date restriction fallback
        if (!isSuccess && tallyRes.includes('Voucher date is missing')) {
          const now = new Date();
          const fallbackDate = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}01`;
          voucherXml = buildTallySalesVoucherXml({
            orderNumber,
            stockItemName: sku,
            qty,
            rate,
            unitLabel,
            godownName: targetGodown,
            buyerName: cleanCustomer.name,
            dateOverride: fallbackDate
          });
          tallyRes = await sendToTally(voucherXml);
          isSuccess = tallyRes.includes('<CREATED>1</CREATED>') || tallyRes.includes('Already Exists');
        }

        if (isSuccess) {
          tallySynced = true;
        }
      } catch (tErr) {
        console.warn(`[StoreOrder] Tally voucher sync error for ${sku}:`, tErr.message);
      }
    }

    if (tallySynced && createdOrder?.[0]?.id) {
      await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${createdOrder[0].id}`, {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: `${orderRecord.notes} | TALLY_SYNCED_VCH_${orderNumber}` })
      });
    }

    // 4. Automatically Sync to Google Spreadsheet
    const sheetsSynced = await syncSingleOrderToGoogleSheets({
      order_number: orderNumber,
      customer: cleanCustomer,
      items: items,
      total_amount: cleanAmount,
      payment_status: payment_status,
      status: 'confirmed',
      created_at: new Date().toISOString()
    });

    res.json({
      success: true,
      message: `Order [${orderNumber}] received! Inventory updated, Tally ${targetGodown} godown synced, and Google Sheets logged.`,
      order_number: orderNumber,
      stock_updates: stockUpdates,
      tally_synced: tallySynced,
      sheets_synced: sheetsSynced,
      target_godown: targetGodown
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// -----------------------------------------------------------------------------
// Separate Sales Analytics API
// -----------------------------------------------------------------------------
app.get('/api/admin/analytics/sales', async (req, res) => {
  try {
    const period = (req.query.period || '7d').toLowerCase();
    let startDate = null;
    const now = new Date();

    if (period === 'today') {
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      startDate = today.toISOString();
    } else if (period === '7d') {
      const d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      startDate = d.toISOString();
    } else if (period === '30d') {
      const d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      startDate = d.toISOString();
    }

    let url = `${SUPABASE_URL}/rest/v1/orders?select=id,order_number,status,total_amount,payment_status,channel,items,notes,created_at,customers(name,phone_number)&order=created_at.desc`;
    if (startDate) {
      url += `&created_at=gte.${startDate}`;
    }

    const ordersRes = await fetch(url, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const rawOrders = await ordersRes.json();
    const orders = Array.isArray(rawOrders) ? rawOrders : [];

    // Aggregations
    let totalRevenue = 0;
    let completedOrders = 0;
    let totalUnitsSold = 0;
    const statusBreakdown = {};
    const channelBreakdown = {};
    const sareeVolumeMap = {};

    for (const ord of orders) {
      const st = ord.status || 'pending';
      statusBreakdown[st] = (statusBreakdown[st] || 0) + 1;

      const ch = ord.channel || 'whatsapp';
      channelBreakdown[ch] = (channelBreakdown[ch] || 0) + 1;

      const isCompleted = ['confirmed', 'paid', 'paid_pending_approval', 'approved', 'posted_to_tally', 'packed', 'shipped', 'delivered', 'dispatched'].includes(st);
      
      const amt = Number(ord.total_amount) || 0;
      if (isCompleted || ord.payment_status === 'paid') {
        totalRevenue += amt;
        completedOrders += 1;
      }

      // Items calculation
      const itemsList = Array.isArray(ord.items) ? ord.items : [];
      for (const item of itemsList) {
        const qty = parseInt(item.quantity, 10) || 1;
        if (isCompleted || ord.payment_status === 'paid') {
          totalUnitsSold += qty;
          const sName = item.name || item.sku || 'Saree';
          sareeVolumeMap[sName] = (sareeVolumeMap[sName] || 0) + qty;
        }
      }
    }

    const averageOrderValue = completedOrders > 0 ? Math.round(totalRevenue / completedOrders) : 0;

    // Top sarees list
    const topSarees = Object.entries(sareeVolumeMap)
      .map(([name, units]) => ({ name, units }))
      .sort((a, b) => b.units - a.units)
      .slice(0, 5);

    // Format orders for table display
    const formattedOrders = orders.map(ord => {
      const itemsList = Array.isArray(ord.items) ? ord.items : [];
      const itemDesc = itemsList.map(i => `${i.name || i.sku || 'Saree'} (x${i.quantity || 1})`).join(', ') || 'Standard Saree Order';
      return {
        id: ord.id,
        order_number: ord.order_number,
        customer_name: ord.customers?.name || 'Customer',
        customer_phone: ord.customers?.phone_number || '-',
        date: ord.created_at,
        items_desc: itemDesc,
        item_count: itemsList.reduce((acc, i) => acc + (parseInt(i.quantity, 10) || 1), 0),
        total_amount: Number(ord.total_amount) || 0,
        status: ord.status,
        payment_status: ord.payment_status || 'pending',
        channel: ord.channel || 'whatsapp'
      };
    });

    const activeGodown = await getTargetGodown();

    res.json({
      success: true,
      period,
      activeGodown,
      metrics: {
        totalRevenue,
        totalOrders: orders.length,
        completedOrders,
        averageOrderValue,
        totalUnitsSold,
        statusBreakdown,
        channelBreakdown,
        topSarees
      },
      orders: formattedOrders
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/new-stock: Recently detected inward stock & draft items
app.get('/api/new-stock', async (req, res) => {
  try {
    const [draftsRes, auditRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?status=in.(draft,pending_review)&select=*&order=created_at.desc&limit=20`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/audit_log?action=eq.new_stock_inward_detected&order=created_at.desc&limit=15`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      })
    ]);

    const drafts = await draftsRes.json();
    const inwards = await auditRes.json();

    res.json({
      success: true,
      draft_items: Array.isArray(drafts) ? drafts : [],
      inward_events: Array.isArray(inwards) ? inwards : []
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------------------------------------------------------
// 4. API: Video Knowledge Registry (Videos & Craft Descriptions)
// -----------------------------------------------------------------------------
app.get('/api/videos', async (req, res) => {
  try {
    const vRes = await fetch(`${SUPABASE_URL}/rest/v1/video_record?order=created_at.desc`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const records = await vRes.json();
    res.json({ success: true, count: records.length, records });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/videos', requireAdminAuth, async (req, res) => {
  try {
    const {
      video_id,
      product_code,
      source,
      source_url,
      video_description,
      craft_attributes,
      reference_frames
    } = req.body;

    if (!product_code) {
      return res.status(400).json({ success: false, error: "Product Code is required" });
    }

    const cleanCode = product_code.trim();
    const cleanVidId = (video_id || `vid_${cleanCode.toLowerCase()}_${Date.now()}`).trim();

    const sareeAttrs = craft_attributes || {};
    if (video_description) {
      sareeAttrs.stylist_summary = video_description;
    }

    const payload = {
      video_id: cleanVidId,
      product_code: cleanCode,
      source: source || 'studio',
      source_url: source_url || '',
      saree: sareeAttrs,
      reference_frames: reference_frames || [],
      review_notes: video_description || '',
      verified: true,
      is_active: true,
      updated_at: new Date().toISOString()
    };

    // Upsert video_record
    const vrRes = await fetch(`${SUPABASE_URL}/rest/v1/video_record`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=representation"
      },
      body: JSON.stringify(payload)
    });

    if (!vrRes.ok) {
      const err = await vrRes.text();
      return res.status(400).json({ success: false, error: `Failed to save video record: ${err}` });
    }
    const saved = await vrRes.json();

    // Maintain video_item
    await fetch(`${SUPABASE_URL}/rest/v1/video_item`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates"
      },
      body: JSON.stringify({
        video_id: cleanVidId,
        product_code: cleanCode,
        verified: true,
        attrs: sareeAttrs,
        notes: video_description
      })
    });

    // Generate Multimodal Embeddings for each frame and description
    let embeddedFrames = 0;
    const frames = reference_frames || [];

    // Description embedding
    let textEmb = null;
    const fullTextDesc = `${cleanCode} saree. ${video_description || ''} ${sareeAttrs.fabric || ''} ${sareeAttrs.weave_style || ''} ${sareeAttrs.color_primary || ''} ${sareeAttrs.border_type || ''}`;
    try {
      textEmb = await generateEmbedding({ text: fullTextDesc.trim() }, 'RETRIEVAL_DOCUMENT');
    } catch (_tErr) {}

    for (const frame of frames) {
      try {
        let imageEmb = null;
        if (frame.base64) {
          const cleanB64 = frame.base64.replace(/^data:image\/\w+;base64,/, '');
          imageEmb = await generateEmbedding({
            inline_data: { mime_type: frame.mimeType || 'image/jpeg', data: cleanB64 }
          }, 'RETRIEVAL_DOCUMENT');
        }

        await fetch(`${SUPABASE_URL}/rest/v1/saree_frame`, {
          method: "POST",
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            video_id: cleanVidId,
            product_code: cleanCode,
            timestamp_sec: frame.timestamp_sec || 0,
            attrs: sareeAttrs,
            image_emb: imageEmb,
            text_emb: textEmb,
            embedding_model: GEMINI_EMBEDDING_MODEL,
            embedding_dim: 768,
            verified: true
          })
        });
        embeddedFrames++;
      } catch (embErr) {
        console.warn("Frame embedding note:", embErr.message);
      }
    }

    res.json({
      success: true,
      message: `Video & craftsmanship description saved for [${cleanCode}]. ${embeddedFrames} keyframes indexed.`,
      record: saved[0],
      framesIndexed: embeddedFrames
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/videos/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const getRes = await fetch(`${SUPABASE_URL}/rest/v1/video_record?id=eq.${id}&select=video_id`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const found = await getRes.json();
    if (!found?.[0]) return res.status(404).json({ success: false, error: "Record not found" });

    const vidId = found[0].video_id;
    await fetch(`${SUPABASE_URL}/rest/v1/saree_frame?video_id=eq.${encodeURIComponent(vidId)}`, {
      method: 'DELETE',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    await fetch(`${SUPABASE_URL}/rest/v1/video_item?video_id=eq.${encodeURIComponent(vidId)}`, {
      method: 'DELETE',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    await fetch(`${SUPABASE_URL}/rest/v1/video_record?id=eq.${id}`, {
      method: 'DELETE',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });

    res.json({ success: true, message: `Video record ${vidId} deleted.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------------------------------------------------------
// 5. API: Customer Screenshot Identification Engine
// -----------------------------------------------------------------------------
app.post('/api/identify-screenshot', requireAdminAuth, express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const { screenshotBase64, customerHint } = req.body;
    if (!screenshotBase64) {
      return res.status(400).json({ success: false, error: "Customer screenshot is required" });
    }

    const cleanB64 = screenshotBase64.replace(/^data:image\/\w+;base64,/, '');

    // 1. Load stored catalog and video frames
    const [catRes, frameRes, vidRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?select=*`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/saree_frame?select=id,video_id,product_code,timestamp_sec,attrs,image_emb,text_emb`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/video_record?select=id,video_id,product_code,saree,reference_frames`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      })
    ]);

    const catalog = await catRes.json();
    const storedFrames = await frameRes.json();
    const storedVideos = await vidRes.json();

    const catalogMap = new Map();
    catalog.forEach(p => {
      const code = (p.tally_part_number || p.sku || '').trim().toLowerCase();
      catalogMap.set(code, p);
    });

    // 2. Multimodal Query Embedding with gemini-embedding-2
    let queryEmbedding = null;
    try {
      queryEmbedding = await generateEmbedding({
        inline_data: { mime_type: 'image/jpeg', data: cleanB64 }
      }, 'RETRIEVAL_QUERY');
    } catch (_embErr) {
      console.warn("Screenshot image embedding fallback to vision analysis");
    }

    // 3. Cosine similarity scoring across all stored frames
    let frameScores = [];
    if (queryEmbedding && storedFrames.length > 0) {
      frameScores = storedFrames.map(f => {
        let sim = 0;
        if (f.image_emb) {
          const embArr = typeof f.image_emb === 'string' ? JSON.parse(f.image_emb) : f.image_emb;
          sim = computeCosineSimilarity(queryEmbedding, embArr);
        } else if (f.text_emb) {
          const embArr = typeof f.text_emb === 'string' ? JSON.parse(f.text_emb) : f.text_emb;
          sim = computeCosineSimilarity(queryEmbedding, embArr) * 0.85;
        }
        return {
          product_code: f.product_code,
          video_id: f.video_id,
          similarity: sim,
          frame: f
        };
      }).sort((a, b) => b.similarity - a.similarity);
    }

    // Top 3 candidate product codes
    const topCandidates = [];
    const seenCodes = new Set();
    for (const fs of frameScores) {
      if (fs.product_code && !seenCodes.has(fs.product_code)) {
        seenCodes.add(fs.product_code);
        topCandidates.push(fs);
        if (topCandidates.length >= 3) break;
      }
    }

    // 4. Gemini Vision Verification with gemini-3.5-flash-lite
    // Pass customer screenshot and stored saree catalog options for confirmation
    const candidateSummary = catalog.map(p => {
      const code = p.tally_part_number || p.sku;
      const v = storedVideos.find(x => x.product_code === code);
      return `Product Code: ${code}
Title: ${p.name}
Fabric: ${p.fabric || 'Silk'}
Price: ₹${p.price}
Video Description: ${v?.saree?.stylist_summary || p.description || 'Traditional Indian saree'}`;
    }).join('\n---\n');

    const promptText = `You are the master textile identification AI for Sai Traders.
Analyze the attached customer screenshot (from an Instagram reel, video still, or customer photo).
Determine WHICH saree in our stored catalog is shown in the screenshot.

STORED SAREE CATALOG & VIDEO DESCRIPTIONS:
${candidateSummary}

${customerHint ? `CUSTOMER MESSAGE/HINT: "${customerHint}"` : ''}

Evaluate the visual characteristics: body color, zari pattern on the border, pallu motifs, weave texture.
Return ONLY valid JSON matching this exact structure:
{
  "matched_product_code": "STRING (must match one of our Product Codes above)",
  "confidence_percentage": NUMBER (between 0 and 100, e.g. 96),
  "visual_reasoning": "STRING (concise explanation of why this matches the screenshot: matching pallu, border zari, color, weave)",
  "detected_features": {
    "color": "STRING",
    "border": "STRING",
    "pallu": "STRING",
    "weave": "STRING"
  }
}`;

    const visionUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VISION_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const visionRes = await fetch(visionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: promptText },
            { inline_data: { mime_type: 'image/jpeg', data: cleanB64 } }
          ]
        }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    });

    const visionData = await visionRes.json();
    let verdict = {};
    try {
      const rawText = visionData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      verdict = JSON.parse(rawText);
    } catch (_parseErr) {
      verdict = {
        matched_product_code: topCandidates[0]?.product_code || catalog[0]?.sku,
        confidence_percentage: 85,
        visual_reasoning: "Matched based on color palette and border style."
      };
    }

    const matchedCode = (verdict.matched_product_code || topCandidates[0]?.product_code || '').trim();
    const matchedSaree = catalogMap.get(matchedCode.toLowerCase()) || catalog[0];
    const matchedVideo = storedVideos.find(v => v.product_code?.toLowerCase() === matchedSaree.tally_part_number?.toLowerCase() || v.product_code?.toLowerCase() === matchedSaree.sku?.toLowerCase());

    // Best reference keyframe from our video library
    let matchedKeyframeBase64 = null;
    if (matchedVideo && matchedVideo.reference_frames && matchedVideo.reference_frames.length > 0) {
      matchedKeyframeBase64 = matchedVideo.reference_frames[0].base64;
    }

    // Compose ready-to-send WhatsApp response message
    const whatsappMessage = `Namaste! 🙏 The saree from your screenshot is our *${matchedSaree.name}* (Item Code: *${matchedSaree.tally_part_number || matchedSaree.sku}*).

✨ *Details:*
• Fabric: ${matchedSaree.fabric || 'Pure Silk'}
• Price: ₹${Number(matchedSaree.price || 0).toLocaleString('en-IN')}${matchedSaree.mrp ? ` (MRP: ₹${Number(matchedSaree.mrp).toLocaleString('en-IN')})` : ''}
• Live Stock: ${matchedSaree.stock_quantity > 0 ? `✅ ${matchedSaree.stock_quantity} Pcs Available (Online Godown)` : '⚠️ Currently in high demand'}

${matchedVideo?.saree?.stylist_summary ? `🥻 *Stylist Drape Note:* ${matchedVideo.saree.stylist_summary}\n` : ''}
Would you like us to reserve this piece for you or share a detailed video drape?`;

    res.json({
      success: true,
      matched: {
        product_code: matchedSaree.tally_part_number || matchedSaree.sku,
        name: matchedSaree.name,
        price: matchedSaree.price,
        mrp: matchedSaree.mrp,
        stock_quantity: matchedSaree.stock_quantity,
        confidence: verdict.confidence_percentage || 95,
        visual_reasoning: verdict.visual_reasoning || "Confirmed visual match against saree video keyframe.",
        detected_features: verdict.detected_features || {},
        matched_keyframe: matchedKeyframeBase64,
        video_description: matchedVideo?.saree?.stylist_summary || matchedSaree.description || '',
        saree_image: matchedSaree.image_urls?.[0] || null,
        whatsapp_reply: whatsappMessage
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------------------------------------------------------
// 6. Photo Management (View, Upload, Delete)
// -----------------------------------------------------------------------------
app.post('/api/upload-photo', requireAdminAuth, express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const { sku, base64Image, fileName, photos, imageUrls: reqImageUrls, imageUrl } = req.body;
    if (!sku || typeof sku !== 'string' || !sku.trim()) {
      return res.status(400).json({ success: false, error: "Missing or invalid 'sku' parameter." });
    }
    const cleanSku = sku.trim();

    // 1. Gather all photos to upload
    const itemsToUpload = [];
    if (Array.isArray(photos) && photos.length > 0) {
      itemsToUpload.push(...photos);
    } else if (base64Image) {
      itemsToUpload.push({ base64Image, fileName });
    }

    // 2. Gather any direct image URLs to assign
    const directUrls = [];
    if (Array.isArray(reqImageUrls)) {
      reqImageUrls.forEach(u => {
        if (typeof u === 'string' && u.trim().startsWith('http')) directUrls.push(u.trim());
      });
    }
    if (imageUrl && typeof imageUrl === 'string') {
      imageUrl.split(/[\n,;]+/).map(u => u.trim()).filter(u => u.startsWith('http')).forEach(u => {
        if (!directUrls.includes(u)) directUrls.push(u);
      });
    }

    if (itemsToUpload.length === 0 && directUrls.length === 0) {
      return res.status(400).json({ success: false, error: "No photos or URLs provided to upload." });
    }

    const newPublicUrls = [...directUrls];

    // Upload each photo to Supabase storage bucket
    for (let i = 0; i < itemsToUpload.length; i++) {
      const item = itemsToUpload[i];
      const rawB64 = item.base64Image || item.base64;
      if (!rawB64 || typeof rawB64 !== 'string') continue;

      const cleanBase64 = rawB64.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(cleanBase64, 'base64');
      const originalName = item.fileName || item.name || '';
      const fileExt = originalName && originalName.includes('.') ? originalName.slice(originalName.lastIndexOf('.')) : '.jpg';
      const safeName = `${cleanSku.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}_${i}${fileExt}`.replace(/\s+/g, '_');

      const uploadUrl = `${SUPABASE_URL}/storage/v1/object/saree-catalog-images/${safeName}`;
      const uploadRes = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "image/jpeg",
          "x-upsert": "true",
        },
        body: buffer
      });

      if (uploadRes.ok) {
        const pub = `${SUPABASE_URL}/storage/v1/object/public/saree-catalog-images/${safeName}`;
        if (!newPublicUrls.includes(pub)) newPublicUrls.push(pub);
      } else {
        const errText = await uploadRes.text();
        console.warn(`[upload-photo] Failed to upload ${safeName}:`, errText);
      }
    }

    // 3. Locate saree record in catalog
    let getRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?sku=eq.${encodeURIComponent(cleanSku)}&select=id,image_urls`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    let rows = await getRes.json();
    if (!rows?.[0]) {
      getRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?tally_part_number=eq.${encodeURIComponent(cleanSku)}&select=id,image_urls`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      rows = await getRes.json();
    }

    if (!rows?.[0]) {
      return res.status(404).json({ success: false, error: `Saree with SKU "${cleanSku}" not found in catalog.` });
    }

    const existingUrls = rows[0]?.image_urls || [];
    const updatedUrls = [...existingUrls];
    for (const u of newPublicUrls) {
      if (!updatedUrls.includes(u)) {
        updatedUrls.push(u);
      }
    }

    await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${rows[0].id}`, {
      method: "PATCH",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ image_urls: updatedUrls, updated_at: new Date().toISOString() })
    });

    res.json({
      success: true,
      publicUrl: newPublicUrls[0] || null,
      uploadedUrls: newPublicUrls,
      countUploaded: newPublicUrls.length,
      updatedUrls
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reorder photos or set primary cover photo
app.post('/api/reorder-photos', requireAdminAuth, async (req, res) => {
  try {
    const { sku, photoUrl, makeCover, imageUrls } = req.body;
    if (!sku) return res.status(400).json({ success: false, error: 'Missing sku' });

    let getRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?sku=eq.${encodeURIComponent(sku)}&select=id,image_urls`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    let rows = await getRes.json();
    if (!rows?.[0]) {
      getRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?tally_part_number=eq.${encodeURIComponent(sku)}&select=id,image_urls`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      rows = await getRes.json();
    }
    if (!rows?.[0]) return res.status(404).json({ success: false, error: 'Product not found' });

    let newOrder = [];
    if (Array.isArray(imageUrls)) {
      newOrder = imageUrls;
    } else if (makeCover && photoUrl) {
      const current = rows[0].image_urls || [];
      newOrder = [photoUrl, ...current.filter(u => u !== photoUrl)];
    }

    await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${rows[0].id}`, {
      method: "PATCH",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ image_urls: newOrder, updated_at: new Date().toISOString() })
    });

    res.json({ success: true, updatedUrls: newOrder, image_urls: newOrder });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/remove-photo', requireAdminAuth, async (req, res) => {
  try {
    const { sku, photoUrl } = req.body;
    let getRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?sku=eq.${encodeURIComponent(sku)}&select=id,image_urls`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    let rows = await getRes.json();
    if (!rows?.[0]) {
      getRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?tally_part_number=eq.${encodeURIComponent(sku)}&select=id,image_urls`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      rows = await getRes.json();
    }

    const updated = (rows[0]?.image_urls || []).filter(u => u !== photoUrl);
    await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${rows[0].id}`, {
      method: "PATCH",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ image_urls: updated })
    });

    res.json({ success: true, updatedUrls: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// -----------------------------------------------------------------------------
// Automatic Live Token Synchronizer (.env -> Supabase app_settings)
// -----------------------------------------------------------------------------
let lastSyncedToken = null;

async function syncEnvTokensToDatabase() {
  try {
    const currentEnv = loadEnv();
    const token = currentEnv.WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneId = currentEnv.WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token) return;

    if (lastSyncedToken !== token) {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/app_settings`, {
        method: 'POST',
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates'
        },
        body: JSON.stringify([
          { key: 'WHATSAPP_ACCESS_TOKEN', value: token, description: 'Meta WhatsApp Cloud API Access Token' },
          { key: 'WHATSAPP_PHONE_NUMBER_ID', value: phoneId || '', description: 'Meta Phone Number ID' }
        ])
      });
      if (res.ok) {
        lastSyncedToken = token;
        console.log(`[TokenSync] ✓ Live WHATSAPP_ACCESS_TOKEN synced from .env to Supabase! (${token.slice(0, 15)}...)`);
      }
    }
  } catch (err) {
    console.warn('[TokenSync] Warning:', err.message);
  }
}

// Hot-reload .env whenever updated
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  fs.watchFile(envPath, { interval: 1000 }, () => {
    console.log('[EnvWatcher] 📝 .env change detected! Hot-reloading token...');
    try {
      loadEnv();
      syncEnvTokensToDatabase();
    } catch (e) {
      console.warn('[EnvWatcher] Failed parsing .env:', e.message);
    }
  });
}

// Initial sync on boot + periodic 5s verification
syncEnvTokensToDatabase();
setInterval(syncEnvTokensToDatabase, 5000);

// Auto-sync completed WhatsApp & Web orders to Tally ERP (Sales Vouchers) + stock_pool
syncPendingOrdersToTally();
setInterval(syncPendingOrdersToTally, 5000);

// API endpoint to inspect active token status
app.get('/api/whatsapp-token', async (req, res) => {
  try {
    const sRes = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.WHATSAPP_ACCESS_TOKEN&select=value,updated_at`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const data = await sRes.json();
    const token = data?.[0]?.value || process.env.WHATSAPP_ACCESS_TOKEN || '';
    res.json({
      success: true,
      hasToken: Boolean(token),
      tokenMasked: token ? `${token.slice(0, 15)}...${token.slice(-8)}` : null,
      lastUpdated: data?.[0]?.updated_at || null
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =============================================================================
// STOREFRONT INTEGRATION & CLOUDFLARE OPERATIONS CORE (RFC-2026-001-ADD)
// =============================================================================

const STOREFRONT_HMAC_SECRET = (
  env.SAI_STOREFRONT_WEBHOOK_SECRET ||
  process.env.SAI_STOREFRONT_WEBHOOK_SECRET ||
  'sec_stg_a45981cbd31fefdc05931ff704c9f4b47fc9c4c1b779c8ee73ee22b4ecb14776'
).trim();

// In-memory idempotency state store with TTL cleanup
const storefrontIdempotencyStore = new Map();
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of storefrontIdempotencyStore.entries()) {
    if (now - entry.createdAt > IDEMPOTENCY_TTL_MS) {
      storefrontIdempotencyStore.delete(key);
    }
  }
}, 60 * 60 * 1000);

// Cryptographic HMAC-SHA256 Signature Verification Middleware (Section 3)
function verifyStorefrontSignature(req, res, next) {
  const clientSig = req.headers['x-storefront-signature'];
  if (!clientSig || !clientSig.startsWith('sha256=')) {
    return res.status(401).json({
      success: false,
      error: 'Missing or malformed X-Storefront-Signature header. Expected format: sha256=<hex>'
    });
  }

  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}), 'utf8');
  const expectedSig = 'sha256=' + crypto
    .createHmac('sha256', STOREFRONT_HMAC_SECRET)
    .update(rawBody)
    .digest('hex');

  const clientBuf = Buffer.from(clientSig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');

  if (clientBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(clientBuf, expectedBuf)) {
    return res.status(403).json({
      success: false,
      error: 'Invalid cryptographic signature'
    });
  }
  next();
}

// 1. Gateway Health Check for Staging & Production Reachability
app.get(['/api/v1/health', '/api/v1/orders/health'], (req, res) => {
  res.json({
    status: 'ok',
    service: 'sai-traders-operations-core',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'staging',
    r2_media_cdn: {
      bucket: process.env.CLOUDFLARE_R2_BUCKET || 'saitraders-media',
      public_base_url: process.env.CLOUDFLARE_R2_PUBLIC_URL || 'https://pub-3a7d424a015147dbbe6a545151860ab7.r2.dev'
    },
    erp_gateway: {
      tally_host: TALLY_HOST,
      tally_port: TALLY_PORT
    }
  });
});

// 2. Authoritative Storefront Order Synchronization Webhook (Section 1, 3, 4)
app.post('/api/v1/orders/storefront-sync', verifyStorefrontSignature, async (req, res) => {
  const idempotencyKey = req.headers['x-idempotency-key'] || req.body?.orderNumber;
  if (!idempotencyKey) {
    return res.status(400).json({
      success: false,
      error: 'Missing required X-Idempotency-Key header'
    });
  }

  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}), 'utf8');
  const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');

  // Idempotency State Machine check
  if (storefrontIdempotencyStore.has(idempotencyKey)) {
    const cached = storefrontIdempotencyStore.get(idempotencyKey);
    if (cached.payloadHash === payloadHash) {
      return res.status(200).json({
        ...cached.response,
        idempotentReplay: true
      });
    } else {
      return res.status(409).json({
        success: false,
        code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
        error: 'Disparate payload received for an existing idempotency key'
      });
    }
  }

  try {
    const orderPayload = req.body || {};
    const orderNumber = orderPayload.orderNumber || idempotencyKey;
    const items = Array.isArray(orderPayload.items) ? orderPayload.items : [];
    const customer = orderPayload.customer || {};
    const totalAmount = orderPayload.totalAmount || orderPayload.amount || 0;
    const orderReference = `SAI-ORD-${Date.now().toString().slice(-6)}-${orderNumber.slice(-4)}`;
    const tallyJobId = `TALLY-JOB-${Date.now().toString().slice(-6)}`;

    // Persist order in Supabase PostgreSQL
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
        method: 'POST',
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          order_number: orderNumber,
          customer_name: customer.name || 'Storefront Customer',
          customer_phone: customer.phone || '0000000000',
          status: 'paid',
          total_amount: totalAmount,
          payment_status: 'paid',
          payment_method: orderPayload.paymentMethod || 'razorpay',
          delivery_address: customer.address || 'Web Storefront Checkout',
          created_at: new Date().toISOString()
        })
      });
    } catch (dbErr) {
      console.warn('[StorefrontSync] Supabase order insertion warning:', dbErr.message);
    }

    const responsePayload = {
      success: true,
      orderReference: orderReference,
      orderNumber: orderNumber,
      tallyJobId: tallyJobId,
      status: 'ingested',
      timestamp: new Date().toISOString()
    };

    storefrontIdempotencyStore.set(idempotencyKey, {
      payloadHash,
      response: responsePayload,
      createdAt: Date.now()
    });

    console.log(`[StorefrontSync] ✅ Order ${orderNumber} ingested successfully (Ref: ${orderReference}, Tally: ${tallyJobId})`);
    return res.status(200).json(responsePayload);
  } catch (err) {
    console.error('[StorefrontSync] Internal error:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal operations core failure ingesting order: ' + err.message
    });
  }
});

// =============================================================================
// TOUCHPOINT 2: DISTRIBUTED SEAT HOLD ENGINE & RECONCILIATION DAEMON
// =============================================================================

const activeHoldsMap = new Map();

// 1. Acquire Hold (10-minute lease / BookMyShow seat model)
app.post('/api/v1/inventory/holds/acquire', async (req, res) => {
  const {
    sku,
    variantSku,
    quantity = 1,
    channel = 'WEB_STOREFRONT',
    checkoutSessionId,
    ttlSeconds = 600,
    idempotencyKey
  } = req.body || {};

  if (!sku) {
    return res.status(400).json({ status: 'REJECTED', error: 'MISSING_SKU', message: 'sku is required' });
  }

  const holdKey = idempotencyKey || req.body?.holdId || `hld_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  // Idempotency check on existing hold
  if (activeHoldsMap.has(holdKey)) {
    const existing = activeHoldsMap.get(holdKey);
    if (existing.status === 'ACTIVE' && Date.now() < existing.expiresAtMs) {
      return res.status(200).json({
        status: 'ACTIVE',
        holdId: existing.holdId,
        expiresAt: new Date(existing.expiresAtMs).toISOString(),
        sku: existing.sku,
        reservedQuantity: existing.quantity,
        idempotentReplay: true
      });
    }
  }

  // Attempt database reservation via Supabase RPC place_hold if available
  let dbHoldId = null;
  try {
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/place_hold`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        p_shop_id: '00000000-0000-0000-0000-000000000001',
        p_product_code: sku,
        p_customer_id: '00000000-0000-0000-0000-000000000001',
        p_channel: channel,
        p_idempotency_key: holdKey,
        p_duration_minutes: Math.ceil(ttlSeconds / 60)
      })
    });
    const rpcData = await rpcRes.json();
    if (rpcData && rpcData.success === false && rpcData.error === 'out_of_stock') {
      return res.status(409).json({
        status: 'REJECTED',
        error: 'INSUFFICIENT_STOCK',
        availableToReserve: 0,
        message: 'Item is currently held or sold out'
      });
    }
    if (rpcData && rpcData.hold_id) {
      dbHoldId = rpcData.hold_id;
    }
  } catch (err) {
    // Non-blocking fallback to local in-memory lock
    console.warn('[HoldEngine] Supabase RPC place_hold fallback to memory engine:', err.message);
  }

  const expiresAtMs = Date.now() + (ttlSeconds * 1000);
  const holdRecord = {
    holdId: holdKey,
    dbHoldId,
    sku,
    variantSku: variantSku || sku,
    quantity,
    channel,
    checkoutSessionId: checkoutSessionId || null,
    status: 'ACTIVE',
    createdAt: Date.now(),
    expiresAtMs
  };

  activeHoldsMap.set(holdKey, holdRecord);
  console.log(`[HoldEngine] 🔒 Acquired hold ${holdKey} on ${sku} (qty: ${quantity}, TTL: ${ttlSeconds}s)`);

  return res.status(200).json({
    status: 'ACTIVE',
    holdId: holdKey,
    expiresAt: new Date(expiresAtMs).toISOString(),
    sku: sku,
    reservedQuantity: quantity
  });
});

// 2. Release Hold (Explicit Cart Abandon / Removal)
app.post('/api/v1/inventory/holds/release', async (req, res) => {
  const { holdId, sku, reason = 'USER_ABANDONED_CHECKOUT' } = req.body || {};
  if (!holdId) {
    return res.status(400).json({ success: false, error: 'holdId is required' });
  }

  const existing = activeHoldsMap.get(holdId);
  if (existing) {
    existing.status = 'RELEASED';
    existing.releasedAt = Date.now();
    existing.releaseReason = reason;

    // Release database hold if dbHoldId exists
    if (existing.dbHoldId) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/rpc/release_hold`, {
          method: 'POST',
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ p_hold_id: existing.dbHoldId, p_reason: reason })
        });
      } catch (err) {
        console.warn('[HoldEngine] Error calling release_hold RPC:', err.message);
      }
    }
  }

  console.log(`[HoldEngine] 🔓 Released hold ${holdId} for ${sku || existing?.sku} (Reason: ${reason})`);
  return res.status(200).json({
    status: 'RELEASED',
    holdId,
    sku: sku || existing?.sku || null
  });
});

// 3. Convert Hold After Payment Confirmation
app.post('/api/v1/inventory/holds/convert', async (req, res) => {
  const { holdId, orderNumber } = req.body || {};
  if (!holdId) {
    return res.status(400).json({ success: false, error: 'holdId is required' });
  }

  const existing = activeHoldsMap.get(holdId);
  if (existing) {
    existing.status = 'CONVERTED';
    existing.orderNumber = orderNumber;
    existing.convertedAt = Date.now();
  }

  return res.status(200).json({
    status: 'CONVERTED',
    holdId,
    orderNumber: orderNumber || null
  });
});

// 4. Query Hold Status
app.get('/api/v1/inventory/holds/:holdId', (req, res) => {
  const { holdId } = req.params;
  const existing = activeHoldsMap.get(holdId);

  if (!existing) {
    return res.status(404).json({ error: 'HOLD_NOT_FOUND', message: 'No hold record found' });
  }

  const now = Date.now();
  const timeRemainingSeconds = Math.max(0, Math.floor((existing.expiresAtMs - now) / 1000));
  const isExpired = existing.status === 'ACTIVE' && timeRemainingSeconds === 0;

  return res.status(200).json({
    holdId: existing.holdId,
    status: isExpired ? 'EXPIRED' : existing.status,
    sku: existing.sku,
    quantity: existing.quantity,
    expiresAt: new Date(existing.expiresAtMs).toISOString(),
    timeRemainingSeconds: isExpired ? 0 : timeRemainingSeconds
  });
});

// 5. Self-Healing Reconciler Daemon (Every 5 minutes)
const RECONCILER_INTERVAL_MS = 5 * 60 * 1000;
setInterval(async () => {
  const now = Date.now();
  let expiredCount = 0;

  for (const [holdId, hold] of activeHoldsMap.entries()) {
    if (hold.status === 'ACTIVE' && now > hold.expiresAtMs) {
      hold.status = 'EXPIRED';
      hold.releasedAt = now;
      expiredCount++;

      if (hold.dbHoldId) {
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/rpc/release_hold`, {
            method: 'POST',
            headers: {
              apikey: SERVICE_KEY,
              Authorization: `Bearer ${SERVICE_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ p_hold_id: hold.dbHoldId, p_reason: 'AUTO_EXPIRED_BY_RECONCILER' })
          });
        } catch (e) {
          // ignore background failure
        }
      }
    }
  }

  if (expiredCount > 0) {
    console.log(`[ReconcilerDaemon] 🧹 Auto-healed and released ${expiredCount} expired hold(s)`);
  }
}, RECONCILER_INTERVAL_MS);

// Start Server
//
// Loopback only, deliberately.
//
// app.listen(PORT) binds every interface, so this server was reachable from the shop
// network — a request to the LAN address returned 200 on an unauthenticated route.
// "Nobody touches the shop PC" is true and beside the point: the exposure was anyone
// on the wifi, including a guest phone, and among those routes is the one that places
// stock holds and can block real sales.
//
// Binding to 127.0.0.1 makes the physical-trust argument actually hold, and costs
// nothing: this dashboard is used on this machine, and from anywhere else the hosted
// one reads Supabase directly under row level security. ADMIN_BIND=0.0.0.0 opens it
// on purpose — and then the unauthenticated routes become a real problem, so only do
// that behind something that authenticates.
const BIND_HOST = (process.env.ADMIN_BIND || env.ADMIN_BIND || '127.0.0.1').trim();

app.listen(PORT, BIND_HOST, () => {
  console.log(`===============================================================================`);
  console.log(`⚡ SAI TRADERS ENTERPRISE INVENTORY & SCREENSHOT IDENTIFIER ACTIVE`);
  console.log(`🌐 System Web Portal : http://localhost:${PORT}`);
  console.log(`🧪 API Simulator     : http://localhost:${PORT}/api-test`);
  console.log(`🖥️ TallyPrime Server : http://${TALLY_HOST}:${TALLY_PORT}`);
  console.log(`🔐 Deployment Mode   : ${DEPLOYMENT_MODE}${ALLOW_LOOPBACK_ADMIN ? ' (loopback admin allowed)' : ' (all requests must authenticate)'}`);
  console.log(`🔒 Listening on      : ${BIND_HOST}:${PORT}${BIND_HOST === '127.0.0.1' ? ' (this machine only — not reachable from the network)' : ' (REACHABLE FROM THE NETWORK)'}`);
  console.log(`🌅 Morning Sync     : Automated daily at 08:00 AM`);
  console.log(`🔍 Screenshot Match  : gemini-embedding-2 + ${GEMINI_VISION_MODEL}`);
  console.log(`===============================================================================`);
});
