/**
 * Agent Job Handler: Preflight
 * Verifies:
 * 1. Agent alive
 * 2. Tally reachable on port 9000
 * 3. Company loaded in Tally
 * 4. Online godown exists
 */

const { checkTallyHealth } = require('../tally_client');

async function executePreflight(job) {
  const godownName = job?.payload?.godown_name || 'Online';
  const health = await checkTallyHealth(godownName);

  const passed = health.reachable && Boolean(health.companyLoaded) && health.godownExists;

  const result = {
    job_id: job.id,
    type: 'preflight',
    passed,
    tally_reachable: health.reachable,
    company_loaded: health.companyLoaded,
    godown_exists: health.godownExists,
    godown_name: godownName,
    checked_at: new Date().toISOString(),
    error: health.error || (!passed ? 'Preflight checks did not satisfy all conditions' : null)
  };

  return {
    success: passed,
    result,
    error: result.error
  };
}

module.exports = { executePreflight };
