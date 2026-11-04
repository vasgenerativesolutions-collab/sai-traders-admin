/**
 * Sai Traders Agent — Windows Service Installer
 * Registers the agent as an automatic background service via Windows Task Scheduler.
 * Restarts on system startup with highest privileges.
 */

const { execSync } = require('child_process');
const path = require('path');

const TASK_NAME = 'SaiTradersTallyAgent';
const AGENT_PATH = path.resolve(__dirname, 'index.js');
const NODE_PATH = process.execPath;

function installService() {
  console.log('===============================================================================');
  console.log('📦 INSTALLING SAI TRADERS TALLY AGENT AS A WINDOWS SERVICE');
  console.log('===============================================================================');
  console.log(`Node Executable : ${NODE_PATH}`);
  console.log(`Agent Script    : ${AGENT_PATH}`);
  console.log(`Service Task    : ${TASK_NAME}`);
  console.log('-------------------------------------------------------------------------------');

  try {
    // Check if task exists and remove
    try {
      execSync(`schtasks /delete /tn "${TASK_NAME}" /f`, { stdio: 'pipe' });
    } catch (_e) {}

    // Register auto-start background task on system startup & user logon
    const cmd = `schtasks /create /tn "${TASK_NAME}" /tr "\\"${NODE_PATH}\\" \\"${AGENT_PATH}\\"" /sc onlogon /rl HIGHEST /f`;
    execSync(cmd, { stdio: 'inherit' });

    console.log(`\n✅ Successfully registered "${TASK_NAME}" in Windows Task Scheduler!`);
    console.log('   The agent will run silently in the background on every system boot/login.');
    console.log('\nTo start the service right now, run:');
    console.log(`   schtasks /run /tn "${TASK_NAME}"\n`);
  } catch (err) {
    console.error('❌ Service installation failed:', err.message);
  }
}

installService();
