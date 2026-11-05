/**
 * One command that answers "is this working?".
 *
 *   node scripts/check_system.js
 *
 * Reads only. Reports what the cloud actually knows: which PC is connected, when it
 * last spoke, what Tally told it, how much stock is sellable, and what is stuck.
 *
 * Written so nobody has to query the database by hand to find out whether the shop is
 * running — which, for most of this system's life, was the only way to tell.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const C = { ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[90m', off: '\x1b[0m', b: '\x1b[1m' };

// Read .env without a dependency, matching the convention used across this project.
function env() {
  for (const f of [path.join(ROOT, '.env'), path.join(ROOT, 'store_install', '.env')]) {
    if (!fs.existsSync(f)) continue;
    return Object.fromEntries(
      fs.readFileSync(f, 'utf8').split(/\r?\n/)
        .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
        .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
    );
  }
  return {};
}

const E = env();
const URL_BASE = E.SUPABASE_URL;
const KEY = E.SUPABASE_SERVICE_ROLE_KEY;

if (!URL_BASE || !KEY) {
  console.error('\nCannot read SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from .env — run this from the project folder.\n');
  process.exit(2);
}

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const api = async (p) => {
  const res = await fetch(`${URL_BASE}/rest/v1/${p}`, { headers: H, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${p} -> HTTP ${res.status}`);
  return res.json();
};

const ago = (iso) => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
};
const parse = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch (_) { return v; } };

let problems = 0;
let notes = 0;
const good = (m) => console.log(`${C.ok}  OK  ${C.off} ${m}`);
const bad = (m, fix) => { console.log(`${C.bad} FAIL ${C.off} ${m}`); if (fix) console.log(`${C.dim}       ${fix}${C.off}`); problems++; };
const note = (m, fix) => { console.log(`${C.warn} NOTE ${C.off} ${m}`); if (fix) console.log(`${C.dim}       ${fix}${C.off}`); notes++; };
const section = (t) => { console.log(''); console.log(`${C.b}${t}${C.off}`); };

(async () => {
  console.log('');
  console.log('='.repeat(70));
  console.log(`${C.b}  SAI TRADERS — SYSTEM CHECK${C.off}`);
  console.log('='.repeat(70));

  // --- cloud ---------------------------------------------------------------
  section('Cloud');
  try {
    const res = await fetch(`${URL_BASE}/functions/v1/agent-sync/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: E.SUPABASE_ANON_KEY || KEY },
      body: JSON.stringify({ deviceToken: 'probe' }),
      signal: AbortSignal.timeout(15000),
    });
    // 401 is the correct answer to a bogus token — it proves the function is alive
    // and that it is checking credentials.
    if (res.status === 401) good('agent-sync is deployed and rejecting bad credentials');
    else note(`agent-sync answered HTTP ${res.status}`, 'expected 401 for an invalid token');
  } catch (err) {
    bad(`agent-sync unreachable: ${err.message}`, 'check this machine has internet');
  }

  // --- shop ----------------------------------------------------------------
  section('Shop configuration');
  let onlineGodown = null;
  try {
    const shops = await api('shops?select=id,code,settings&limit=1');
    const s = shops[0];
    if (!s) { bad('no shop row exists'); }
    else {
      onlineGodown = (s.settings && s.settings.online_godown) || null;
      if (onlineGodown) good(`online stock comes from godown "${onlineGodown}"`);
      else bad('no online godown is set', 'set shops.settings.online_godown, or nothing will be sellable');
      const guid = s.settings && s.settings.tally_guid;
      if (guid) good(`bound to Tally company ${guid.slice(0, 8)}…`);
      else note('no Tally company registered yet', 'the first agent heartbeat will register one');
    }
  } catch (err) {
    bad(`cannot read the shop: ${err.message}`);
  }

  // --- the store PC --------------------------------------------------------
  section('Store PC');
  let activeDevice = null;
  try {
    const devices = await api('agent_devices?select=device_name,status,last_seen_at,tally_reachable,company_loaded,revoked_at,version&order=last_seen_at.desc');

    // What the repository is publishing, so a PC running something older is named
    // rather than diagnosed from its symptoms.
    let published = null;
    try {
      const res = await fetch('https://raw.githubusercontent.com/vasgenerativesolutions-collab/sai-traders-admin/main/agent/sai-agent.js', { signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const src = Buffer.from(await res.arrayBuffer());
        published = require('crypto').createHash('sha256').update(src).digest('hex').slice(0, 10);
      }
    } catch (_) { /* offline — version comparison is skipped, not fatal */ }
    const active = devices.filter((d) => d.status === 'active' && !d.revoked_at);
    const pending = devices.filter((d) => d.status === 'pending');

    if (!active.length) {
      bad('no PC is connected', 'run the installer on the store PC, then enter its code under Pair PC');
    } else if (active.length > 1) {
      note(`${active.length} PCs are connected`, 'only one should be — approving a new PC retires the others');
    }

    for (const d of active) {
      activeDevice = d;
      const seenSec = d.last_seen_at ? (Date.now() - new Date(d.last_seen_at)) / 1000 : Infinity;
      if (seenSec < 180) good(`"${d.device_name}" is running — last spoke ${ago(d.last_seen_at)}`);
      else if (seenSec < 3600) note(`"${d.device_name}" last spoke ${ago(d.last_seen_at)}`, 'it may have been closed; a healthy agent speaks every 30 seconds');
      else bad(`"${d.device_name}" last spoke ${ago(d.last_seen_at)}`, 'the agent is not running on that PC — start it');

      if (d.tally_reachable) good('  TallyPrime is answering on that PC');
      else bad('  TallyPrime is not answering on that PC', 'open Tally, load the company, F1 > Settings > Connectivity (acts as: Both, port 9000)');

      if (!d.company_loaded) note('  no Tally company is open', 'load the company in Tally');

      // A stale agent explains otherwise baffling failures, so say it outright.
      const running = d.version && /^[0-9a-f]{10}$/.test(d.version) ? d.version : null;
      if (!running) {
        note('  that PC has not reported its version yet', 'it will on the next heartbeat after it updates');
      } else if (published && running !== published) {
        bad(`  running an old agent (${running}, published is ${published})`,
          'restart the agent on that PC — it updates itself on start');
      } else if (published) {
        good(`  running the current agent (${running})`);
      }
    }

    if (pending.length) {
      note(`${pending.length} PC(s) waiting to be approved`, 'enter the code from the PC screen under Pair PC');
    }
  } catch (err) {
    bad(`cannot read devices: ${err.message}`);
  }

  // --- stock ---------------------------------------------------------------
  section('Stock');
  try {
    const [catalog, settings] = await Promise.all([
      api('saree_catalog?select=sku,stock_quantity,status,is_active'),
      api('app_settings?key=in.(tally_godown_stock_matrix,tally_unallocated_stock)&select=key,value,updated_at'),
    ]);
    const live = catalog.filter((p) => p.is_active !== false && p.status !== 'deleted');
    const sellable = live.filter((p) => (p.stock_quantity || 0) > 0);

    const matrixRow = settings.find((r) => r.key === 'tally_godown_stock_matrix');
    const unallocRow = settings.find((r) => r.key === 'tally_unallocated_stock');
    const unalloc = parse(unallocRow && unallocRow.value) || {};

    if (matrixRow) {
      const fresh = (Date.now() - new Date(matrixRow.updated_at)) / 1000;
      if (fresh < 600) good(`stock last read from Tally ${ago(matrixRow.updated_at)}`);
      else note(`stock last read from Tally ${ago(matrixRow.updated_at)}`, 'a running agent refreshes it every 2 minutes');
    } else {
      bad('Tally stock has never been read', 'the agent does this automatically once connected');
    }

    console.log(`${C.dim}       ${sellable.length} of ${live.length} products are sellable online${C.off}`);

    const needGodown = Object.entries(unalloc).filter(([, q]) => Number(q) > 0);
    if (needGodown.length) {
      const total = needGodown.reduce((s, [, q]) => s + Number(q), 0);
      note(`${needGodown.length} item(s) hold ${total} units in Tally with no godown`,
        'they cannot be sold online until a godown is set on each one in Tally');
      needGodown.slice(0, 6).forEach(([k, q]) => console.log(`${C.dim}         ${k} — ${q}${C.off}`));
    } else if (matrixRow) {
      good('every item with stock is placed in a godown');
    }
  } catch (err) {
    bad(`cannot read stock: ${err.message}`);
  }

  // --- work queue ----------------------------------------------------------
  section('Work queue');
  try {
    const jobs = await api('agent_jobs?select=type,state,error,created_at&order=created_at.desc&limit=40');
    const waiting = jobs.filter((j) => j.state === 'pending');
    const stuck = jobs.filter((j) => j.state === 'in_progress');

    // Only failures newer than the last success still matter. A failure that was
    // diagnosed and fixed stays in the table forever, and reporting it as a current
    // problem trains everyone to ignore this section.
    const lastGood = jobs.find((j) => j.state === 'completed');
    const since = lastGood ? new Date(lastGood.created_at).getTime() : 0;
    const failed = jobs.filter((j) => j.state === 'failed' && new Date(j.created_at).getTime() > since);
    const settled = jobs.filter((j) => j.state === 'failed').length - failed.length;

    if (!jobs.length) good('nothing queued');
    else {
      if (waiting.length) {
        const oldest = waiting[waiting.length - 1];
        const mins = (Date.now() - new Date(oldest.created_at)) / 60000;
        if (mins > 5) bad(`${waiting.length} job(s) waiting, oldest ${ago(oldest.created_at)}`, 'the agent is not running — start it on the store PC');
        else good(`${waiting.length} job(s) queued, will run shortly`);
      } else {
        good('no job is waiting');
      }
      if (stuck.length) note(`${stuck.length} job(s) in progress`, 'if this persists, the agent stopped mid-job and will retry');
      if (!failed.length && settled > 0) good(`${settled} earlier failure(s), all superseded by a later success`);
      if (failed.length) {
        note(`${failed.length} job(s) failed since the last success`);
        [...new Set(failed.map((f) => f.error))].slice(0, 3)
          .forEach((e) => console.log(`${C.dim}         ${String(e).slice(0, 90)}${C.off}`));
      }
    }
  } catch (err) {
    bad(`cannot read the queue: ${err.message}`);
  }

  // --- verdict -------------------------------------------------------------
  console.log('');
  console.log('='.repeat(70));
  if (problems) {
    console.log(`${C.bad}${problems} problem(s)${C.off}${notes ? `, ${notes} note(s)` : ''} — see the lines marked FAIL above.`);
  } else if (notes) {
    console.log(`${C.warn}Working, with ${notes} note(s)${C.off} — nothing is broken, but read the NOTE lines.`);
  } else {
    console.log(`${C.ok}Everything is working.${C.off}`);
  }
  console.log('='.repeat(70));
  console.log('');
  process.exitCode = problems ? 1 : 0;
})().catch((err) => {
  console.error(`\nCheck failed to run: ${err.message}\n`);
  process.exitCode = 2;
});
