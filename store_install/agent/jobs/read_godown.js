/**
 * Agent Job Handler: Read Godown Balances
 * Queries TallyPrime strictly for the Online Godown and returns current stock balances.
 * PHASE 1: READ ONLY — WRITES NOTHING TO TALLY.
 */

const { readGodownBalances } = require('../tally_client');

async function executeReadGodownBalances(job) {
  const godownName = job?.payload?.godown_name || 'Online';
  const balanceResult = await readGodownBalances(godownName);

  if (!balanceResult.success) {
    return {
      success: false,
      result: {
        job_id: job.id,
        type: 'read_godown_balances',
        godown: godownName,
        items: []
      },
      error: balanceResult.error
    };
  }

  const result = {
    job_id: job.id,
    type: 'read_godown_balances',
    godown: godownName,
    items: balanceResult.items,
    item_count: balanceResult.items.length,
    scanned_at: new Date().toISOString()
  };

  return {
    success: true,
    result,
    error: null
  };
}

module.exports = { executeReadGodownBalances };
