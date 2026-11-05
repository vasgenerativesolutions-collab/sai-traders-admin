/**
 * Tally reports a master that already exists as an EXCEPTION, not as success.
 * Discarding that reply is what produced "Unit 'Pcs' does not exist!" for a unit that
 * did exist. These are Tally's real replies, captured from the live company.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Lift the two functions under test out of the agent rather than copying them, so this
// cannot drift away from what actually ships.
const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'sai-agent.js'), 'utf8');
function lift(name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start > 0, name + ' not found in the agent');
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}
const importOutcome = eval('(' + lift('importOutcome') + ')');

// --- Tally's real replies ----------------------------------------------------
const DUPLICATE = `<RESPONSE> <LINEERROR>DUPLICATE ORIGINAL NAME</LINEERROR> <CREATED>0</CREATED>
 <ALTERED>0</ALTERED> <DELETED>0</DELETED> <LASTVCHID>0</LASTVCHID> <LASTMID>0</LASTMID>
 <COMBINED>0</COMBINED> <IGNORED>0</IGNORED> <ERRORS>0</ERRORS> <CANCELLED>0</CANCELLED>
 <EXCEPTIONS>1</EXCEPTIONS> </RESPONSE>`;

const CREATED = `<RESPONSE> <CREATED>1</CREATED> <ALTERED>0</ALTERED> <DELETED>0</DELETED>
 <LASTVCHID>0</LASTVCHID> <LASTMID>0</LASTMID> <COMBINED>0</COMBINED> <IGNORED>0</IGNORED>
 <ERRORS>0</ERRORS> <CANCELLED>0</CANCELLED> <EXCEPTIONS>0</EXCEPTIONS> </RESPONSE>`;

const REAL_FAILURE = `<RESPONSE> <LINEERROR>Stock Group 'Primary' does not exist!</LINEERROR>
 <CREATED>0</CREATED> <ALTERED>0</ALTERED> <ERRORS>1</ERRORS> <EXCEPTIONS>0</EXCEPTIONS> </RESPONSE>`;

// --- what importOutcome makes of them ---------------------------------------
const dup = importOutcome(DUPLICATE);
assert.strictEqual(dup.ok, false, 'a duplicate is not reported as success by Tally');
assert.strictEqual(dup.message, 'DUPLICATE ORIGINAL NAME');
console.log('ok   a duplicate reply is recognised as not-ok, with its message intact');

const made = importOutcome(CREATED);
assert.strictEqual(made.ok, true);
assert.strictEqual(made.created, 1);
console.log('ok   a successful create is recognised');

const bad = importOutcome(REAL_FAILURE);
assert.strictEqual(bad.ok, false);
assert.match(bad.message, /does not exist/);
console.log('ok   a genuine rejection is recognised');

// --- the rule ensureMaster applies ------------------------------------------
// Taken from the shipped source so the test fails if the predicate is edited.
const predicate = (src.match(/if \((\/[^/]+\/i)\.test\(out\.message \|\| ''\)\) return \{ name: label, existed: true \};/) || [])[1];
assert.ok(predicate, 'the already-exists predicate was not found in ensureMaster');
const alreadyExists = eval('(m) => ' + predicate + '.test(m || "")');

assert.strictEqual(alreadyExists(dup.message), true, 'DUPLICATE ORIGINAL NAME means it is already there');
assert.strictEqual(alreadyExists('A master with the same name already exists'), true);
assert.strictEqual(alreadyExists(bad.message), false, 'a missing stock group must still be a failure');
assert.strictEqual(alreadyExists('Unit \'Pcs\' does not exist!'), false);
assert.strictEqual(alreadyExists(null), false);
console.log('ok   only an already-there reply is treated as success');

console.log('\nall master-outcome checks passed');
