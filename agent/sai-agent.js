#!/usr/bin/env node
/**
 * Sai Agent — the only software a store PC runs.
 *
 * It polls the cloud, talks to TallyPrime on localhost, and reports back. Nothing ever
 * connects inward to this machine: no open port, no tunnel, no firewall rule, no fixed
 * IP. That is not a workaround — it is why those things are no longer needed at all.
 *
 * It holds exactly one secret: a device token issued when the shop owner approves the
 * code shown on screen. The Supabase service-role key never comes near this machine.
 * The token is encrypted with Windows DPAPI, bound to this Windows account, so copying
 * the file to another machine yields nothing usable. Revoking the device in the
 * dashboard stops it on its very next call.
 *
 *   node sai-agent.js            run it
 *   node sai-agent.js --reset    forget this machine's identity and enroll again
 *
 * Zero dependencies. Native Node only, so there is nothing to install and nothing to
 * go stale.
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Configuration. Only the public anon key lives here — it is designed to sit in
// clients and is constrained by row level security.
// ---------------------------------------------------------------------------
const SUPABASE_URL = process.env.SAI_SUPABASE_URL || 'https://aisttddxrbizoshtpdxi.supabase.co';
const ANON_KEY = process.env.SAI_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFpc3R0ZGR4cmJpem9zaHRwZHhpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA1NzE1ODEsImV4cCI6MjEwNjE0NzU4MX0.zVPplpD-h_ObVxNoqcj8I_ixBGBtB0OtcJ0AHxekzZg';
const FN = `${SUPABASE_URL}/functions/v1/agent-sync`;

const TALLY_HOST = process.env.TALLY_HOST || '127.0.0.1';
const TALLY_PORT = parseInt(process.env.TALLY_PORT || '9000', 10);

const POLL_MS = 5000;        // how often to ask for work
const HEARTBEAT_MS = 30000;  // how often to report liveness
const STOCK_SYNC_MS = 120000; // how often to push a fresh stock reading unprompted
const TALLY_SPACING_MS = 250; // Tally's XML engine is single threaded — never crowd it
const UPDATE_CHECK_MS = 3600000; // how often a long-running agent looks for a fix

const STATE_DIR = path.join(process.env.PROGRAMDATA || os.homedir(), 'SaiAgent');
const TOKEN_FILE = path.join(STATE_DIR, 'device.enc');
const OUTBOX_FILE = path.join(STATE_DIR, 'outbox.json');

// A short fingerprint of this file, reported on every heartbeat so the running
// version is visible from the cloud instead of having to be read off the machine.
const AGENT_VERSION = (() => {
  try {
    const src = fs.readFileSync(__filename);
    return require('crypto').createHash('sha256').update(src).digest('hex').slice(0, 10);
  } catch (_) {
    return 'unknown';
  }
})();

// ---------------------------------------------------------------------------
// Console output. Plain and sparse: a shopkeeper should be able to tell at a glance
// whether this is healthy.
// ---------------------------------------------------------------------------
const stamp = () => new Date().toTimeString().slice(0, 8);
const log = (m) => console.log(`${stamp()}  ${m}`);
const warn = (m) => console.log(`${stamp()}  ! ${m}`);
const banner = (lines) => {
  const w = Math.max(...lines.map((l) => l.length)) + 4;
  console.log('');
  console.log('='.repeat(w));
  lines.forEach((l) => console.log('  ' + l));
  console.log('='.repeat(w));
  console.log('');
};

// ---------------------------------------------------------------------------
// Token at rest.
//
// DPAPI through PowerShell, which ships with Windows — so this stays dependency free
// while still being tied to this user on this machine. Elsewhere the token is stored
// plainly, which is only for development; the real deployment target is Windows.
// ---------------------------------------------------------------------------
const isWindows = process.platform === 'win32';

function protect(plain) {
  if (!isWindows) return 'plain:' + Buffer.from(plain).toString('base64');
  const ps = `$s = ConvertTo-SecureString -String '${plain}' -AsPlainText -Force; ConvertFrom-SecureString -SecureString $s`;
  return 'dpapi:' + execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' }).trim();
}

function unprotect(stored) {
  if (stored.startsWith('plain:')) return Buffer.from(stored.slice(6), 'base64').toString('utf8');
  const enc = stored.slice(6);
  const ps = `$sec = ConvertTo-SecureString -String '${enc}';` +
    `[Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))`;
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' }).trim();
}

function saveToken(token) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, protect(token), { mode: 0o600 });
}

function loadToken() {
  try {
    return unprotect(fs.readFileSync(TOKEN_FILE, 'utf8').trim());
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cloud transport
// ---------------------------------------------------------------------------
function callCloud(action, body, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(`${FN}/${action}`);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
      },
      timeout: timeoutMs,
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(d) });
        } catch (_) {
          reject(new Error(`bad response (${res.statusCode}): ${d.slice(0, 120)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('cloud timed out')); });
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tally transport, serialised.
//
// One request at a time with a minimum gap. Tally's XML engine is single threaded and
// will freeze or answer "Server Busy" if two requests overlap.
// ---------------------------------------------------------------------------
let lastTallyCall = 0;
let tallyChain = Promise.resolve();

function tallyRaw(xml, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: TALLY_HOST, port: TALLY_PORT, path: '/', method: 'POST',
      headers: { 'Content-Type': 'text/xml;charset=utf-8', 'Content-Length': Buffer.byteLength(xml) },
      timeout: timeoutMs,
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Tally timed out')); });
    req.write(xml);
    req.end();
  });
}

function tally(xml, timeoutMs) {
  // The queue has to survive a failure. Written as .then(onOk, onFail) the rejection
  // handler ran INSTEAD of the new work, so one unreachable Tally call left every
  // later call returning undefined until the agent was restarted — a single hiccup
  // disabled Tally access for the whole session.
  //
  // Settle the previous link first, then always run the new work. The caller still
  // sees real errors; only the chain is insulated.
  const next = tallyChain.catch(() => {}).then(async () => {
    const gap = Date.now() - lastTallyCall;
    if (gap < TALLY_SPACING_MS) await new Promise((r) => setTimeout(r, TALLY_SPACING_MS - gap));
    try {
      return await tallyRaw(xml, timeoutMs);
    } finally {
      lastTallyCall = Date.now();
    }
  });
  tallyChain = next.catch(() => {});
  return next;
}

// Must not match <NAME.LIST>, the wrapper Tally nests inside COMPANY and STOCKITEM.
const tag = (body, name) => {
  const m = body.match(new RegExp('<' + name + '(?:[ \t][^>]*)?>([^<]*)</' + name + '>', 'i'));
  return m ? m[1].trim() : '';
};

const collection = (id, type, fetchFields) => `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${id}</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="${id}"><TYPE>${type}</TYPE><FETCH>${fetchFields}</FETCH></COLLECTION></TDLMESSAGE></TDL>
</DESC></BODY></ENVELOPE>`;

/** Which company is open, and its GUID — the cloud decides whether that is the right one. */
async function readCompany() {
  const raw = await tally(collection('CompanyCollection', 'Company', 'Name,GUID,CompanyNumber'));
  if (typeof raw !== 'string' || !raw) return null;

  // Tally prefixes its reply with a CMPINFO counter block that contains a literal
  // <COMPANY>0</COMPANY>. Taking the FIRST <COMPANY> match therefore picked up the
  // counter, found no name or GUID inside it, and reported the company as not open
  // even though it was. Scan every block and keep the first real one.
  for (const block of raw.matchAll(/<COMPANY\b[^>]*>([\s\S]*?)<\/COMPANY>/gi)) {
    const attr = (block[0].match(/NAME="([^"]+)"/i) || [, ''])[1];
    const name = (attr || tag(block[1], 'NAME')).trim();
    const guid = tag(block[1], 'GUID');
    if (!name && !guid) continue; // the counter block, not a company
    return { name, guid, number: tag(block[1], 'COMPANYNUMBER') };
  }
  return null;
}

