/**
 * Integrity test for the store distribution kits.
 * Run: node scripts/test_install_kit.js
 *
 * Answers one question: if this kit were copied to a clean Windows machine and
 * START_STORE_PC.bat were double-clicked, would it actually come up?
 *
 * It checks statically — no server is started, nothing is installed. The failure it
 * exists to catch is a variable the code now requires that .env.example does not
 * supply, because the launcher seeds .env from .env.example and a missing required
 * value makes the server exit on boot and the supervisor respawn it forever.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// Defaults to both shipped kits; pass folder names to check a staged copy instead,
// e.g. node scripts/test_install_kit.js test_install_kit
const KITS = process.argv.slice(2).filter(Boolean);
if (!KITS.length) KITS.push('store_install', 'install_kit');

let failures = 0;
let warnings = 0;
const C = { ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[90m', off: '\x1b[0m', b: '\x1b[1m' };

function ok(m) { console.log(`${C.ok}  pass${C.off}  ${m}`); }
function bad(m) { console.log(`${C.bad}  FAIL${C.off}  ${m}`); failures++; }
function warn(m) { console.log(`${C.warn}  warn${C.off}  ${m}`); warnings++; }
function section(t) { console.log(`\n${C.b}${t}${C.off}`); }

const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } };
const envKeys = text => new Set((text || '').split(/\r?\n/)
  .map(l => (l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=/) || [])[1]).filter(Boolean));

// ---------------------------------------------------------------------------
// Which variables does the code treat as mandatory?
//
// Derived from the source rather than a hand-kept list, so it cannot drift: any
// `if (!X) { ... process.exit` makes X required to boot.
// ---------------------------------------------------------------------------
function requiredVars(serverSrc) {
  const required = new Set();
  for (const m of serverSrc.matchAll(/if\s*\(!\s*([A-Z_][A-Z0-9_]*)\s*\)\s*\{[\s\S]{0,260}?process\.exit/g)) {
    required.add(m[1]);
  }
  return required;
}

// A kit value that is still the template placeholder is as good as absent.
const PLACEHOLDER = /^(your[-_ ]|eyJh\.\.\.|xxx|changeme|<.*>|sk_test|\.\.\.)/i;

section('1. Files every kit must contain');
const MUST_HAVE = [
  'admin/server.js', 'admin/public/index.html', 'admin/public/app-v2.js',
  'admin/public/style.css', 'admin/public/config.js',
  'agent/index.js', 'agent/poller.js', 'agent/tally_client.js', 'agent/tally_queue.js',
  'agent/outbox.js', 'agent/credentials.js',
  'scripts/store_supervisor.js', 'scripts/get_tunnel_url.js', 'scripts/store_preflight.js',
  'package.json', '.env.example',
  'START_STORE_PC.bat', 'STOP_STORE_PC.bat', 'CHECK_STORE_PC.bat',
];
for (const kit of KITS) {
  const missing = MUST_HAVE.filter(f => !fs.existsSync(path.join(ROOT, kit, f)));
  if (missing.length) bad(`${kit}: missing ${missing.length} file(s) — ${missing.join(', ')}`);
  else ok(`${kit}: all ${MUST_HAVE.length} required files present`);
}

section('2. Nothing destructive ships to the shop floor');
const FORBIDDEN = [
  'DELETE_ALL_CUSTOM_GODOWNS.bat', 'FIX_GODOWN_TO_PRIMARY.bat',
  'scripts/delete_all_custom_godowns.js', 'scripts/alter_godown_to_primary.js',
  'scripts/check_constraints.js',
];
for (const kit of KITS) {
  const present = FORBIDDEN.filter(f => fs.existsSync(path.join(ROOT, kit, f)));
  if (present.length) bad(`${kit}: destructive file(s) present — ${present.join(', ')}`);
  else ok(`${kit}: no destructive utilities`);
}

section('3. No secrets committed inside a kit');
for (const kit of KITS) {
  const dotenv = path.join(ROOT, kit, '.env');
  if (!fs.existsSync(dotenv)) { ok(`${kit}: no .env present (correct — seeded on install)`); continue; }
  // A local .env is fine for development, but it must never be tracked by git.
  warn(`${kit}: a .env exists locally — make sure it is gitignored and never shipped`);
}
for (const kit of KITS) {
  const sup = read(path.join(ROOT, kit, 'scripts/store_supervisor.js')) || '';
  if (/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\./.test(sup)) bad(`${kit}: a JWT is hardcoded in store_supervisor.js`);
  else ok(`${kit}: no hardcoded JWT in the supervisor`);
}

section('4. .env.example supplies every variable required to boot');
// This is the check that matters: the launcher seeds .env from .env.example, so a
// variable the server refuses to start without MUST appear there.
for (const kit of KITS) {
  const src = read(path.join(ROOT, kit, 'admin/server.js'));
  const example = read(path.join(ROOT, kit, '.env.example'));
  if (!src || !example) { bad(`${kit}: cannot read server.js or .env.example`); continue; }

  const required = requiredVars(src);
  const supplied = envKeys(example);
  const missing = [...required].filter(v => !supplied.has(v));

  if (!required.size) {
    // Nothing is fatal at boot any more — the admin PIN was the only such variable and
    // it was removed, since requiring it stopped a fresh install from starting at all.
    ok(`${kit}: no variable is fatal at boot, so a seeded .env cannot block startup`);
  } else if (missing.length) {
    bad(`${kit}: server exits without ${missing.join(', ')}, but .env.example does not define them`);
    console.log(`${C.dim}        A fresh install copies .env.example to .env, so the server would exit`);
    console.log(`${C.dim}        on boot and the supervisor would respawn it every 3 seconds.${C.off}`);
  } else {
    ok(`${kit}: all required vars present (${[...required].join(', ')})`);
  }
}

section('5. Values a fresh install still has to be given');
for (const kit of KITS) {
  const example = read(path.join(ROOT, kit, '.env.example')) || '';
  const placeholders = example.split(/\r?\n/)
    .map(l => l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/))
    .filter(m => m && PLACEHOLDER.test((m[2] || '').trim()))
    .map(m => m[1]);
  if (placeholders.length) {
    warn(`${kit}: ${placeholders.length} placeholder value(s) must be filled before the kit works: ${placeholders.join(', ')}`);
  } else {
    ok(`${kit}: no placeholder values left`);
  }
}

section('6. No machine-specific paths baked in');
for (const kit of KITS) {
  const hits = [];
  const walk = dir => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(js|bat)$/i.test(e.name)) {
        const t = read(full) || '';
        if (/[cC]:[\\/]{1,2}sai_traders/.test(t)) hits.push(path.relative(path.join(ROOT, kit), full));
      }
    }
  };
  walk(path.join(ROOT, kit));
  if (hits.length) bad(`${kit}: absolute path to this developer machine in ${hits.length} file(s) — ${hits.slice(0, 5).join(', ')}`);
  else ok(`${kit}: no absolute developer paths`);
}

section('7. Launcher references only files that exist');
for (const kit of KITS) {
  const bat = read(path.join(ROOT, kit, 'START_STORE_PC.bat')) || '';
  const refs = [...bat.matchAll(/node\s+([A-Za-z0-9_\\/.-]+\.js)/g)].map(m => m[1].replace(/\\/g, '/'));
  const missing = [...new Set(refs)].filter(r => !fs.existsSync(path.join(ROOT, kit, r)));
  if (missing.length) bad(`${kit}: START_STORE_PC.bat runs missing script(s) — ${missing.join(', ')}`);
  else ok(`${kit}: launcher references ${[...new Set(refs)].length} script(s), all present`);
}

section('8. Supervisor manages all three services');
for (const kit of KITS) {
  const sup = read(path.join(ROOT, kit, 'scripts/store_supervisor.js')) || '';
  const children = [
    ['admin/server.js', /spawn\('node',\s*\['admin\/server\.js'\]/],
    ['agent/index.js', /spawn\('node',\s*\['agent\/index\.js'\]/],
    ['cloudflared', /cloudflared/],
  ];
  const absent = children.filter(([, re]) => !re.test(sup)).map(([n]) => n);
  if (absent.length) bad(`${kit}: supervisor never starts ${absent.join(', ')}`);
  else ok(`${kit}: supervisor starts server, agent and tunnel`);
}

section('9. Dependencies available offline');
for (const kit of KITS) {
  const pkg = read(path.join(ROOT, kit, 'package.json'));
  if (!pkg) { bad(`${kit}: no package.json`); continue; }
  let deps = {};
  try { deps = JSON.parse(pkg).dependencies || {}; } catch (_) { bad(`${kit}: package.json is not valid JSON`); continue; }
  const names = Object.keys(deps);
  if (!names.length) { ok(`${kit}: no runtime dependencies`); continue; }
  const nm = path.join(ROOT, kit, 'node_modules');
  if (!fs.existsSync(nm)) {
    warn(`${kit}: ${names.length} dependencies and no node_modules — the install needs internet for npm install`);
  } else {
    const absent = names.filter(d => !fs.existsSync(path.join(nm, ...d.split('/'))));
    if (absent.length) bad(`${kit}: node_modules is missing ${absent.join(', ')}`);
    else ok(`${kit}: all ${names.length} dependencies vendored — installs offline`);
  }
}

section('10. Kit matches the source tree');
const PARITY = ['admin/server.js', 'admin/public/app-v2.js', 'admin/public/index.html',
  'scripts/store_supervisor.js', 'scripts/get_tunnel_url.js', 'scripts/store_preflight.js'];
const crypto = require('crypto');
const md5 = p => { const t = read(p); return t === null ? null : crypto.createHash('md5').update(t).digest('hex'); };
for (const kit of KITS) {
  const drift = PARITY.filter(f => {
    const a = md5(path.join(ROOT, f));
    const b = md5(path.join(ROOT, kit, f));
    return a === null || b === null || a !== b;
  });
  if (drift.length) bad(`${kit}: out of date vs source — ${drift.join(', ')} (run: npm run package:store)`);
  else ok(`${kit}: identical to source for all ${PARITY.length} tracked files`);
}

console.log('');
console.log('='.repeat(74));
if (failures) {
  console.log(`${C.bad}${failures} failure(s)${C.off}${warnings ? `, ${warnings} warning(s)` : ''} — this kit would NOT come up cleanly on a fresh machine.`);
} else if (warnings) {
  console.log(`${C.warn}${warnings} warning(s)${C.off} — the kit is structurally sound but needs values filled in.`);
} else {
  console.log(`${C.ok}All checks passed${C.off} — the kit should come up on a clean Windows machine.`);
}
console.log('='.repeat(74));
process.exitCode = failures ? 1 : 0;
