/**
 * A shop is bound to one Tally company by GUID. Nothing enforced it: sync applied
 * whatever reading arrived, so opening a different company on the shop PC would have
 * written that company's stock into this shop's catalogue, and claim would have handed
 * out jobs that posted vouchers into the wrong books.
 *
 * This lifts the rule out of the deployed function rather than restating it, so the
 * test fails if the rule is weakened.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'functions', 'agent-sync', 'index.ts'), 'utf8'
);

const start = src.indexOf('function companyRefusal(');
assert.ok(start > 0, 'companyRefusal not found in the deployed function');
const open = src.indexOf('{', start);
let depth = 0, end = -1;
for (let i = open; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (!depth) { end = i + 1; break; } }
}
const fn = src.slice(start, end)
  .replace('function companyRefusal(registered: string, reported: string): string | null', 'function companyRefusal(registered, reported)');
const companyRefusal = eval('(' + fn + ')');

const OURS = 'a6ad0fef-6d04-4c21-8b82-a31796fd6e9b';
const THEIRS = 'b71c55aa-1111-4c21-8b82-a31796fd6e9b';

// The whole point: another company's data must not be accepted.
assert.strictEqual(companyRefusal(OURS, THEIRS), 'guid_mismatch');
console.log('ok   a different company is refused');

// Unprovable provenance is refused too — "no GUID" must not mean "trust it".
assert.strictEqual(companyRefusal(OURS, ''), 'no_company_open');
assert.strictEqual(companyRefusal(OURS, '   '.trim()), 'no_company_open');
console.log('ok   a reading that cannot name its company is refused');

// The registered company is accepted, whatever case Tally reports it in.
assert.strictEqual(companyRefusal(OURS, OURS), null);
assert.strictEqual(companyRefusal(OURS, OURS.toUpperCase()), null);
assert.strictEqual(companyRefusal(OURS.toUpperCase(), OURS), null);
console.log('ok   the registered company is accepted regardless of case');

// A brand new shop has nothing to compare against; first sight registers it.
assert.strictEqual(companyRefusal('', THEIRS), null);
assert.strictEqual(companyRefusal('', ''), null);
console.log('ok   an unbound shop accepts its first company');

// A near-miss must not pass: one character different is a different company.
assert.strictEqual(companyRefusal(OURS, OURS.slice(0, -1) + 'c'), 'guid_mismatch');
assert.strictEqual(companyRefusal(OURS, OURS.slice(0, 8)), 'guid_mismatch');
console.log('ok   a partial or near-miss GUID is refused');

// Both readers must route through the guard, or it can be bypassed.
assert.ok(
  /applyStockReading\(device\.shop_id, body\.result as Record<string, unknown>, String\(device\.company_loaded/.test(src),
  'report must pass the device company into applyStockReading'
);
assert.ok(
  /applyStockReading\(device\.shop_id, result, String\(device\.company_loaded/.test(src),
  'sync must pass the device company into applyStockReading'
);
assert.ok(
  /const refusal = companyRefusal\(registered, reportedGuid\);[\s\S]{0,200}?return \{ applied: 0, refused/.test(src),
  'applyStockReading must return without applying when the company is refused'
);
console.log('ok   both sync and report route through the guard');

// claim must refuse too, or a job would write into the wrong books.
assert.ok(
  /if \(refusal\) return json\(\{ job: null, refused: refusal \}\);/.test(src),
  'claim must hand out no job when the company is wrong'
);
console.log('ok   claim hands out no work on the wrong company');

// sync must not overwrite the recorded GUID with a bare true, or claim's check is blind.
const syncBlock = src.slice(src.indexOf('async function syncStock'), src.indexOf('async function applyStockReading'));
assert.ok(!/company_loaded: true/.test(syncBlock), 'sync must not clobber the recorded company');
console.log('ok   sync does not blind the check it depends on');

console.log('\nall company-binding checks passed');
