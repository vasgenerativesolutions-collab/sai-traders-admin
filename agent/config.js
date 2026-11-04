const fs = require('fs');
const path = require('path');

// Load environment variables from .env in project root
const envPath = path.resolve(__dirname, '..', '.env');
const env = {};

if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)?\s*$/);
    if (match) {
      let val = match[2] || '';
      val = val.trim().replace(/^["']|["']$/g, '');
      env[match[1]] = val;
    }
  });
}

module.exports = {
  supabaseUrl: env.SUPABASE_URL || 'https://aisttddxrbizoshtpdxi.supabase.co',
  supabaseServiceKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
  tallyHost: process.env.TALLY_HOST || '127.0.0.1',
  tallyPort: parseInt(process.env.TALLY_PORT || '9000', 10),
  pollIntervalMs: parseInt(process.env.SYNC_POLL_INTERVAL_MS || '3000', 10),
  stockSyncIntervalMs: parseInt(process.env.STOCK_SYNC_INTERVAL_MS || '30000', 10)
};
