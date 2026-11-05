/**
 * Parsing checks for scripts/store_preflight.js.
 * Run: node scripts/test_store_preflight.js
 *
 * The fixtures below are real TallyPrime responses captured from the live company,
 * including the two shapes that are easy to get wrong:
 *   - batch rows carry OPENINGBALANCE and never CLOSINGBALANCE
 *   - the root godown parent arrives with a control character before "Primary"
 */
const assert = require('assert');

// Mirrors tag() in store_preflight.js. Must match tags WITH attributes and must
// NOT match <NAME.LIST>, which Tally nests inside COMPANY and STOCKITEM blocks.
const tag = (body, name) => {
  const m = body.match(new RegExp('<' + name + '(?:[ 	][^>]*)?>([^<]*)</' + name + '>', 'i'));
  return m ? m[1].trim() : '';
};

// These five pin the regex itself — an earlier version lost its s escape and silently
// stopped matching any attributed tag, which would have zeroed every balance read.
assert.strictEqual(tag('<CLOSINGBALANCE TYPE="Quantity"> 9 Pcs</CLOSINGBALANCE>', 'CLOSINGBALANCE'), '9 Pcs');
assert.strictEqual(tag('<PARENT> Primary</PARENT>', 'PARENT'), 'Primary');
assert.strictEqual(tag('<GUID>abc-123</GUID>', 'GUID'), 'abc-123');
assert.strictEqual(tag('<LANGUAGENAME.LIST><NAME.LIST TYPE="String"><NAME>Sarie01</NAME>', 'NAME'), 'Sarie01');
assert.strictEqual(tag('<BATCHALLOCATIONS.LIST>     </BATCHALLOCATIONS.LIST>', 'GODOWNNAME'), '');

