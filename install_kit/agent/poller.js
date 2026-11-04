/**
 * Sai Traders Agent — Outbound Job Poller & Cloud Uplink
 * Polls cloud over HTTPS every 30-60s.
 * OUTBOUND ONLY — Opens zero listening ports.
 */

const config = require('./config');
const { getCredential } = require('./credentials');
const { saveJobResultLocally, markJobUploaded, getPendingUploads } = require('./outbox');
const { executePreflight } = require('./jobs/preflight');
const { executeReadGodownBalances } = require('./jobs/read_godown');

const AGENT_VERSION = '1.0.0-phase1';
let isPolling = false;

/**
 * Returns auth headers for agent API calls
 */
function getAgentHeaders(deviceToken, shopId) {
  return {
    'Content-Type': 'application/json',
    'x-agent-version': AGENT_VERSION,
    'x-shop-id': shopId,
    'Authorization': `Bearer ${deviceToken}`
  };
}

/**
 * Dispatches job execution to the appropriate handler
 */
async function executeJob(job) {
  console.log(`[JobRunner] 🛠️ Executing job #${job.id} (${job.type})...`);
  switch (job.type) {
    case 'preflight':
      return await executePreflight(job);
    case 'read_godown_balances':
      return await executeReadGodownBalances(job);
    default:
      return {
        success: false,
        result: null,
        error: `Unsupported job type: ${job.type}`
      };
  }
}

/**
 * Flushes any jobs stored in local SQLite outbox that failed to upload earlier
 */
async function flushPendingOutbox(supabaseUrl, headers) {
  const pending = getPendingUploads();
  if (pending.length === 0) return;

  console.log(`[Outbox] 📦 Found ${pending.length} pending local outbox records to sync...`);
  for (const row of pending) {
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/agent-api/jobs/${row.job_id}/result`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          job_id: row.job_id,
          shop_id: row.shop_id,
          result: row.result ? JSON.parse(row.result) : {},
          error: row.error,
          success: !row.error
        })
      });

      if (res.ok) {
        markJobUploaded(row.job_id);
        console.log(`[Outbox] ✓ Re-uploaded job result #${row.job_id} successfully.`);
      }
    } catch (_err) {}
  }
}

/**
 * Single poll cycle: checks for next available job from cloud
 */
async function pollNextJob() {
  if (isPolling) return;
  isPolling = true;

  try {
    const cred = getCredential();
    const shopId = cred?.shopId || '00000000-0000-0000-0000-000000000001';
    const deviceToken = cred?.deviceToken || config.supabaseServiceKey;

    if (!deviceToken) {
      console.warn('[Poller] ⚠️ Agent device is not enrolled yet. Awaiting enrollment token.');
      return;
    }

    const headers = getAgentHeaders(deviceToken, shopId);
    const apiUrl = config.supabaseUrl;

    // 1. Retry any pending uploads from SQLite outbox
    await flushPendingOutbox(apiUrl, headers);

    // 2. Poll next available job for this shop
    const pollRes = await fetch(`${apiUrl}/functions/v1/agent-api/jobs/next?shop_id=${shopId}`, {
      method: 'GET',
      headers
    });

    if (!pollRes.ok) {
      // e.g. 204 No Content or 404
      return;
    }

    const job = await pollRes.json();
    if (!job || !job.id) {
      return; // No pending job
    }

    console.log(`[Poller] 📥 Received new job #${job.id}: ${job.type}`);

    // 3. Execute job handler
    const outcome = await executeJob(job);

    // 4. Save result locally to SQLite outbox first (DURABILITY FIRST)
    saveJobResultLocally({
      jobId: job.id,
      shopId,
      jobType: job.type,
      payload: job.payload,
      result: outcome.result,
      error: outcome.error
    });

    // 5. Upload outcome to cloud
    try {
      const uploadRes = await fetch(`${apiUrl}/functions/v1/agent-api/jobs/${job.id}/result`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          job_id: job.id,
          shop_id: shopId,
          result: outcome.result,
          error: outcome.error,
          success: outcome.success
        })
      });

      if (uploadRes.ok) {
        markJobUploaded(job.id);
        console.log(`[Poller] ✅ Uploaded outcome for job #${job.id} to cloud successfully.`);
      } else {
        console.warn(`[Poller] ⚠️ Cloud returned status ${uploadRes.status} for job #${job.id}. Saved in local outbox for retry.`);
      }
    } catch (uploadErr) {
      console.warn(`[Poller] ⚠️ Network error uploading result for job #${job.id}:`, uploadErr.message);
    }

  } catch (err) {
    console.warn(`[Poller] Polling cycle warning:`, err.message);
  } finally {
    isPolling = false;
  }
}

module.exports = {
  pollNextJob,
  executeJob
};
