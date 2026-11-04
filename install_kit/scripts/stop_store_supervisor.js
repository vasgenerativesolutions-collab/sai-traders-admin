const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const PID_FILE = path.join(ROOT_DIR, 'supervisor.pid');

console.log('[Stop] Stopping Sai Traders Store PC Services...');

// 1. Terminate Store Supervisor process if PID is recorded
if (fs.existsSync(PID_FILE)) {
  try {
    const pid = fs.readFileSync(PID_FILE, 'utf8').trim();
    if (pid && !isNaN(pid)) {
      console.log(`[Stop] Terminating Supervisor Process (PID ${pid})...`);
      try {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
      } catch (_) {}
    }
  } catch (err) {
    console.warn(`[Stop] Warning reading PID file: ${err.message}`);
  }
  try { fs.unlinkSync(PID_FILE); } catch (_) {}
}

// 2. Terminate any lingering process on port 3000
try {
  const stdout = execSync('netstat -aon', { encoding: 'utf8' });
  for (const line of stdout.split('\n')) {
    if (line.includes(':3000') && line.includes('LISTENING')) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && !isNaN(pid)) {
        console.log(`[Stop] Terminating lingering process on port 3000 (PID ${pid})...`);
        try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch (_) {}
      }
    }
  }
} catch (_) {}

// 3. Terminate any lingering Cloudflare tunnel daemons
try {
  console.log('[Stop] Terminating Cloudflare Tunnel daemons...');
  execSync('taskkill /F /IM cloudflared.exe', { stdio: 'ignore' });
} catch (_) {}

console.log('[Stop] All store services stopped cleanly.');