/**
 * Stock, with whatever godown attribution Tally will give.
 *
 * Batch rows carry OPENINGBALANCE and never a closing figure, so they establish WHERE
 * an item is, while the item's own CLOSINGBALANCE establishes HOW MUCH. Reading the
 * batch quantity as current stock is what previously made a reported 11 out of a real 9.
 */
async function readGodownBalances(godownName) {
  const raw = await tally(collection('SI', 'StockItem', 'Name,Parent,ClosingBalance,BatchAllocations.*'), 25000);
  if (typeof raw !== 'string' || !raw) throw new Error('Tally returned no response');
  const items = [];
  for (const m of raw.matchAll(/<STOCKITEM NAME="([^"]+)"[^>]*>([\s\S]*?)<\/STOCKITEM>/gi)) {
    const name = m[1];
    const body = m[2];
    const closingRaw = tag(body, 'CLOSINGBALANCE');
    const num = closingRaw.match(/-?[0-9.]+/);
    const closing = num ? parseFloat(num[0]) : 0;

    const holders = {};
    for (const b of body.matchAll(/<BATCHALLOCATIONS\.LIST[^>]*>([\s\S]*?)<\/BATCHALLOCATIONS\.LIST>/gi)) {
      const g = tag(b[1], 'GODOWNNAME');
      if (!g) continue;
      const q = (tag(b[1], 'OPENINGBALANCE') || tag(b[1], 'CLOSINGBALANCE')).match(/-?[0-9.]+/);
      holders[g] = (holders[g] || 0) + (q ? parseFloat(q[0]) : 0);
    }

    // Place the item's true closing balance in the godown(s) that hold it. A single
    // holder is exact; several are apportioned, because Tally exports no per-godown
    // closing figure to be exact with.
    const names = Object.keys(holders);
    const perGodown = {};
    if (names.length === 1) {
      perGodown[names[0]] = closing;
    } else if (names.length > 1) {
      const weight = names.reduce((s, g) => s + Math.max(0, holders[g]), 0);
      let given = 0;
      names.forEach((g, i) => {
        const q = i === names.length - 1
          ? Math.round(closing) - given
          : (weight > 0 ? Math.round(closing * Math.max(0, holders[g]) / weight) : Math.round(closing / names.length));
        given += q;
        perGodown[g] = q;
      });
    }

    const placed = Object.values(perGodown).reduce((s, v) => s + v, 0);
    items.push({
      name,
      group: tag(body, 'PARENT'),
      closing,
      closingRaw: closingRaw || null,
      godowns: perGodown,
      unallocated: Math.max(0, Math.round(closing - placed)),
      inRequestedGodown: godownName
        ? (Object.entries(perGodown).find(([g]) => g.toLowerCase() === String(godownName).toLowerCase()) || [, 0])[1]
        : null,
    });
  }
  return { godown: godownName || null, itemCount: items.length, items };
}


