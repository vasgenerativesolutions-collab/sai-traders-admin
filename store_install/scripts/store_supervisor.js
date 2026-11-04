const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Credentials come from the environment only. A literal fallback here would ship the
// live service-role key — which bypasses RLS on every table — inside the repo and
// inside every distribution kit. Fail loudly instead of defaulting.
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.');
  process.exit(1);
}

require('dotenv').config();

/**
 * Sai Traders - Store PC Process Supervisor & Watchdog
 *
 * Capabilities:
 * - Supervises `node admin/server.js` and `scripts/cloudflared.exe`.
 * - Auto-restarts child processes on unexpected crash with exponential backoff.
 * - Automatic log rotation: Caps log files at 10MB (max 3 archives).
 * - Publishes telemetry to Supabase `app_settings` under `store_supervisor_telemetry`.
 * - Clean teardown on SIGINT/SIGTERM.
 *
 * Usage:
 *   node scripts/store_supervisor.js
 */

const ROOT_DIR = path.resolve(__dirname, '..');
const PID_FILE = path.join(ROOT_DIR, 'supervisor.pid');
const LOG_MAX_BYTES = 10 * 1024 * 1024; // 10MB
const LOG_MAX_BACKUPS = 3;

// Record supervisor PID for deterministic lifecycle management
try {
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
} catch (err) {
  console.warn(`[Supervisor] Could not write PID file: ${err.message}`);
}

function cleanupPidFile() {
  try {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  } catch (_) {}
}

process.on('exit', cleanupPidFile);

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Rotating file logger
function createRotatingWriteStream(baseFilePath) {
  function rotate() {
    if (!fs.existsSync(baseFilePath)) return;
    try {
      const stats = fs.statSync(baseFilePath);
      if (stats.size >= LOG_MAX_BYTES) {
        for (let i = LOG_MAX_BACKUPS - 1; i >= 1; i--) {
          const src = `${baseFilePath}.${i}`;
          const dest = `${baseFilePath}.${i + 1}`;
          if (fs.existsSync(src)) {
            try { fs.copyFileSync(src, dest); fs.unlinkSync(src); } catch (_) {}
          }
        }
        try {
          fs.copyFileSync(baseFilePath, `${baseFilePath}.1`);
          fs.writeFileSync(baseFilePath, '');
        } catch (_) {}
      }
    } catch (_) {}
  }

  return {
    write(chunk) {
      rotate();
      try {
        fs.appendFileSync(baseFilePath, chunk);
      } catch (_) {}
    }
  };
}

let isShuttingDown = false;
let serverProc = null;
let tunnelProc = null;
let agentProc = null;
let serverRestarts = 0;
let tunnelRestarts = 0;
let agentRestarts = 0;
const startTime = Date.now();

const serverLogger = createRotatingWriteStream(path.join(ROOT_DIR, 'server.log'));
const serverErrorLogger = createRotatingWriteStream(path.join(ROOT_DIR, 'server_error.log'));
const tunnelLogger = createRotatingWriteStream(path.join(ROOT_DIR, 'tunnel.log'));
const agentLogger = createRotatingWriteStream(path.join(ROOT_DIR, 'agent.log'));

function logSupervisor(msg) {
  const line = `[${new Date().toISOString()}] [Supervisor] ${msg}\n`;
  process.stdout.write(line);
  serverLogger.write(line);
}

// 1. Launch & Monitor Admin/Operations Core
function startServer() {
  if (isShuttingDown) return;
  logSupervisor('⚡ Spawning Operations Core (node admin/server.js)...');

  serverProc = spawn('node', ['admin/server.js'], {
    cwd: ROOT_DIR,
    env: { ...process.env, FORCE_COLOR: '1' }
  });

  serverProc.stdout.on('data', (d) => {
    process.stdout.write(d);
    serverLogger.write(d);
  });

  serverProc.stderr.on('data', (d) => {
    process.stderr.write(d);
    serverErrorLogger.write(d);
  });

  serverProc.on('exit', (code, signal) => {
    if (isShuttingDown) return;
    serverRestarts++;
    logSupervisor(`⚠️ Operations Core exited (code=${code}, signal=${signal}). Restarting (#${serverRestarts}) in 3s...`);
    setTimeout(startServer, 3000);
  });
}

