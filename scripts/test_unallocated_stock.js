// Self-check for the unallocated-stock rule used by fetchAllTallyStockItems()
// in admin/server.js. Run: node scripts/test_unallocated_stock.js
//
// The rule: stock sitting in a NON-target godown (Jari, Main Location) must stay
// hidden, while stock with no godown allocation at all must surface for fixing.
// That only holds if the gap is measured against the FULL breakdown. Measuring
// against the online quantity instead would leak other-godown stock into the UI.
const assert = require('assert');

const TARGET = 'Online_saree';

// Mirrors admin/server.js -> fetchAllTallyStockItems() items.push()
function score(closingTotal, godownBreakdown) {
  const allocated = Object.values(godownBreakdown).reduce((s, v) => s + (Number(v) || 0), 0);
  const sellable = Object.entries(godownBreakdown)
    .filter(([g]) => g.toLowerCase() === TARGET.toLowerCase())
    .reduce((s, [, v]) => s + (Number(v) || 0), 0);
  return {
    sellable: Math.max(0, Math.round(sellable)),
    unallocated: Math.max(0, Math.round(closingTotal - allocated))
  };
}

// Row 1: genuinely no stock -> plain zero, nothing to flag
assert.deepStrictEqual(score(0, {}), { sellable: 0, unallocated: 0 });

// Row 2: stock in Tally, allocated nowhere -> not sellable, but must be flagged
assert.deepStrictEqual(score(15, {}), { sellable: 0, unallocated: 15 });

// Row 3: stock lives in another godown -> hidden entirely, NOT flagged.
// This is the case that breaks if the gap is measured against sellable instead.
assert.deepStrictEqual(score(15, { Jari: 15 }), { sellable: 0, unallocated: 0 });
assert.deepStrictEqual(score(8, { 'Main Location': 8 }), { sellable: 0, unallocated: 0 });

// Row 4: allocated to the target godown -> sellable
assert.deepStrictEqual(score(10, { Online_saree: 10 }), { sellable: 10, unallocated: 0 });

// Mixed: 10 online + 5 in Jari + 3 loose -> sell 10, flag 3, never mention the 5
assert.deepStrictEqual(score(18, { Online_saree: 10, Jari: 5 }), { sellable: 10, unallocated: 3 });

// Tally can report a closing balance below the sum of allocations; never go negative
assert.deepStrictEqual(score(2, { Online_saree: 10 }), { sellable: 10, unallocated: 0 });

console.log('unallocated-stock rule: all 7 cases pass');

// --- Godown attribution from item closing balance -----------------------------
// Tally batch rows carry OPENINGBALANCE only, never a closing figure. Reading them
// as current stock overstated SAI-SIK-03 (opened 11, closes 9) and understated
// SAI_SILK_01 (opened 15, closes 25). Batch rows give PLACEMENT; the item's
// CLOSINGBALANCE gives QUANTITY.
function attribute(closingTotal, godownOpenings) {
  const out = {};
  const holders = Object.keys(godownOpenings);
  if (holders.length === 1) {
    out[holders[0]] = closingTotal;
  } else if (holders.length > 1) {
    const totalWeight = holders.reduce((s, g) => s + Math.max(0, godownOpenings[g]), 0);
    let assigned = 0;
    holders.forEach((g, i) => {
      let q;
      if (i === holders.length - 1) q = Math.round(closingTotal) - assigned;
      else if (totalWeight > 0) q = Math.round(closingTotal * Math.max(0, godownOpenings[g]) / totalWeight);
      else q = Math.round(closingTotal / holders.length);
      assigned += q;
      out[g] = q;
    });
  }
  return out;
}

// The two real cases from this company — both must report CLOSING, not opening
assert.deepStrictEqual(attribute(9,  { Online_saree: 11 }), { Online_saree: 9 });
assert.deepStrictEqual(attribute(25, { Online_saree: 15 }), { Online_saree: 25 });

// No godown row -> stays empty so unallocated_qty surfaces it
assert.deepStrictEqual(attribute(99, {}), {});

// Multi-godown: split by opening weight, and the parts must sum to the closing total
const split = attribute(100, { Online_saree: 30, 'Main Location': 10 });
assert.strictEqual(Object.values(split).reduce((a, b) => a + b, 0), 100);
assert.strictEqual(split.Online_saree, 75);

// Rounding must never lose or invent units
const odd = attribute(10, { A: 1, B: 1, C: 1 });
assert.strictEqual(Object.values(odd).reduce((a, b) => a + b, 0), 10);

// Zero opening weights still distribute the whole closing balance
const zero = attribute(7, { A: 0, B: 0 });
assert.strictEqual(Object.values(zero).reduce((a, b) => a + b, 0), 7);

console.log('godown attribution: all 7 cases pass');

// --- stock source precedence (/api/products, /api/live-stock) ------------------
// stock_pool is a cache: syncGodownStockTransition rewrites every row on a godown
// switch, which zeroed all 9 items. That zero used to win over live Tally stock
// because the stock_pool branch ran first and short-circuited the matrix.
function resolveQty({ itemMatrix = {}, scope = [], stock = null, requestedGodown, catalogQty = 0 }) {
  let scopeSum = 0, matched = false;
  for (const sc of scope) {
    const k = Object.keys(itemMatrix).find(x => x.toLowerCase() === sc.toLowerCase());
    if (k !== undefined) { scopeSum += Number(itemMatrix[k]) || 0; matched = true; }
  }
  if (matched) return scopeSum;
  if (stock && stock.tally_godown && stock.tally_godown.toLowerCase() === requestedGodown.toLowerCase()) {
    return Number(stock.online_quantity) || 0;
  }
  if (stock && !stock.tally_godown) return Number(stock.online_quantity) || catalogQty;
  return 0;
}