const escapeXml = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const importEnvelope = (inner) => `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${inner}</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;

/** Tally answers imports with counters; anything but a clean create/alter is a failure. */
function importOutcome(raw) {
  const num = (t) => {
    const m = raw.match(new RegExp('<' + t + '>([^<]*)</' + t + '>', 'i'));
    return m ? parseInt(m[1].trim(), 10) || 0 : 0;
  };
  const errors = num('ERRORS') + num('EXCEPTIONS');
  const lineError = (raw.match(/<LINEERROR>([^<]*)<\/LINEERROR>/i) || [, ''])[1].trim();
  return {
    created: num('CREATED'),
    altered: num('ALTERED'),
    errors,
    message: lineError || null,
    ok: errors === 0 && !lineError && (num('CREATED') > 0 || num('ALTERED') > 0),
  };
}

/** Every godown in the company, with its parent and closing total. */
async function readGodowns() {
  const raw = await tally(collection('AllGodowns', 'Godown', 'Name,Parent,ClosingBalance'));
  const godowns = [];
  for (const b of raw.matchAll(/<GODOWN\b[^>]*>([\s\S]*?)<\/GODOWN>/gi)) {
    const name = (b[0].match(/NAME="([^"]+)"/i) || [, ''])[1];
    if (!name) continue;
    // Tally prefixes the root parent with a control character, exported as &#4;
    const parent = tag(b[1], 'PARENT')
      .replace(/&#\d+;/g, '').replace(/&#x[0-9a-f]+;/gi, '').replace(/[^\x20-\x7E]/g, '').trim();
    godowns.push({
      name,
      parent: /^primary$/i.test(parent) || !parent ? null : parent,
      closing: tag(b[1], 'CLOSINGBALANCE') || null,
    });
  }
  return { count: godowns.length, godowns };
}

/** Create a godown if it is missing. Main Location always exists, so never touch it. */
/** True when the group is the notional root, which Tally will not accept by name. */
function isRootGroup(group) {
  const g = String(group || '').trim().toLowerCase();
  return !g || g === 'primary';
}

/** Create a stock group if it is missing. The root is never created. */
async function ensureStockGroup(name) {
  if (isRootGroup(name)) return { root: true };
  const clean = String(name).trim();
  const xml = importEnvelope(
    `<STOCKGROUP NAME="${escapeXml(clean)}" ACTION="Create"><NAME>${escapeXml(clean)}</NAME><PARENT/></STOCKGROUP>`
  );
  const out = importOutcome(await tally(xml));
  return { group: clean, created: out.created > 0 };
}

async function ensureGodown(name) {
  const clean = String(name || '').trim();
  if (!clean || clean.toLowerCase() === 'main location') return { skipped: true };
  const xml = importEnvelope(
    `<GODOWN NAME="${escapeXml(clean)}" ACTION="Create"><NAME>${escapeXml(clean)}</NAME><PARENT/></GODOWN>`
  );
  const out = importOutcome(await tally(xml));
  // Already existing is success, not failure.
  return { godown: clean, created: out.created > 0, note: out.message };
}

/**
 * Create a stock item, or set an existing one's quantity.
 *
 * The stock GROUP and the GODOWN are different things in Tally and are passed
 * separately. Defaults are the names every company has, so a fresh company needs no
 * preparation: Primary as the group, Main Location as the godown.
 */
async function createStockItem(p) {
  const name = String(p.name || p.sku || '').trim();
  if (!name) throw new Error('an item name is required');
  const group = String(p.group || '').trim();
  const godown = String(p.godown || 'Main Location').trim();
  const unit = String(p.unit || 'Pcs').trim();
  const qty = Math.max(0, Number(p.quantity) || 0);
  const rate = Number(p.rate) || 0;
  const value = (qty * rate).toFixed(2);

  await ensureGodown(godown);
  await ensureStockGroup(group);

  const batch = qty > 0 ? `
  <BATCHALLOCATIONS.LIST>
    <GODOWNNAME>${escapeXml(godown)}</GODOWNNAME>
    <BATCHNAME>Primary Batch</BATCHNAME>
    <OPENINGBALANCE>${qty} ${escapeXml(unit)}</OPENINGBALANCE>
    <OPENINGRATE>${rate.toFixed(2)}/${escapeXml(unit)}</OPENINGRATE>
    <OPENINGVALUE>-${value}</OPENINGVALUE>
  </BATCHALLOCATIONS.LIST>` : '';

  const body = (action) => importEnvelope(`<STOCKITEM NAME="${escapeXml(name)}" ACTION="${action}">
  <NAME>${escapeXml(name)}</NAME>
  ${isRootGroup(group) ? '<PARENT/>' : `<PARENT>${escapeXml(group)}</PARENT>`}
  <BASEUNITS>${escapeXml(unit)}</BASEUNITS>
  <OPENINGBALANCE>${qty} ${escapeXml(unit)}</OPENINGBALANCE>
  <OPENINGRATE>${rate.toFixed(2)}/${escapeXml(unit)}</OPENINGRATE>
  <OPENINGVALUE>-${value}</OPENINGVALUE>${batch}
