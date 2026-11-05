/**
 * Sai Traders — Store PC Preflight & Discovery
 *
 * Run this ONCE on a store PC. It discovers everything the install needs instead of
 * anyone hand-editing config and copying files until the data looks right.
 *
 * Needs no .env and no credentials — it only talks to TallyPrime on this machine.
 * Prints a readable checklist and writes store_preflight_report.json next to itself.
 *
 *   node scripts/store_preflight.js
 *
 * Targets Windows 10 + TallyPrime (Silver is single-user, which suits one store PC).
 */

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

const TALLY_HOST = process.env.TALLY_HOST || '127.0.0.1';
const TALLY_PORT = parseInt(process.env.TALLY_PORT || '9000', 10);
const TIMEOUT_MS = 8000;

const report = { generatedAt: new Date().toISOString(), checks: [], discovered: {}, blockers: [], warnings: [] };

// ---------------------------------------------------------------------------
// output helpers
// ---------------------------------------------------------------------------
const C = { ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[90m', off: '\x1b[0m', b: '\x1b[1m' };
function line(ch = '-') { console.log(ch.repeat(74)); }
function head(t) { console.log(''); line('='); console.log(`${C.b}${t}${C.off}`); line('='); }
function check(name, state, detail) {
  const icon = state === 'pass' ? `${C.ok}[ OK ]${C.off}`
    : state === 'fail' ? `${C.bad}[FAIL]${C.off}`
    : `${C.warn}[WARN]${C.off}`;
  console.log(`${icon} ${name.padEnd(38)} ${detail || ''}`);
  report.checks.push({ name, state, detail: detail || '' });
  if (state === 'fail') report.blockers.push(`${name}: ${detail || ''}`);
  if (state === 'warn') report.warnings.push(`${name}: ${detail || ''}`);
}
function fix(msg) { console.log(`       ${C.dim}→ ${msg}${C.off}`); }

// ---------------------------------------------------------------------------
// Tally XML transport. Deliberately raw http — no dependency to install first.
// ---------------------------------------------------------------------------
function tally(xml, timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: TALLY_HOST, port: TALLY_PORT, path: '/', method: 'POST',
      headers: { 'Content-Type': 'text/xml;charset=utf-8', 'Content-Length': Buffer.byteLength(xml) },
      timeout
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timed out')); });
    req.write(xml);
    req.end();
  });
}

const collection = (id, type, fetchFields) => `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${id}</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="${id}"><TYPE>${type}</TYPE><FETCH>${fetchFields}</FETCH></COLLECTION></TDLMESSAGE></TDL>
</DESC></BODY></ENVELOPE>`;

const tag = (body, name) => {
  const m = body.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`, 'i'));
  return m ? m[1].trim() : '';
};

// ---------------------------------------------------------------------------
// 1. This machine
// ---------------------------------------------------------------------------
function discoverMachine() {
  head('1. THIS MACHINE');

  const rel = os.release();
  // Windows 10 and 11 both report 10.x; build >= 22000 means 11.
  const build = parseInt((rel.split('.')[2] || '0'), 10);
  const winName = rel.startsWith('10.') ? (build >= 22000 ? 'Windows 11' : 'Windows 10') : `Windows (${rel})`;
  check('Operating system', os.platform() === 'win32' ? 'pass' : 'fail', `${winName} ${os.arch()}`);
  if (os.platform() !== 'win32') fix('The store agent targets Windows. Tally runs on Windows only.');

  const major = parseInt(process.versions.node.split('.')[0], 10);
  check('Node.js runtime', major >= 18 ? 'pass' : 'fail', `v${process.versions.node}`);
  if (major < 18) fix('Install Node.js 18 LTS or newer from https://nodejs.org');

  // Skip link-local 169.254.* — APIPA addresses are assigned when DHCP fails and are
  // unreachable from the rest of the network.
  const addrs = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const d of list || []) {
      if (d.family === 'IPv4' && !d.internal && !/^169\.254\./.test(d.address)) addrs.push(d.address);
    }
  }
  const isPrivate = ip => /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  const lan = addrs.find(isPrivate) || addrs[0] || null;
  check('LAN address', lan ? 'pass' : 'warn', lan || 'none found (DHCP may have failed)');

  const freeGb = (os.freemem() / 1024 ** 3).toFixed(1);
  check('Memory free', os.freemem() > 512 * 1024 * 1024 ? 'pass' : 'warn', `${freeGb} GB`);

  report.discovered.machine = { hostname: os.hostname(), os: winName, arch: os.arch(), node: process.versions.node, lanAddress: lan, allAddresses: addrs };
  console.log(`\n  hostname: ${C.b}${os.hostname()}${C.off}`);
}

// ---------------------------------------------------------------------------
// 2. Tally installation on disk
// ---------------------------------------------------------------------------
function discoverTallyFiles() {
  head('2. TALLY ON DISK');

  const roots = ['C:\\Users\\Public\\TallyPrime', 'C:\\Program Files\\TallyPrime', 'C:\\Program Files (x86)\\TallyPrime', 'C:\\Tally.ERP9', 'C:\\TallyPrime'];
  const found = roots.filter(r => { try { return fs.existsSync(r); } catch (_) { return false; } });
  check('Installation found', found.length ? 'pass' : 'warn', found[0] || 'not in the usual locations');
  if (!found.length) fix('Not fatal — only the XML connection below actually matters.');

  // Company data folders are numbered directories under data/.
  const companies = [];
  for (const r of found) {
    const dataDir = path.join(r, 'data');
    try {
      for (const d of fs.readdirSync(dataDir)) {
        const full = path.join(dataDir, d);
        if (!fs.statSync(full).isDirectory()) continue;
        let bytes = 0, files = 0, newest = 0;
        for (const f of fs.readdirSync(full)) {
          try {
            const st = fs.statSync(path.join(full, f));
            bytes += st.size; files++;
            if (st.mtimeMs > newest) newest = st.mtimeMs;
          } catch (_) {}
        }
        companies.push({ number: d, path: full, files, sizeMb: +(bytes / 1024 ** 2).toFixed(1), lastModified: newest ? new Date(newest).toISOString() : null });
      }
    } catch (_) {}
  }
  if (companies.length) {
    check('Company data folders', 'pass', `${companies.length} found`);
    companies.forEach(c => console.log(`       ${C.dim}#${c.number}  ${c.sizeMb} MB, ${c.files} files, modified ${(c.lastModified || '').slice(0, 10)}${C.off}`));
  } else {
    check('Company data folders', 'warn', 'none readable');
  }
  report.discovered.tallyFiles = { roots: found, companies };
}

// ---------------------------------------------------------------------------
// 3. The XML connection — the only thing that genuinely has to work
// ---------------------------------------------------------------------------
async function discoverTallyConnection() {
  head('3. TALLY XML SERVER');

  const started = Date.now();
  let raw;
  try {
    raw = await tally(`<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>Cmp</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="Cmp"><TYPE>Company</TYPE><FETCH>Name,CompanyNumber,Guid,StartingFrom</FETCH></COLLECTION></TDLMESSAGE></TDL>
</DESC></BODY></ENVELOPE>`);
  } catch (err) {
    check('Reachable', 'fail', `${TALLY_HOST}:${TALLY_PORT} — ${err.message}`);
    fix('Open TallyPrime, then F1 → Settings → Connectivity → Client/Server:');
    fix('  TallyPrime acts as: Both    ·    Port: 9000');
    fix('Restart Tally if prompted, load the company, and run this again.');
    report.discovered.tally = { reachable: false, error: err.message };
    return false;
  }

  check('Reachable', 'pass', `${TALLY_HOST}:${TALLY_PORT} in ${Date.now() - started} ms`);

  const blocks = [...raw.matchAll(/<COMPANY\b[^>]*>([\s\S]*?)<\/COMPANY>/gi)];
  const companies = blocks.map(b => ({
    name: (b[0].match(/NAME="([^"]+)"/i) || [, tag(b[1], 'NAME')])[1] || tag(b[1], 'NAME'),
    guid: tag(b[1], 'GUID'),
    number: tag(b[1], 'COMPANYNUMBER'),
    booksFrom: tag(b[1], 'STARTINGFROM'),
  })).filter(c => c.name);

  if (!companies.length) {
    check('Company loaded', 'fail', 'XML answered but no company is open');
    fix('Load the company in TallyPrime, then run this again.');
    report.discovered.tally = { reachable: true, companies: [] };
    return false;
  }

  check('Company loaded', 'pass', `${companies.length} open`);
  companies.forEach(c => {
    console.log(`       ${C.b}${c.name}${C.off}`);
    console.log(`       ${C.dim}guid ${c.guid || '(none)'}  ·  company #${c.number || '?'}  ·  books from ${c.booksFrom || '?'}${C.off}`);
  });
  // The GUID is what binds this shop to its own books — a mismatch must stop a sync.
  check('Company GUID present', companies[0].guid ? 'pass' : 'warn', companies[0].guid || 'absent — identity binding will not work');

  report.discovered.tally = { reachable: true, host: TALLY_HOST, port: TALLY_PORT, companies };
  return true;
}

// ---------------------------------------------------------------------------
// 4. Godowns
// ---------------------------------------------------------------------------
async function discoverGodowns() {
  head('4. GODOWNS');
  let raw;
  try {
    raw = await tally(collection('AllGodowns', 'Godown', 'Name,Parent,ClosingBalance'));
  } catch (err) {
    check('Godown list', 'fail', err.message);
    return;
  }

  const godowns = [];
  for (const b of raw.matchAll(/<GODOWN\b[^>]*>([\s\S]*?)<\/GODOWN>/gi)) {
    const name = (b[0].match(/NAME="([^"]+)"/i) || [, ''])[1];
    if (!name) continue;
    // Tally prefixes the root parent with a control character; treat it as root.
    const parent = tag(b[1], 'PARENT').replace(/[^\x20-\x7E]/g, '').trim();
    godowns.push({
      name,
      parent: /^primary$/i.test(parent) || !parent ? null : parent,
      closing: tag(b[1], 'CLOSINGBALANCE') || null,
    });
  }

  check('Godowns found', godowns.length ? 'pass' : 'fail', `${godowns.length}`);
  godowns.forEach(g => console.log(`       ${g.name.padEnd(22)} ${C.dim}${(g.closing || '-').padEnd(12)} parent: ${g.parent || 'Primary'}${C.off}`));
  if (!godowns.length) fix('Enable F11 → Inventory → Maintain Godowns/Locations, and create one for online stock.');

  report.discovered.godowns = godowns;
}

// ---------------------------------------------------------------------------
// 5. Stock items — and whether per-godown figures are actually exportable
// ---------------------------------------------------------------------------
async function discoverStock() {
  head('5. STOCK ITEMS & GODOWN ATTRIBUTION');
  let raw;
  try {
    raw = await tally(collection('SI', 'StockItem', 'Name,Parent,ClosingBalance,BatchAllocations.*'), 20000);
  } catch (err) {
    check('Stock item list', 'fail', err.message);
    return;
  }

  const items = [];
  for (const b of raw.matchAll(/<STOCKITEM NAME="([^"]+)"[^>]*>([\s\S]*?)<\/STOCKITEM>/gi)) {
    const name = b[1];
    const body = b[2];
    const closingRaw = tag(body, 'CLOSINGBALANCE');
    const qty = parseFloat((closingRaw.match(/-?[0-9.]+/) || [0])[0]) || 0;
    const godowns = {};
    for (const batch of body.matchAll(/<BATCHALLOCATIONS\.LIST[^>]*>([\s\S]*?)<\/BATCHALLOCATIONS\.LIST>/gi)) {
      const g = tag(batch[1], 'GODOWNNAME');
      if (!g) continue;
      const q = parseFloat(((tag(batch[1], 'OPENINGBALANCE') || tag(batch[1], 'CLOSINGBALANCE')).match(/-?[0-9.]+/) || [0])[0]) || 0;
      godowns[g] = (godowns[g] || 0) + q;
    }
    items.push({ name, group: tag(body, 'PARENT'), closing: qty, closingRaw: closingRaw || null, godowns });
  }

  check('Stock items found', items.length ? 'pass' : 'warn', `${items.length}`);

  const withStock = items.filter(i => i.closing > 0);
  const attributed = items.filter(i => Object.keys(i.godowns).length > 0);
  const unattributed = withStock.filter(i => Object.keys(i.godowns).length === 0);
  const negative = items.filter(i => i.closing < 0 || /-/.test(i.closingRaw || ''));

  check('Items holding stock', 'pass', `${withStock.length} of ${items.length}`);

  // This is the setting that decides whether per-godown stock works at all.
  const batchOn = attributed.length > 0;
  check('Per-godown figures exportable', batchOn ? (unattributed.length ? 'warn' : 'pass') : 'fail',
    `${attributed.length} of ${withStock.length} items attributed`);
  if (!batchOn) {
    fix('Tally is exporting no godown breakdown for any item.');
    fix('Enable F11 → Inventory Features → Maintain Batch-wise details: Yes');
    fix('This is NOT retroactive — each existing item also needs a godown set on its');
    fix('opening balance (Gateway → Alter → Stock Item).');
  } else if (unattributed.length) {
    fix(`${unattributed.length} item(s) hold stock with no godown allocation, so they`);
    fix('cannot be placed in a godown and will read as zero online:');
    unattributed.slice(0, 12).forEach(i => fix(`  ${i.name}  (${i.closingRaw})`));
    fix('Set a godown on each one\'s opening balance in Tally.');
  }

  if (negative.length) {
    check('Negative balances', 'warn', `${negative.length} item(s)`);
    negative.slice(0, 8).forEach(i => fix(`  ${i.name}  ${i.closingRaw}`));
    fix('Negative stock usually means a sale was recorded without a matching purchase.');
  }

  // Per-godown totals, which is what the online catalogue is scoped against.
  const byGodown = {};
  items.forEach(i => Object.entries(i.godowns).forEach(([g, q]) => { byGodown[g] = (byGodown[g] || 0) + q; }));
  if (Object.keys(byGodown).length) {
    console.log('');
    Object.entries(byGodown).forEach(([g, q]) => console.log(`       ${g.padEnd(22)} ${C.dim}${q}${C.off}`));
  }

  report.discovered.stock = {
    totalItems: items.length,
    itemsWithStock: withStock.length,
    itemsAttributed: attributed.length,
    batchWiseDetailsEnabled: batchOn,
    unattributedItems: unattributed.map(i => ({ name: i.name, closing: i.closingRaw })),
    negativeItems: negative.map(i => ({ name: i.name, closing: i.closingRaw })),
    perGodownTotals: byGodown,
    items,
  };
}

