/**
 * Sai Traders — Autonomous In-Store Tally Inventory Agent (Phase 1)
 *
 * Runs locally alongside TallyPrime on the shop's Windows PC.
 * OUTBOUND ONLY:
 *  - Opens zero listening ports.
 *  - Polls cloud over HTTPS every 30-60s.
 *  - Communicates with Tally strictly on localhost:9000 (XML over HTTP).
 *  - PHASE 1: WRITES NOTHING TO TALLY.
 *
 * Usage:
 *   node agent/index.js
 */

const config = require('./config');
const { getCredential, storeCredential } = require('./credentials');
const { sendHeartbeat } = require('./heartbeat');
const { pollNextJob } = require('./poller');
const { checkTallyHealth } = require('./tally_client');

const HEARTBEAT_INTERVAL_MS = 60 * 1000;       // Every 60s
const POLL_INTERVAL_MS = (config.pollIntervalMs && config.pollIntervalMs >= 10000) 
  ? config.pollIntervalMs 
  : 30 * 1000;                                 // Default 30s

async function startAgent() {
  console.log('===============================================================================');
  console.log('🤖 SAI TRADERS — AUTONOMOUS INVENTORY AGENT (PHASE 1: READ-ONLY)');
  console.log('===============================================================================');
  console.log(`📡 Cloud Endpoint  : ${config.supabaseUrl}`);
  console.log(`🖥️ Local Tally ERP : http://${config.tallyHost}:${config.tallyPort}`);
  console.log(`⏱️ Heartbeat Period: ${HEARTBEAT_INTERVAL_MS / 1000}s`);
  console.log(`🔄 Job Poll Period : ${POLL_INTERVAL_MS / 1000}s`);
  console.log('🔒 Security Profile: OUTBOUND ONLY (Zero Listening Ports)');
  console.log('-------------------------------------------------------------------------------');

  // Verify or bootstrap credentials
  const cred = getCredential();
  if (!cred) {
    console.log('[Auth] 🔑 No enrolled credential found in Windows Credential Manager.');
    console.log('[Auth] ℹ️ Using Service Key configuration until one-time device code is enrolled.');
    storeCredential('00000000-0000-0000-0000-000000000001', config.supabaseServiceKey);
  } else {
    console.log(`[Auth] ✓ Enrolled device credential active for Shop [${cred.shopId}]`);
  }

  // Initial Tally Health Check
  const health = await checkTallyHealth('Online');
  if (health.reachable) {
    console.log(`✅ Connected to TallyPrime! Company: "${health.companyLoaded || 'Unknown'}"`);
    console.log(`📦 "Online" Godown Status: ${health.godownExists ? '✓ Verified Present' : '⚠️ Missing (Must create Online godown in Tally)'}`);
  } else {
    console.log(`⚠️ TallyPrime is currently not running on port 9000: ${health.error || 'Connection refused'}`);
    console.log('   (Agent will continue running and automatically detect Tally once opened).');
  }

  console.log('\n🚀 AGENT ACTIVE! Emitting heartbeats & listening for cloud sync jobs...\n');

  // Initial runs
  await sendHeartbeat();
  await pollNextJob();

  // Scheduled loops
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  setInterval(pollNextJob, POLL_INTERVAL_MS);
}

// Start agent
startAgent().catch(err => {
  console.error('FATAL Agent Error:', err);
  process.exit(1);
});