</STOCKITEM>`);

  let out = importOutcome(await tally(body('Create')));
  if (!out.ok) out = importOutcome(await tally(body('Alter'))); // already present
  if (!out.ok) throw new Error(out.message || 'Tally rejected the item');
  return { item: name, group, godown, quantity: qty, created: out.created > 0, altered: out.altered > 0 };
}

/**
 * Set an item's stock to an exact figure.
 *
 * The delta is computed against Tally's CURRENT closing balance, read immediately
 * before the write. Computing it anywhere else — or earlier — is what previously turned
 * "set to 40" into 46: the baseline was a cached number that had drifted, and Tally
 * applied the difference to its own, different, reality.
 */
async function adjustStock(p) {
  const name = String(p.name || p.sku || '').trim();
  if (!name) throw new Error('an item name is required');
  const target = Number(p.targetQuantity);
  if (!Number.isFinite(target) || target < 0) throw new Error('a target quantity is required');
  const godown = String(p.godown || 'Main Location').trim();
  const unit = String(p.unit || 'Pcs').trim();
  const rate = Number(p.rate) || 0;

  const reading = await readGodownBalances(godown);
  const item = reading.items.find((i) => i.name.toLowerCase() === name.toLowerCase());

  // Unknown to Tally: creating it at the target quantity IS the adjustment, and no
  // voucher must follow or the quantity doubles.
  if (!item) {
    const made = await createStockItem({ name, godown, unit, rate, quantity: target, group: p.group });
    return { ...made, baseline: 0, delta: target, via: 'created' };
  }

  const gKey = Object.keys(item.godowns).find((g) => g.toLowerCase() === godown.toLowerCase());
  const baseline = gKey !== undefined ? Number(item.godowns[gKey]) || 0 : Number(item.closing) || 0;
  const delta = Math.round(target - baseline);

  if (delta === 0) return { item: name, baseline, delta: 0, via: 'already correct' };

  const ref = (delta > 0 ? 'RN-' : 'VCH-') + Date.now().toString().slice(-8);
  const qty = Math.abs(delta);
  const amount = (qty * rate).toFixed(2);

  // Receipt note to bring stock in, sales voucher to take it out. Both are ordinary
  // Tally vouchers, so the movement is auditable rather than an invisible edit.
  const voucherType = delta > 0 ? 'Receipt Note' : 'Sales';
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC><REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER VCHTYPE="${voucherType}" ACTION="Create">
  <DATE>${new Date().toISOString().slice(0, 10).replace(/-/g, '')}</DATE>
  <VOUCHERTYPENAME>${voucherType}</VOUCHERTYPENAME>
  <VOUCHERNUMBER>${escapeXml(ref)}</VOUCHERNUMBER>
  <REFERENCE>${escapeXml(ref)}</REFERENCE>
  <NARRATION>Stock adjustment to ${target} ${escapeXml(unit)} by Sai Agent</NARRATION>
  <PARTYLEDGERNAME>${delta > 0 ? 'Sundry Creditors' : 'Cash'}</PARTYLEDGERNAME>
  <ALLINVENTORYENTRIES.LIST>
    <STOCKITEMNAME>${escapeXml(name)}</STOCKITEMNAME>
    <ISDEEMEDPOSITIVE>${delta > 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
    <RATE>${rate.toFixed(2)}/${escapeXml(unit)}</RATE>
    <AMOUNT>${delta > 0 ? '-' : ''}${amount}</AMOUNT>
    <ACTUALQTY>${qty} ${escapeXml(unit)}</ACTUALQTY>
    <BILLEDQTY>${qty} ${escapeXml(unit)}</BILLEDQTY>
    <BATCHALLOCATIONS.LIST>
      <GODOWNNAME>${escapeXml(godown)}</GODOWNNAME>
      <BATCHNAME>Primary Batch</BATCHNAME>
      <AMOUNT>${delta > 0 ? '-' : ''}${amount}</AMOUNT>
      <ACTUALQTY>${qty} ${escapeXml(unit)}</ACTUALQTY>
      <BILLEDQTY>${qty} ${escapeXml(unit)}</BILLEDQTY>
    </BATCHALLOCATIONS.LIST>
  </ALLINVENTORYENTRIES.LIST>
</VOUCHER>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;

  const out = importOutcome(await tally(xml));
  if (!out.ok) throw new Error(out.message || 'Tally rejected the adjustment voucher');
  return { item: name, godown, baseline, target, delta, voucher: ref, via: voucherType };
}

// ---------------------------------------------------------------------------
// Outbox. Results are kept on disk until the cloud confirms them, so a dropped
// connection mid-report does not lose work. Replaying is safe because report is
// idempotent on the job id.
// ---------------------------------------------------------------------------
function readOutbox() {
  try { return JSON.parse(fs.readFileSync(OUTBOX_FILE, 'utf8')); } catch (_) { return []; }
}
function writeOutbox(items) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(OUTBOX_FILE, JSON.stringify(items));
}
function queueResult(entry) {
  const all = readOutbox();
  all.push({ ...entry, queuedAt: new Date().toISOString() });
  writeOutbox(all);
}

async function drainOutbox(token) {
  let pending = readOutbox();
  if (!pending.length) return;
  log(`sending ${pending.length} queued result(s)`);
  const remaining = [];
  for (const entry of pending) {
    try {
      const res = await callCloud('report', { deviceToken: token, ...entry });
      if (res.status !== 200) throw new Error(JSON.stringify(res.body));
    } catch (err) {
      remaining.push(entry);
      warn(`could not send result for job ${entry.jobId}: ${err.message}`);
    }
  }
  writeOutbox(remaining);
  if (!remaining.length) log('all queued results sent');
}

// ---------------------------------------------------------------------------
// Self-update.
//
// A fix to this file would otherwise mean visiting every shop PC. On start the agent
// compares itself against the published copy and, if it differs, writes the new one
// and relaunches. Nobody downloads anything by hand again.
//
// Guards, because this replaces the running program:
//   - only ever applied at startup, never mid-job
//   - the download must parse as JavaScript and look like this agent before it is
//     trusted, so a truncated or wrong response cannot brick the install
//   - the previous version is kept, so a bad update can be rolled back on the spot
//   - any failure is ignored and the current version simply carries on
// ---------------------------------------------------------------------------
const UPDATE_URL = process.env.SAI_UPDATE_URL ||
  'https://raw.githubusercontent.com/vasgenerativesolutions-collab/sai-traders-admin/main/agent/sai-agent.js';

function fetchText(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timed out')); });
  });
}

async function selfUpdate() {
  if (process.env.SAI_NO_UPDATE === '1' || process.argv.includes('--no-update')) return false;
  const me = __filename;

  let latest;
  try {
    latest = await fetchText(UPDATE_URL);
  } catch (_) {
    return false; // offline or unreachable — carry on with what we have
  }

  const current = fs.readFileSync(me, 'utf8');
  if (latest === current) return false;

  // Refuse anything that is not plausibly this program. A proxy error page or a
  // truncated download would otherwise replace a working agent with rubbish.
  if (latest.length < 8000 || !latest.includes('SAI AGENT') || !latest.includes('async function main()')) {
    warn('ignored an update that did not look like the agent');
    return false;
  }
  try {
    new (require('vm').Script)(latest, { filename: 'update-check' });
  } catch (err) {
    warn('ignored an update that failed to parse: ' + err.message);
    return false;
  }

  try {
    fs.writeFileSync(me + '.prev', current);
    fs.writeFileSync(me, latest);
  } catch (err) {
    warn('could not write the update: ' + err.message);
    return false;
  }

  log('updated to the latest version — restarting');
  const { spawn } = require('child_process');
  spawn(process.execPath, [me, ...process.argv.slice(2)], { stdio: 'inherit', detached: false })
    .on('exit', (code) => process.exit(code === null ? 0 : code));
  return true;
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------
async function enrollInteractive() {
  const res = await callCloud('enroll', { deviceName: os.hostname() });
  if (res.status !== 200 || !res.body.code) {
    throw new Error(`enrolment failed: ${JSON.stringify(res.body)}`);
  }
  const code = res.body.code;

  banner([
    'THIS PC IS NOT YET CONNECTED',
    '',
    `   Your code:   ${code}`,
    '',
    'Open the Sai Traders admin in a browser, sign in, and',
    'enter this code to connect this PC.',
    '',
    'Leave this window open. It will continue on its own.',
  ]);

  // Poll until approved. Deliberately patient — someone has to walk to a computer.
  for (let i = 0; i < 180; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    let s;
    try {
      s = await callCloud('enroll-status', { code });
    } catch (err) {
      warn(`cannot reach the cloud: ${err.message}`);
      continue;
    }
    const status = s.body.status;
    if (status === 'active' && s.body.deviceToken) {
      saveToken(s.body.deviceToken);
      banner([`CONNECTED as "${s.body.deviceName || os.hostname()}"`, 'This PC will not ask again.']);
      return s.body.deviceToken;
    }
    if (status === 'expired') throw new Error('the code expired — start the agent again for a new one');
    if (status === 'revoked') throw new Error('this device was revoked in the dashboard');
    if (i % 6 === 0) log(`waiting for approval of code ${code} ...`);
  }
  throw new Error('nobody approved the code within 15 minutes');
}

// ---------------------------------------------------------------------------
// Job execution
// ---------------------------------------------------------------------------
async function runJob(job) {
  switch (job.type) {
    case 'read_godown_balances':
      return await readGodownBalances(job.payload && job.payload.godown_name);
    case 'preflight': {
      const company = await readCompany();
      const godowns = await readGodowns();
      return { company, godowns: godowns.godowns, tallyReachable: Boolean(company) };
    }
    case 'read_godowns':
      return await readGodowns();
    case 'create_godown':
      return await ensureGodown(job.payload && job.payload.godown);
    case 'create_stock_item':
      return await createStockItem(job.payload || {});
    case 'adjust_stock':
      return await adjustStock(job.payload || {});
    default:
      throw new Error(`this agent does not handle "${job.type}" yet`);
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
async function heartbeat(token) {
  let company = null;
  let reachable = false;
  try {
    company = await readCompany();
    reachable = Boolean(company);
  } catch (_) { /* reported as unreachable below */ }

  const res = await callCloud('heartbeat', {
    deviceToken: token,
    agentVersion: AGENT_VERSION,
    tally: {
      reachable,
      guid: company ? company.guid : null,
      company: company ? company.name : null,
      godownExists: true,
    },
  });
  return { res, company, reachable };
}

async function main() {
  const reset = process.argv.includes('--reset');
  if (reset) {
    try { fs.unlinkSync(TOKEN_FILE); log('identity cleared'); } catch (_) {}
  }

  banner(['SAI AGENT  ' + AGENT_VERSION, `${os.hostname()}  ·  Tally at ${TALLY_HOST}:${TALLY_PORT}`]);

  // Before doing any work, make sure this is the current version.
  if (await selfUpdate()) return;

  let token = loadToken();
  if (!token) {
    token = await enrollInteractive();
  } else {
    log('already connected to this shop');
  }

  // First heartbeat tells us whether the cloud will accept this company at all.
  try {
    const { res, company, reachable } = await heartbeat(token);
    if (res.status === 401) {
      warn('this device is no longer authorised — clearing its identity');
      try { fs.unlinkSync(TOKEN_FILE); } catch (_) {}
      warn('run the agent again to connect this PC afresh');
      process.exit(1);
    }
    if (!reachable) {
      warn(`TallyPrime is not answering on ${TALLY_HOST}:${TALLY_PORT}`);
      warn('open Tally, load the company, and check F1 > Settings > Connectivity (acts as: Both, port 9000)');
    } else {
      log(`Tally: ${company.name}`);
      if (res.body.identityOk === false) {
        warn(`the cloud rejected this company: ${res.body.identityNote}`);
        warn('this shop is registered against a different Tally company');
      }
    }
  } catch (err) {
    warn(`startup heartbeat failed: ${err.message}`);
  }

  log('running — waiting for work');

  let lastBeat = Date.now();
  let lastUpdateCheck = Date.now();
  let lastStockSync = 0;
  let idleLogged = false;

  for (;;) {
    try {
      if (Date.now() - lastBeat > HEARTBEAT_MS) {
        lastBeat = Date.now();
        await heartbeat(token).catch((e) => warn(`heartbeat: ${e.message}`));
      }

      // Checking only at startup meant an agent left running for days never picked up a
      // published fix, and the symptom was a Tally error from code already corrected.
      // Looking again here puts every shop at most an hour behind, with no visit needed.
      if (Date.now() - lastUpdateCheck > UPDATE_CHECK_MS) {
        lastUpdateCheck = Date.now();
        if (await selfUpdate()) return;
      }

      await drainOutbox(token);

      // Routine stock refresh is the agent's own job. Nothing has to enqueue it, so
      // stock cannot go stale because a scheduler was never set up or stopped running.
      if (Date.now() - lastStockSync > STOCK_SYNC_MS) {
        lastStockSync = Date.now();
        try {
          const reading = await readGodownBalances(null);
          const res = await callCloud('sync', { deviceToken: token, result: reading });
          const eff = res.body && res.body.effect;
          log(`stock synced — ${reading.itemCount} item(s)` +
              (eff ? `, ${eff.applied} updated` + (eff.unallocatedItems ? `, ${eff.unallocatedItems} need a godown` : '') : ''));
        } catch (err) {
          warn(`stock sync: ${err.message}`);
        }
      }

      const claimed = await callCloud('claim', { deviceToken: token });
      if (claimed.status === 401) {
        // Either this PC was unpaired, or a newer PC was approved for this shop and
        // took over. Forget the identity so the same machine can simply be re-paired,
        // and stop rather than compete with the new one.
        try { fs.unlinkSync(TOKEN_FILE); } catch (_) {}
        banner([
          'THIS PC IS NO LONGER CONNECTED',
          '',
          'It was unpaired, or another PC was connected for this shop.',
          'Run the agent again to connect this PC afresh.',
        ]);
        process.exit(0);
      }

      const job = claimed.body && claimed.body.job;
      if (!job) {
        if (!idleLogged) { log('no work pending'); idleLogged = true; }
        await new Promise((r) => setTimeout(r, POLL_MS));
        continue;
      }
      idleLogged = false;

      log(`job ${job.type} (${job.id.slice(0, 8)}) starting`);
      let entry;
      try {
        const result = await runJob(job);
        entry = { jobId: job.id, result };
        log(`job ${job.type} done — ${result.itemCount !== undefined ? result.itemCount + ' item(s)' : 'ok'}`);
      } catch (err) {
        entry = { jobId: job.id, error: err.message };
        warn(`job ${job.type} failed: ${err.message}`);
      }

      // Queue first, then send. If the connection drops between the two, the result
      // survives a restart and is replayed.
      queueResult(entry);
      await drainOutbox(token);
    } catch (err) {
      warn(err.message);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}

process.on('SIGINT', () => { console.log(''); log('stopped'); process.exit(0); });

main().catch((err) => {
  console.error('');
  console.error(`Agent could not start: ${err.message}`);
  console.error('');
  process.exit(1);
});