// ---------------------------------------------------------------------------
// verdict
// ---------------------------------------------------------------------------
function verdict() {
  head('VERDICT');
  const failed = report.checks.filter(c => c.state === 'fail').length;
  const warned = report.checks.filter(c => c.state === 'warn').length;

  if (!failed && !warned) {
    console.log(`${C.ok}READY${C.off} — this PC can be paired and will sync correctly.`);
  } else if (!failed) {
    console.log(`${C.warn}READY WITH WARNINGS${C.off} — it will pair and sync, but some stock will not be sellable online.`);
  } else {
    console.log(`${C.bad}NOT READY${C.off} — ${failed} blocker(s) must be cleared first.`);
  }

  if (report.blockers.length) { console.log(`\n${C.b}Blockers${C.off}`); report.blockers.forEach(b => console.log(`  ${C.bad}·${C.off} ${b}`)); }
  if (report.warnings.length) { console.log(`\n${C.b}Warnings${C.off}`); report.warnings.forEach(w => console.log(`  ${C.warn}·${C.off} ${w}`)); }

  report.verdict = failed ? 'not_ready' : (warned ? 'ready_with_warnings' : 'ready');

  const out = path.resolve(__dirname, '..', 'store_preflight_report.json');
  try {
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`\n${C.dim}Full report written to:${C.off}\n  ${out}`);
    console.log(`${C.dim}Send that file instead of describing the problem — it contains everything.${C.off}`);
  } catch (err) {
    console.log(`\n${C.warn}Could not write the report file: ${err.message}${C.off}`);
  }
  line('=');
  return failed ? 1 : 0;
}

(async () => {
  console.log('');
  line('=');
  console.log(`${C.b}  SAI TRADERS — STORE PC PREFLIGHT${C.off}`);
  console.log(`${C.dim}  Discovers this machine's Tally setup. Changes nothing. Needs no credentials.${C.off}`);
  line('=');

  discoverMachine();
  discoverTallyFiles();
  const connected = await discoverTallyConnection();
  if (connected) {
    await discoverGodowns();
    await discoverStock();
  } else {
    head('4-5. GODOWNS & STOCK');
    console.log(`${C.dim}  Skipped — Tally must be reachable first.${C.off}`);
  }
  process.exitCode = verdict();
})().catch(err => {
  console.error(`\n${C.bad}Preflight crashed:${C.off} ${err.stack || err.message}`);
  process.exitCode = 2;
});
