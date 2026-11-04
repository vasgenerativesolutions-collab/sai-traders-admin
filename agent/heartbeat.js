/**
 * Sai Traders Agent — Periodic Heartbeat Reporter
 * Emits heartbeat every 60s with local health telemetry.
 * OUTBOUND ONLY.
 */

const config = require('./config');
const { getCredential } = require('./credentials');
const { checkTallyHealth } = require('./tally_client');

const AGENT_VERSION = '1.0.0-phase1';

async function sendHeartbeat() {
  try {
    const cred = getCredential();
    const shopId = cred?.shopId || '00000000-0000-0000-0000-000000000001';
    const deviceToken = cred?.deviceToken || config.supabaseServiceKey;

    if (!deviceToken) return;

    // Check local Tally status
    const health = await checkTallyHealth('Online');

    const payload = {
      shop_id: shopId,
      agent_version: AGENT_VERSION,
      tally_reachable: health.reachable,
      company_loaded: health.companyLoaded,
      godown_exists: health.godownExists,
      checked_at: new Date().toISOString()
    };

    const res = await fetch(`${config.supabaseUrl}/functions/v1/agent-api/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${deviceToken}`,
        'x-shop-id': shopId
      },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      const statusIcon = health.reachable && health.godownExists ? '💚' : '💛';
      console.log(`[Heartbeat] ${statusIcon} Heartbeat dispatched | Tally: ${health.reachable ? 'UP' : 'DOWN'} | Company: "${health.companyLoaded || 'None'}" | Godown Online: ${health.godownExists ? 'YES' : 'NO'}`);
    } else {
      console.warn(`[Heartbeat] Server returned status ${res.status}`);
    }
  } catch (err) {
    console.warn(`[Heartbeat] Heartbeat notice:`, err.message);
  }
}

module.exports = { sendHeartbeat };
