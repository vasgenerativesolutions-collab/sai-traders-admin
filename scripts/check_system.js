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

      // Everything below comes from the same heartbeat row. If the PC has gone quiet,
      // these describe the past, so say so rather than reporting them as the present.
      const live = seenSec < 180;

      if (!live) {
        console.log(`${C.dim}       nothing below is current — it is what that PC last reported${C.off}`);
      }

      if (d.tally_reachable) {
        if (live) good('  TallyPrime is answering on that PC');
        else console.log(`${C.dim}       Tally was answering when it last reported${C.off}`);
      } else {
        bad('  TallyPrime is not answering on that PC', 'open Tally, load the company, F1 > Settings > Connectivity (acts as: Both, port 9000)');
      }

      if (!d.company_loaded) note('  no Tally company is open', 'load the company in Tally');

      // A stale agent explains otherwise baffling failures, so say it outright.
      const running = d.version && /^[0-9a-f]{10}$/.test(d.version) ? d.version : null;
      if (!running) {
        note('  that PC has not reported its version yet', 'it will on the next heartbeat after it updates');
      } else if (published && running !== published) {
        bad(`  running an old agent (${running}, published is ${published})`,
          'restart the agent on that PC — it updates itself on start');
      } else if (published && live) {
        good(`  running the current agent (${running})`);
      } else if (published) {
        console.log(`${C.dim}       was running the current agent (${running})${C.off}`);
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
      api('saree_catalog?select=sku,tally_part_number,name,price,stock_quantity,status,is_active,created_by'),
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

    // Stock sitting in Tally under a name no product carries is invisible online and
    // nothing reports it: 1500 units sat in the online godown as SAI-SILK-02 while the
    // catalogue product was Sai_silk_02, and every surface said "working".
    const matrix = parse(matrixRow && matrixRow.value) || {};
    const known = new Set();
    for (const p of catalog) {
      for (const k of [p.sku, p.tally_part_number]) {
        const v = String(k || '').trim().toLowerCase();
        if (v) known.add(v);
      }
    }
    const stranded = Object.entries(matrix)
      .filter(([name, godowns]) => !known.has(name) &&
        Object.values(godowns || {}).some((q) => Number(q) > 0));

    if (stranded.length) {
      bad(`${stranded.length} item(s) hold stock in Tally with no product at all`,
        'a product should have been created automatically — check the agent-sync logs');
      stranded.slice(0, 6).forEach(([name, godowns]) => {
        const where = Object.entries(godowns).map(([g, q]) => `${q} in ${g}`).join(', ');
        console.log(`${C.dim}         ${name} — ${where}${C.off}`);
      });
    }

    // Items the shop created in Tally become draft products. They are not sellable
    // until someone adds a price and photos, so they are work waiting on a human —
    // worth saying once, not a fault.
    const drafts = catalog.filter((p) => p.created_by === 'agent' && p.status !== 'listed');
    if (drafts.length) {
      note(`${drafts.length} product(s) came from Tally and need details before they can sell`,
        'open each in the dashboard and add a price and photos, then list it');
      drafts.slice(0, 6).forEach((p) => {
        // Say what is actually missing. "no price yet" was printed whatever the price
        // was, which is how a priced saree looked unpriced.
        const lacks = [];
        if (!(Number(p.price) > 0)) lacks.push('no price');
        if (!(p.name || '').trim() || (p.name || '').trim().toLowerCase() === String(p.tally_part_number || p.sku || '').trim().toLowerCase()) lacks.push('no name');
        if (p.status === 'archived' || p.status === 'deleted') lacks.push('taken off sale');
        console.log(`${C.dim}         ${p.sku} — ${p.stock_quantity} in stock${lacks.length ? ', ' + lacks.join(', ') : ', needs a photo or video'}${C.off}`);
      });
    }

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

  // --- image and text search -------------------------------------------------
  //
  // Attaching a video is how a customer's photograph gets matched to a saree: the
  // keyframes become image embeddings and the description becomes a text embedding.
  // All of that needs a working Gemini key, and without one the video is still
  // recorded and the saree still goes on sale — so the feature reports success while
  // doing none of its actual work. That is worth a line of its own.
  section('Image and text search');
  try {
    const key = E.GEMINI_API_KEY;
    if (!key) {
      bad('no Gemini API key is set', 'add GEMINI_API_KEY to .env, then: npx supabase secrets set --env-file .env');
    } else {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'models/gemini-embedding-001',
            content: { parts: [{ text: 'saree' }] },
            outputDimensionality: 768,
          }),
          signal: AbortSignal.timeout(15000),
        }
      );

      if (res.ok) {
        good('the Gemini key works, so videos and photos can be indexed');
      } else if (res.status === 401 || res.status === 403) {
        bad(`the Gemini key is rejected (HTTP ${res.status})`,
          'get a new key at aistudio.google.com/apikey, put it in .env as GEMINI_API_KEY, then: npx supabase secrets set --env-file .env');
        console.log(`${C.dim}       until then a video is recorded but image search is never taught the saree${C.off}`);
      } else {
        note(`Gemini answered HTTP ${res.status}`, 'embeddings may be failing — check the key and the quota');
      }
    }

    // The catalogue and the search must use the SAME embedding model.
    //
    // The catalogue was embedded with gemini-embedding-2 while the webhook embedded a
    // customer's words with gemini-embedding-001. Two models mean two vector spaces, so
    // every search returned nothing while the re-indexing and the search both reported
    // success. Nothing anywhere said the two did not agree.
    try {
      const searchModel = (fs.readFileSync(path.join(ROOT, 'supabase', 'functions', '_shared', 'gemini.ts'), 'utf8')
        .match(/models\/(gemini-embedding[\w.-]*):embedContent/) || [, null])[1];
      const rows = await api('saree_catalog?select=embedding_model&is_active=eq.true&embedding_model=not.is.null');
      const used = [...new Set(rows.map((r) => r.embedding_model))];

      if (!searchModel) {
        note('could not tell which model the search uses', 'check _shared/gemini.ts');
      } else if (!used.length) {
        note('no saree has been indexed yet', 'run: npm run reembed');
      } else if (used.length > 1 || used[0] !== searchModel) {
        bad(`the catalogue is indexed with ${used.join(' and ')} but searched with ${searchModel}`,
          'they must match or every search returns nothing — run: npm run reembed');
      } else {
        good(`the catalogue and the search both use ${searchModel}`);
      }
    } catch (err) {
      note(`could not compare embedding models: ${err.message}`);
    }

    // How many sellable sarees a customer could actually find by searching.
    const indexed = await api('saree_catalog?select=sku&is_active=eq.true&embedding=not.is.null');
    const sellable = await api('saree_catalog?select=sku&is_active=eq.true&stock_quantity=gt.0');
    if (sellable.length) {
      const missing = sellable.length - indexed.length;
      if (missing > 0) {
        note(`${missing} of ${sellable.length} sellable saree(s) cannot be found by search`,
          'they have no embedding yet — attach a video, or run: npm run reembed');
      } else {
        good(`all ${sellable.length} sellable saree(s) can be found by search`);
      }
    }
  } catch (err) {
    note(`could not check search indexing: ${err.message}`);
  }

  // --- the dashboard's own assets -------------------------------------------
  //
  // index.html loads the script with a ?v= stamp. GitHub Pages serves it with
  // max-age=600, so a stale stamp means a browser keeps running an old script
  // against a new page — which shows up as a screen that will not load, not as a
  // caching problem. Content hashes cannot be forgotten, so this checks them.
  section('Dashboard files');
  try {
    const crypto = require('crypto');
    const html = fs.readFileSync(path.join(ROOT, 'admin', 'public', 'index.html'), 'utf8');
    let mismatched = 0;
    for (const asset of ['app-v2.js', 'style.css']) {
      const file = path.join(ROOT, 'admin', 'public', asset);
      if (!fs.existsSync(file)) continue;
      const want = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
      // Plain string work rather than a regex: this file is generated by patch scripts
      // and an escaped pattern has silently collapsed more than once here.
      const marker = asset + '?v=';
      const at = html.indexOf(marker);
      const stamp = at < 0 ? null : html.slice(at + marker.length).split(/["'&]/)[0];
      if (!stamp) { bad(`${asset} is loaded without a version stamp`, 'add ?v=<hash> so browsers pick up changes'); mismatched++; }
      else if (stamp !== want) { bad(`${asset} stamp is stale (${stamp}, should be ${want})`, 'run: node scripts/stamp_assets.js --write'); mismatched++; }
    }
    if (!mismatched) good('the dashboard is serving its current script and stylesheet');
  } catch (err) {
    note(`could not check the dashboard files: ${err.message}`);
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
        // "will run shortly" is only true if an agent is collecting work. Saying it
        // while the store PC has been off for days is the same failure as the rest of
        // this file used to have: reporting the intention rather than the situation.
        const agentLive = activeDevice && activeDevice.last_seen_at
          && (Date.now() - new Date(activeDevice.last_seen_at)) / 1000 < 180;

        if (!agentLive) {
          note(`${waiting.length} job(s) waiting for the store PC`,
            'they apply by themselves once the agent is running — nothing is lost');
        } else if (mins > 5) {
          bad(`${waiting.length} job(s) waiting, oldest ${ago(oldest.created_at)}`,
            'the agent is reporting in but not finishing work — check its log');
        } else {
          good(`${waiting.length} job(s) queued, will run within seconds`);
        }
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