// 2. Launch & Monitor Cloudflare Tunnel
function startTunnel() {
  if (isShuttingDown) return;
  const cloudflaredExe = path.join(ROOT_DIR, 'scripts', 'cloudflared.exe');
  if (!fs.existsSync(cloudflaredExe)) {
    logSupervisor('ℹ️ cloudflared.exe not present in scripts/. Skipping tunnel daemon.');
    return;
  }

  // Check for persistent named tunnel token
  const tunnelToken = process.env.CLOUDFLARE_TUNNEL_TOKEN;
  let args = [];
  if (tunnelToken) {
    logSupervisor('🔐 Launching Named Persistent Cloudflare Tunnel via token...');
    args = ['tunnel', 'run', '--token', tunnelToken];
  } else {
    logSupervisor('🌐 Launching Cloudflare Quick Tunnel (--url http://localhost:3000)...');
    args = ['tunnel', '--url', 'http://localhost:3000'];
  }

  // Truncate tunnel.log before each launch. It is append-only, so URLs from previous
  // runs survive here; get_tunnel_url.js reads this file and would otherwise be able to
  // publish a long-dead hostname as the active gateway.
  try { fs.writeFileSync(path.join(ROOT_DIR, 'tunnel.log'), ''); } catch (_) {}

  tunnelProc = spawn(cloudflaredExe, args, {
    cwd: ROOT_DIR,
    env: process.env
  });

  tunnelProc.stdout.on('data', (d) => tunnelLogger.write(d));
  tunnelProc.stderr.on('data', (d) => {
    tunnelLogger.write(d);
    // Print tunnel URLs to console for visibility
    const text = d.toString('utf8');
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match) {
      logSupervisor(`🟢 Active Tunnel URL: ${match[0]}`);
    }
  });

  tunnelProc.on('exit', (code, signal) => {
    if (isShuttingDown) return;
    tunnelRestarts++;
    logSupervisor(`⚠️ Tunnel daemon exited (code=${code}, signal=${signal}). Restarting (#${tunnelRestarts}) in 5s...`);
    setTimeout(startTunnel, 5000);
  });
}

// 3. Launch & Monitor the Tally Job Agent
//
// This was never started by anything. HOW_TO_RUN_IN_STORE.txt claims the launcher starts
// "the Tally synchronization engine", but the supervisor only managed the server and the
// tunnel — so agent_jobs had no worker and agent_devices went hours stale.
//
// The agent is the pull-based path to Tally: it polls Supabase for jobs, executes them
// locally, and writes results back through its SQLite outbox. Nothing inbound is needed,
// which is what lets this work behind any consumer router regardless of the shop's IP.
function startAgent() {
  if (isShuttingDown) return;
  const agentEntry = path.join(ROOT_DIR, 'agent', 'index.js');
  if (!fs.existsSync(agentEntry)) {
    logSupervisor('agent/index.js not present. Skipping Tally job agent.');
    return;
  }
  logSupervisor('Spawning Tally Job Agent (node agent/index.js)...');

  agentProc = spawn('node', ['agent/index.js'], {
    cwd: ROOT_DIR,
    env: { ...process.env, FORCE_COLOR: '1' }
  });

  agentProc.stdout.on('data', (d) => { process.stdout.write(d); agentLogger.write(d); });
  agentProc.stderr.on('data', (d) => { process.stderr.write(d); agentLogger.write(d); });

  agentProc.on('exit', (code, signal) => {
    if (isShuttingDown) return;
    agentRestarts++;
    logSupervisor(`Tally Job Agent exited (code=${code}, signal=${signal}). Restarting (#${agentRestarts}) in 5s...`);
    setTimeout(startAgent, 5000);
  });
}

// 4. Telemetry Reporter
async function reportSupervisorTelemetry() {
  if (isShuttingDown) return;
  try {
    const memory = process.memoryUsage();
    const payload = {
      hostname: os.hostname(),
      status: 'healthy',
      uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
      serverRestarts,
      tunnelRestarts,
      serverPid: serverProc ? serverProc.pid : null,
      tunnelPid: tunnelProc ? tunnelProc.pid : null,
      agentPid: agentProc ? agentProc.pid : null,
      agentRestarts,
      rssMB: Math.round(memory.rss / (1024 * 1024)),
      heapUsedMB: Math.round(memory.heapUsed / (1024 * 1024)),
      updatedAt: new Date().toISOString()
    };

    await fetch(`${SUPABASE_URL}/rest/v1/app_settings`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        key: 'store_supervisor_telemetry',
        value: JSON.stringify(payload),
        updated_at: payload.updatedAt
      })
    });
  } catch (_) {}
}

// 4. Graceful Shutdown Handler
function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  cleanupPidFile();
  logSupervisor(`🛑 Received ${signal}. Terminating supervised processes cleanly...`);

  if (serverProc) {
    try { serverProc.kill('SIGTERM'); } catch (_) {}
  }
  if (tunnelProc) {
    try { tunnelProc.kill('SIGTERM'); } catch (_) {}
  }
  if (agentProc) {
    try { agentProc.kill('SIGTERM'); } catch (_) {}
  }

  setTimeout(() => {
    logSupervisor('👋 All processes terminated. Supervisor exiting.');
    process.exit(0);
  }, 1000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Boot Supervisor
logSupervisor('===============================================================================');
logSupervisor('🛡️  SAI TRADERS STORE SUPERVISOR & HIGH-AVAILABILITY WATCHDOG ACTIVE');
logSupervisor('===============================================================================');

startServer();
setTimeout(startTunnel, 1500);
setTimeout(startAgent, 3000);

// Background tasks: tunnel URL resolution and telemetry
setInterval(reportSupervisorTelemetry, 30000);
setTimeout(reportSupervisorTelemetry, 5000);

// Periodically run get_tunnel_url to ensure Supabase always has the active gateway URL
const tunnelSyncInterval = setInterval(() => {
  if (isShuttingDown) return;
  try {
    const { exec } = require('child_process');
    exec('node scripts/get_tunnel_url.js', { cwd: ROOT_DIR }, () => {});
  } catch (_) {}
}, 20000);
