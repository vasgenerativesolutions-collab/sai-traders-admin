/**
 * Stamp the dashboard's script and stylesheet with their own content hash.
 *
 *   node scripts/stamp_assets.js          report whether the stamps are current
 *   node scripts/stamp_assets.js --write  update them
 *
 * index.html loaded `app-v2.js?v=20261105_agentapprove_v7` — a hand-written string that
 * nobody remembered to change. GitHub Pages serves the file with max-age=600, so a
 * browser that had fetched that exact URL kept running an old script against a new page
 * for as long as the string stayed the same. Every fix to app-v2.js was invisible, and
 * the symptom was a screen that would not load: new HTML calling functions the cached
 * script did not have.
 *
 * A content hash cannot be forgotten, because it changes when the file does.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'admin', 'public');
const HTML = path.join(PUBLIC, 'index.html');

const ASSETS = ['app-v2.js', 'style.css'];

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
}

const write = process.argv.includes('--write');
let html = fs.readFileSync(HTML, 'utf8');
let stale = 0;

for (const asset of ASSETS) {
  const file = path.join(PUBLIC, asset);
  if (!fs.existsSync(file)) { console.log(`  --  ${asset} does not exist`); continue; }

  const want = hash(file);
  const pattern = new RegExp(`(${asset.replace('.', '\\.')})\\?v=([\\w.-]+)`, 'g');
  const found = [...html.matchAll(pattern)];

  if (!found.length) { console.log(`  !!  ${asset} is referenced without a version`); stale++; continue; }

  const current = found[0][2];
  if (current === want) {
    console.log(`  ok  ${asset.padEnd(12)} ${current}`);
    continue;
  }

  stale++;
  if (write) {
    html = html.replace(pattern, `$1?v=${want}`);
    console.log(`  ok  ${asset.padEnd(12)} ${current} -> ${want}`);
  } else {
    console.log(`  !!  ${asset.padEnd(12)} ${current} is stale, should be ${want}`);
  }
}

if (write && stale) {
  fs.writeFileSync(HTML, html);
  console.log('\nindex.html updated. Browsers will fetch the new files.');
} else if (stale) {
  console.log('\nRun with --write to update. Until then, a browser that has already');
  console.log('loaded these URLs keeps running the old files.');
  process.exitCode = 1;
} else {
  console.log('\nEvery asset stamp matches its file.');
}
