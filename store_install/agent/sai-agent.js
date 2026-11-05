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
const TALLY_SPACING_MS = 250; // Tally's XML engine is single threaded — never crowd it

const STATE_DIR = path.join(process.env.PROGRAMDATA || os.homedir(), 'SaiAgent');
const TOKEN_FILE = path.join(STATE_DIR, 'device.enc');
const OUTBOX_FILE = path.join(STATE_DIR, 'outbox.json');

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
  tallyChain = tallyChain.then(async () => {
    const gap = Date.now() - lastTallyCall;
    if (gap < TALLY_SPACING_MS) await new Promise((r) => setTimeout(r, TALLY_SPACING_MS - gap));
    try {
      return await tallyRaw(xml, timeoutMs);
    } finally {
      lastTallyCall = Date.now();
    }
  }, () => {});
  return tallyChain;
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
  const block = raw.match(/<COMPANY\b[^>]*>([\s\S]*?)<\/COMPANY>/i);
  if (!block) return null;
  return {
    name: (block[0].match(/NAME="([^"]+)"/i) || [, tag(block[1], 'NAME')])[1] || tag(block[1], 'NAME'),
    guid: tag(block[1], 'GUID'),
    number: tag(block[1], 'COMPANYNUMBER'),
  };
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
      return { company, tallyReachable: Boolean(company) };
    }
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

  banner(['SAI AGENT', `${os.hostname()}  ·  Tally at ${TALLY_HOST}:${TALLY_PORT}`]);

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
  let idleLogged = false;

  for (;;) {
    try {
      if (Date.now() - lastBeat > HEARTBEAT_MS) {
        lastBeat = Date.now();
        await heartbeat(token).catch((e) => warn(`heartbeat: ${e.message}`));
      }

      await drainOutbox(token);

      const claimed = await callCloud('claim', { deviceToken: token });
      if (claimed.status === 401) {
        warn('this device was revoked — stopping');
        process.exit(1);
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