// The regression that broke the dashboard: Tally says 9, the zeroed cache said 0.
assert.strictEqual(resolveQty({
  itemMatrix: { Online_saree: 9 },
  scope: ['Online_saree'],
  stock: { tally_godown: 'Online_saree', online_quantity: 0 },
  requestedGodown: 'Online_saree',
}), 9);

// Cache still used when Tally has no figure for that godown
assert.strictEqual(resolveQty({
  itemMatrix: {},
  scope: ['Online_saree'],
  stock: { tally_godown: 'Online_saree', online_quantity: 7 },
  requestedGodown: 'Online_saree',
}), 7);

// Stock held in another godown must never count toward the requested one
assert.strictEqual(resolveQty({
  itemMatrix: { 'Main Location': 80 },
  scope: ['Online_saree'],
  stock: { tally_godown: 'Main Location', online_quantity: 80 },
  requestedGodown: 'Online_saree',
}), 0);

// Untagged legacy row falls back to the catalogue figure
assert.strictEqual(resolveQty({
  stock: { tally_godown: null, online_quantity: 0 },
  requestedGodown: 'Online_saree',
  catalogQty: 12,
}), 12);

// An explicit Tally zero is authoritative — not a reason to fall back to the cache
assert.strictEqual(resolveQty({
  itemMatrix: { Online_saree: 0 },
  scope: ['Online_saree'],
  stock: { tally_godown: 'Online_saree', online_quantity: 99 },
  requestedGodown: 'Online_saree',
}), 0);

console.log('stock source precedence: all 5 cases pass');

// --- designated stock writer ---------------------------------------------------
// Inventory figures in Supabase are shared rows; every server instance writes to the
// same keys and last writer wins. Only the machine with Tally attached can produce
// correct values. A godown switch from the Tally-less admin laptop zeroed all 9
// stock_pool rows — that write must be refused, not merely read around.
function isStockWriter(tallyConnected, identityVerified) {
  return tallyConnected && identityVerified;
}

assert.strictEqual(isStockWriter(true, true), true);    // store PC
assert.strictEqual(isStockWriter(false, true), false);  // admin laptop, no local Tally
assert.strictEqual(isStockWriter(true, false), false);  // Tally up, wrong/unverified company
assert.strictEqual(isStockWriter(false, false), false);

// Identity alone must never be enough: SEC-07 verification can still be true from an
// earlier check while Tally is now unreachable, and writing then is how zeroes land.
assert.strictEqual(isStockWriter(false, true), false);

console.log('designated stock writer: all 5 cases pass');

// --- "set stock to N" delta arithmetic ----------------------------------------
// The UI sends an absolute target; Tally receives a delta voucher. Two defects
// compounded and turned "set to 40" into 46:
//   1. the baseline came from saree_catalog.stock_quantity (a cache that drifts)
//   2. an existing item was re-pushed with ACTION="Alter", resetting its opening
//      balance to the target, and THEN the delta voucher was applied on top.
function planAdjust({ target, tallyActual, cachedQty, itemExists }) {
  if (!itemExists) {
    // Creating the master at the target quantity IS the adjustment — no voucher.
    return { createAt: target, voucher: 0, result: target };
  }
  const baseline = tallyActual !== undefined ? tallyActual : cachedQty;
  const voucher = target - baseline;
  return { createAt: null, voucher, result: tallyActual + voucher };
}

// The reported bug: Tally held 40, cache said 34, user asked for 40.
// Old behaviour: voucher = 40 - 34 = +6 applied to 40 -> 46.
assert.strictEqual(planAdjust({ target: 40, tallyActual: 40, cachedQty: 34, itemExists: true }).result, 40);
assert.strictEqual(planAdjust({ target: 40, tallyActual: 40, cachedQty: 34, itemExists: true }).voucher, 0);

// Genuine reduction still works
const down = planAdjust({ target: 40, tallyActual: 46, cachedQty: 46, itemExists: true });
assert.strictEqual(down.voucher, -6);
assert.strictEqual(down.result, 40);

// Genuine increase
assert.strictEqual(planAdjust({ target: 50, tallyActual: 40, cachedQty: 40, itemExists: true }).voucher, 10);

// A new item is created at the target and must NOT also get a voucher,
// which is exactly the double-count that produced 46.
const fresh = planAdjust({ target: 40, tallyActual: 0, cachedQty: 0, itemExists: false });
assert.strictEqual(fresh.createAt, 40);
assert.strictEqual(fresh.voucher, 0);
assert.strictEqual(fresh.result, 40);

// Setting to zero is a valid instruction, not a no-op
assert.strictEqual(planAdjust({ target: 0, tallyActual: 15, cachedQty: 15, itemExists: true }).voucher, -15);

// With no live figure available the cache is the only baseline left (degraded, not wrong-by-design)
assert.strictEqual(planAdjust({ target: 40, tallyActual: undefined, cachedQty: 34, itemExists: true }).voucher, 6);

console.log('set-stock delta arithmetic: all 8 cases pass');
