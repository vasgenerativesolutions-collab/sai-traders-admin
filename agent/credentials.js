/**
 * Sai Traders Agent — Windows Credential Manager Bridge
 * Stores & retrieves device credentials securely in Windows Credential Manager
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TARGET_PREFIX = 'SaiTradersAgent';
const FALLBACK_DIR = path.resolve(__dirname, '.secure');
const FALLBACK_FILE = path.join(FALLBACK_DIR, 'device_cred.enc');

// Device local machine secret key for fallback storage when running as background service
function getMachineSecret() {
  const machineGuid = process.env.COMPUTERNAME || 'SAI_SHOP_PC';
  return crypto.createHash('sha256').update(`SAI_TRADERS_${machineGuid}`).digest();
}

/**
 * Stores device token in Windows Credential Manager via cmdkey
 */
function storeCredential(shopId, deviceToken) {
  const target = `${TARGET_PREFIX}:Shop_${shopId}`;
  try {
    // 1. Windows Credential Manager
    execSync(`cmdkey /generic:${target} /user:${shopId} /pass:${deviceToken}`, { stdio: 'pipe' });
    console.log(`[Credentials] ✓ Device credential stored in Windows Credential Manager (${target})`);
  } catch (err) {
    console.warn(`[Credentials] cmdkey notice:`, err.message);
  }

  // 2. Encrypted local backup (handles Windows Services running as LocalSystem without interactive credential vault)
  try {
    if (!fs.existsSync(FALLBACK_DIR)) {
      fs.mkdirSync(FALLBACK_DIR, { recursive: true });
    }
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', getMachineSecret(), iv);
    const data = JSON.stringify({ shopId, deviceToken, storedAt: new Date().toISOString() });
    let enc = cipher.update(data, 'utf8', 'hex');
    enc += cipher.final('hex');
    fs.writeFileSync(FALLBACK_FILE, JSON.stringify({ iv: iv.toString('hex'), data: enc }), 'utf8');
  } catch (encErr) {
    console.warn(`[Credentials] Secure backup notice:`, encErr.message);
  }
}

/**
 * Retrieves device token
 */
function getCredential(shopId) {
  // First check encrypted local fallback (fast & reliable for Windows Services)
  if (fs.existsSync(FALLBACK_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf8'));
      const decipher = crypto.createDecipheriv('aes-256-cbc', getMachineSecret(), Buffer.from(raw.iv, 'hex'));
      let dec = decipher.update(raw.data, 'hex', 'utf8');
      dec += decipher.final('utf8');
      const parsed = JSON.parse(dec);
      if (!shopId || parsed.shopId === shopId) {
        return { shopId: parsed.shopId, deviceToken: parsed.deviceToken };
      }
    } catch (_e) {}
  }

  // Check environment override if present
  if (process.env.AGENT_DEVICE_TOKEN) {
    return {
      shopId: process.env.AGENT_SHOP_ID || '00000000-0000-0000-0000-000000000001',
      deviceToken: process.env.AGENT_DEVICE_TOKEN
    };
  }

  return null;
}

/**
 * Deletes credential upon revocation
 */
function clearCredential(shopId) {
  const target = `${TARGET_PREFIX}:Shop_${shopId}`;
  try {
    execSync(`cmdkey /delete:${target}`, { stdio: 'pipe' });
  } catch (_e) {}
  try {
    if (fs.existsSync(FALLBACK_FILE)) {
      fs.unlinkSync(FALLBACK_FILE);
    }
  } catch (_e) {}
}

module.exports = {
  storeCredential,
  getCredential,
  clearCredential
};
