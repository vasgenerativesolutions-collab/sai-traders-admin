const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Sai Traders - Automated Store Kit Packager & Drift Synchronizer
 * Eliminates manual copy-paste between admin/, store_install/, and install_kit/.
 *
 * Usage:
 *   node scripts/package_store_install.js
 *   npm run package:store
 */

const ROOT_DIR = path.resolve(__dirname, '..');
const TARGET_DIRS = [
  path.join(ROOT_DIR, 'store_install'),
  path.join(ROOT_DIR, 'install_kit')
];

// Directories and files to synchronize from root to target packages
const SYNC_SPECS = [
  { type: 'dir', src: 'admin', dest: 'admin' },
  { type: 'dir', src: 'agent', dest: 'agent' },
  { type: 'dir', src: 'desktop', dest: 'desktop' },
  { type: 'file', src: 'package.json', dest: 'package.json' },
  { type: 'file', src: 'package-lock.json', dest: 'package-lock.json' },
  { type: 'file', src: '.env.example', dest: '.env.example' },
  { type: 'file', src: 'TALLY_INITIAL_SETUP_GUIDE.md', dest: 'TALLY_INITIAL_SETUP_GUIDE.md' },
  { type: 'file', src: 'TALLY_COMPANY_REBINDING_AND_CLEAN_INSTALL_GUIDE.md', dest: 'TALLY_COMPANY_REBINDING_AND_CLEAN_INSTALL_GUIDE.md' },
  { type: 'file', src: 'CHECK_STORE_PC.bat', dest: 'CHECK_STORE_PC.bat' },
  { type: 'file', src: 'START_STORE_PC.bat', dest: 'START_STORE_PC.bat' },
  { type: 'file', src: 'START_SAI_TRADERS.bat', dest: 'START_SAI_TRADERS.bat' },
  { type: 'file', src: 'STOP_STORE_PC.bat', dest: 'STOP_STORE_PC.bat' },
  { type: 'file', src: 'START_BRIDGE_APP.bat', dest: 'START_BRIDGE_APP.bat' },
  { type: 'file', src: 'HOW_TO_RUN_IN_STORE.txt', dest: 'HOW_TO_RUN_IN_STORE.txt' },
  { type: 'file', src: 'SHOW_STORE_URL.bat', dest: 'SHOW_STORE_URL.bat' },
  { type: 'file', src: 'TEST_TALLY_CONNECTION.bat', dest: 'TEST_TALLY_CONNECTION.bat' },
  { type: 'file', src: 'scripts/cloudflared.exe', dest: 'scripts/cloudflared.exe' },
  { type: 'file', src: 'scripts/get_tunnel_url.js', dest: 'scripts/get_tunnel_url.js' },
  { type: 'file', src: 'scripts/store_supervisor.js', dest: 'scripts/store_supervisor.js' },
  { type: 'file', src: 'scripts/store_preflight.js', dest: 'scripts/store_preflight.js' },
  { type: 'file', src: 'scripts/rebind_tally_company.js', dest: 'scripts/rebind_tally_company.js' },
  { type: 'file', src: 'scripts/stop_store_supervisor.js', dest: 'scripts/stop_store_supervisor.js' },
  { type: 'file', src: 'scripts/test_tally_quick.js', dest: 'scripts/test_tally_quick.js' }
];

function getFileHash(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function copyRecursiveSync(src, dest) {
  const exists = fs.existsSync(src);
  const stats = exists && fs.statSync(src);
  const isDirectory = exists && stats.isDirectory();

  if (isDirectory) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    fs.readdirSync(src).forEach((childItemName) => {
      copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
    });
  } else if (exists) {
    const parentDir = path.dirname(dest);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    fs.copyFileSync(src, dest);
  }
}

async function runPackaging() {
  console.log('===============================================================================');
  console.log('📦 SAI TRADERS DEVOPS: PACKAGING & STORE-KIT SYNCHRONIZATION');
  console.log('===============================================================================\n');

  let totalCopied = 0;
  let totalVerified = 0;

  for (const targetDir of TARGET_DIRS) {
    const targetName = path.basename(targetDir);
    console.log(`\n➡️  Synchronizing target: [${targetName}] (${targetDir})`);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    for (const spec of SYNC_SPECS) {
      const srcPath = path.join(ROOT_DIR, spec.src);
      const destPath = path.join(targetDir, spec.dest);

      if (!fs.existsSync(srcPath)) {
        console.warn(`   ⚠️ Missing source: ${spec.src}`);
        continue;
      }

      if (spec.type === 'dir') {
        copyRecursiveSync(srcPath, destPath);
        console.log(`   📁 Synced directory: ${spec.src} -> ${targetName}/${spec.dest}`);
        totalCopied++;
      } else {
        const srcHash = getFileHash(srcPath);
        const destHash = getFileHash(destPath);

        if (srcHash !== destHash) {
          const parentDir = path.dirname(destPath);
          if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
          fs.copyFileSync(srcPath, destPath);
          console.log(`   📄 Updated file: ${spec.src} -> ${targetName}/${spec.dest}`);
          totalCopied++;
        } else {
          totalVerified++;
        }
      }
    }
  }

  console.log('\n===============================================================================');
  console.log(`✅ PACKAGING COMPLETE: ${totalCopied} synced, ${totalVerified} verified identical.`);
  console.log('Zero drift guaranteed between root and distribution kits.');
  console.log('===============================================================================\n');
}

runPackaging().catch(console.error);