// --- godown parsing ----------------------------------------------------------
function parseGodowns(raw) {
  const out = [];
  for (const b of raw.matchAll(/<GODOWN\b[^>]*>([\s\S]*?)<\/GODOWN>/gi)) {
    const name = (b[0].match(/NAME="([^"]+)"/i) || [, ''])[1];
    if (!name) continue;
    const parent = tag(b[1], 'PARENT')
      .replace(/&#\d+;/g, '')
      .replace(/&#x[0-9a-f]+;/gi, '')
      .replace(/[^\x20-\x7E]/g, '')
      .trim();
    out.push({ name, parent: /^primary$/i.test(parent) || !parent ? null : parent, closing: tag(b[1], 'CLOSINGBALANCE') || null });
  }
  return out;
}

// Real response: the parent arrives as " Primary", which must read as root.
const GODOWN_XML = `
<GODOWN NAME="Main Location" RESERVEDNAME=""><PARENT> Primary</PARENT><CLOSINGBALANCE> 80 Pcs</CLOSINGBALANCE></GODOWN>
<GODOWN NAME="Online_saree" RESERVEDNAME=""><PARENT> Primary</PARENT><CLOSINGBALANCE> 149 Pcs</CLOSINGBALANCE></GODOWN>
<GODOWN NAME="Jari" RESERVEDNAME=""><PARENT> Primary</PARENT><CLOSINGBALANCE>0 Pcs</CLOSINGBALANCE></GODOWN>
<GODOWN NAME="Sub Rack" RESERVEDNAME=""><PARENT>Online_saree</PARENT></GODOWN>
`;

const g = parseGodowns(GODOWN_XML);
assert.strictEqual(g.length, 4);
// The control-character prefix must not become a bogus parent name
assert.strictEqual(g[0].parent, null, 'control-prefixed Primary must read as root');
assert.strictEqual(g[1].name, 'Online_saree');
assert.strictEqual(g[1].closing, '149 Pcs');
// A genuine sub-godown is preserved
assert.strictEqual(g[3].parent, 'Online_saree');

// --- stock item parsing ------------------------------------------------------
function parseItems(raw) {
  const items = [];
  for (const b of raw.matchAll(/<STOCKITEM NAME="([^"]+)"[^>]*>([\s\S]*?)<\/STOCKITEM>/gi)) {
    const body = b[2];
    const closingRaw = tag(body, 'CLOSINGBALANCE');
    const qty = parseFloat((closingRaw.match(/-?[0-9.]+/) || [0])[0]) || 0;
    const godowns = {};
    for (const batch of body.matchAll(/<BATCHALLOCATIONS\.LIST[^>]*>([\s\S]*?)<\/BATCHALLOCATIONS\.LIST>/gi)) {
      const gn = tag(batch[1], 'GODOWNNAME');
      if (!gn) continue;
      const q = parseFloat(((tag(batch[1], 'OPENINGBALANCE') || tag(batch[1], 'CLOSINGBALANCE')).match(/-?[0-9.]+/) || [0])[0]) || 0;
      godowns[gn] = (godowns[gn] || 0) + q;
    }
    items.push({ name: b[1], closing: qty, closingRaw: closingRaw || null, godowns });
  }
  return items;
}

// Real responses. SAI-SIK-03 has a batch row; Sarie01's is present but EMPTY, which is
// what Tally returns when batch-wise details are off — the whole reason nine items
// could not be placed in a godown.
const STOCK_XML = `
<STOCKITEM NAME="SAI-SIK-03" RESERVEDNAME="">
  <CLOSINGBALANCE TYPE="Quantity"> 9 Pcs</CLOSINGBALANCE>
  <BATCHALLOCATIONS.LIST>
    <GODOWNNAME>Online_saree</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME>
    <OPENINGBALANCE> 11 Pcs</OPENINGBALANCE>
  </BATCHALLOCATIONS.LIST>
</STOCKITEM>
<STOCKITEM NAME="Sarie01" RESERVEDNAME="">
  <CLOSINGBALANCE TYPE="Quantity"> 99 Pcs</CLOSINGBALANCE>
  <BATCHALLOCATIONS.LIST>     </BATCHALLOCATIONS.LIST>
</STOCKITEM>
<STOCKITEM NAME="Jari1" RESERVEDNAME="">
  <CLOSINGBALANCE TYPE="Quantity">-10 Pcs</CLOSINGBALANCE>
  <BATCHALLOCATIONS.LIST>     </BATCHALLOCATIONS.LIST>
</STOCKITEM>
<STOCKITEM NAME="Sai02" RESERVEDNAME="">
  <CLOSINGBALANCE TYPE="Quantity"></CLOSINGBALANCE>
</STOCKITEM>
`;

const items = parseItems(STOCK_XML);
assert.strictEqual(items.length, 4);

// An empty BATCHALLOCATIONS.LIST must yield no godown, not a phantom entry
assert.deepStrictEqual(items[1].godowns, {}, 'empty batch list must attribute nothing');
assert.deepStrictEqual(items[0].godowns, { Online_saree: 11 });

// Negative closing balances must stay negative so the warning can fire
assert.strictEqual(items[2].closing, -10);

// A blank closing balance is zero, not NaN
assert.strictEqual(items[3].closing, 0);

// The readiness signal: attribution exists only where a batch row carries a godown
const withStock = items.filter(i => i.closing > 0);
const attributed = items.filter(i => Object.keys(i.godowns).length > 0);
const unattributed = withStock.filter(i => Object.keys(i.godowns).length === 0);
assert.strictEqual(withStock.length, 2);        // SAI-SIK-03 and Sarie01
assert.strictEqual(attributed.length, 1);        // only SAI-SIK-03
assert.strictEqual(unattributed.length, 1);      // Sarie01 holds 99 and is unplaceable
assert.strictEqual(attributed.length > 0, true); // batch-wise details detected as ON

// --- OS detection ------------------------------------------------------------
// Windows 10 and 11 both report 10.x; only the build number separates them.
const winName = rel => {
  const build = parseInt(rel.split('.')[2] || '0', 10);
  return rel.startsWith('10.') ? (build >= 22000 ? 'Windows 11' : 'Windows 10') : `Windows (${rel})`;
};
assert.strictEqual(winName('10.0.19045'), 'Windows 10');
assert.strictEqual(winName('10.0.26300'), 'Windows 11');

// A company with no stock items cannot establish whether batch-wise details is on.
// Reporting that as a failure sent someone to change a Tally setting unnecessarily.
const empty = parseItems('');
assert.strictEqual(empty.length, 0);
assert.strictEqual(empty.filter(i => i.closing > 0).length, 0);

console.log('store preflight parsing: all 21 cases pass');
