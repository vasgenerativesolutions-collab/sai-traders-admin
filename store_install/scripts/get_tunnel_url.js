const fs = require('fs');
const path = require('path');
const os = require('os');
require('dotenv').config();

// 1. Detect Local LAN IP
// Skip link-local 169.254.* (APIPA, assigned when DHCP fails) and prefer a private
// RFC1918 address. Taking the first non-internal IPv4 picked up APIPA addresses from
// Bluetooth PAN / virtual adapters and published a lanUrl nothing could reach.
function getLanIp() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const dev in ifaces) {
    for (const details of ifaces[dev]) {
      if (details.family !== 'IPv4' || details.internal) continue;
      if (/^169\.254\./.test(details.address)) continue;
      candidates.push(details.address);
    }
  }
  const isPrivate = (ip) => /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  return candidates.find(isPrivate) || candidates[0] || '127.0.0.1';
}

// Confirm a tunnel URL actually serves this store before advertising it.
// tunnel.log is append-only, so a failed cloudflared leaves older URLs in the file and
// the "last match" can be a long-dead hostname. Publishing it with a fresh timestamp
// made the gateway look healthy while every request to it failed.
async function isReachable(url, timeoutMs = 4000) {
  try {
    const res = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch (_) {
    return false;
  }
}

// 2. Poll tunnel.log for Cloudflare Public URL or check configured persistent domain
async function pollTunnelUrl(maxSeconds = 15) {
  // First check if a persistent named tunnel domain is configured in .env
  if (process.env.CLOUDFLARE_TUNNEL_DOMAIN || process.env.CLOUDFLARE_TUNNEL_URL) {
    const raw = (process.env.CLOUDFLARE_TUNNEL_DOMAIN || process.env.CLOUDFLARE_TUNNEL_URL).trim();
    return raw.startsWith('http') ? raw : `https://${raw}`;
  }

  const tunnelLogPath = path.join(process.cwd(), 'tunnel.log');
  const startTime = Date.now();
  const rejected = new Set();
  const regex = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;

  while ((Date.now() - startTime) < maxSeconds * 1000) {
    if (fs.existsSync(tunnelLogPath)) {
      try {
        const content = fs.readFileSync(tunnelLogPath, 'utf8');
        const matches = [...content.matchAll(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/g)];
        // Walk newest-first and return the first URL that actually answers. A stale
        // hostname left in the log by an earlier cloudflared run gets skipped instead
        // of being published as the active gateway.
        for (let i = matches.length - 1; i >= 0; i--) {
          const candidate = matches[i][0];
          if (rejected.has(candidate)) continue;
          if (await isReachable(candidate)) return candidate;
          rejected.add(candidate);
          console.warn('[TunnelUrl] Ignoring unreachable URL from log: ' + candidate);
        }
      } catch (_) {}
    }
    await new Promise(r => setTimeout(r, 800));
  }
  return null;
}

// 3. Publish to Supabase so Admin PC / Mobile knows the active gateway URL
async function publishGatewayUrl(publicUrl, lanUrl) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return;

  try {
    await fetch(`${supabaseUrl}/rest/v1/app_settings`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        key: 'in_store_gateway_url',
        value: JSON.stringify({
          publicUrl: publicUrl || null,
          lanUrl,
          hostname: os.hostname(),
          updatedAt: new Date().toISOString()
        }),
        updated_at: new Date().toISOString()
      })
    });
  } catch (_) {}
}

async function main() {
  const lanIp = getLanIp();
  const lanUrl = `http://${lanIp}:3000`;
  const publicUrl = await pollTunnelUrl(15);
  if (!publicUrl) {
    console.warn('[TunnelUrl] No reachable public URL — publishing lanUrl only, so consumers fall back instead of hitting a dead host.');
  }

  if (publicUrl) {
    fs.writeFileSync(path.join(process.cwd(), 'tunnel_url.txt'), publicUrl, 'utf8');
  }

  // Publish in background
  publishGatewayUrl(publicUrl, lanUrl).catch(() => {});

  console.log('\n===============================================================================');
  console.log('              ACCESS SAI TRADERS STORE FROM ANY COMPUTER / PHONE');
  console.log('===============================================================================');
  if (publicUrl) {
    console.log('\n>> WORLDWIDE PUBLIC URL (Open from any laptop, mobile, or home internet):');
    console.log('   ' + publicUrl);
  } else {
    console.log('\n>> WORLDWIDE PUBLIC URL:');
    console.log('   Cloudflare tunnel is still initializing. Check tunnel.log in a few seconds.');
  }

  console.log('\n>> LOCAL NETWORK URL (Open from any PC or phone connected to same Store Wi-Fi):');
  console.log('   ' + lanUrl);

  console.log('\n>> THIS STORE PC (Local Browser):');
  console.log('   http://localhost:3000');
  console.log('===============================================================================\n');
}

main().catch(console.error);
