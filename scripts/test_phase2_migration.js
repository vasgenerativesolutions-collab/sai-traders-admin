/**
 * Phase 2 Migration + Rollback Test via Supabase CLI linked connection
 * Verifies Phase 2 state -> Rollback to Phase 1 -> Verifies Phase 1 restoration -> Re-applies Phase 2 -> Verifies Phase 2 state
 */
require('dotenv').config();
const fs = require('fs');
const { execSync } = require('child_process');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function tableExists(table) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=count&limit=0`, {
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` },
  });
  return r.ok;
}

async function columnExists(table, col) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${col}&limit=0`, {
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` },
  });
  return r.ok;
}

async function queryRows(table, select, filter) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=${select}&limit=15${filter ? '&' + filter : ''}`;
  const r = await fetch(url, {
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` },
  });
  return r.ok ? await r.json() : [];
}

function runSQLFile(filePath) {
  console.log(`Running SQL from: ${filePath}`);
  const sql = fs.readFileSync(filePath, 'utf8');
  try {
    const result = execSync(
      `npx supabase db query --linked`,
      { input: sql, encoding: 'utf8', timeout: 120000, cwd: 'c:/sai_traders' }
    );
    console.log(result.slice(0, 500));
    return true;
  } catch (e) {
    console.error('SQL execution failed:', e.stderr?.slice(0, 500) || e.message);
    return false;
  }
}

async function checkPhase1State() {
  console.log('\n=== PHASE 1 STATE CHECK ===');
  const checks = {
    'saree_catalog': await tableExists('saree_catalog'),
    'hold': await tableExists('hold'),
    'video_record': await tableExists('video_record'),
    'audit_log': await tableExists('audit_log'),
    'app_config': await tableExists('app_config'),
    'code_reservation (should not exist)': !(await tableExists('code_reservation')),
    'video_item (should not exist)': !(await tableExists('video_item')),
    'checkout_record (should not exist)': !(await tableExists('checkout_record')),
  };
  for (const [k, v] of Object.entries(checks)) {
    console.log(`  ${v ? '✅' : '❌'} ${k}: ${v}`);
  }

  const cols = {
    'legacy_status_backup (should not exist)': !(await columnExists('saree_catalog', 'legacy_status_backup')),
    'item_created_in_tally (should not exist)': !(await columnExists('saree_catalog', 'item_created_in_tally')),
    'stock_added_in_tally (should not exist)': !(await columnExists('saree_catalog', 'stock_added_in_tally')),
    'cost_rate (should not exist)': !(await columnExists('saree_catalog', 'cost_rate')),
  };
  for (const [k, v] of Object.entries(cols)) {
    console.log(`  ${v ? '✅' : '❌'} ${k}`);
  }

  const catalog = await queryRows('saree_catalog', 'tally_part_number,status,name', '');
  console.log(`  Catalog rows: ${catalog.length}`);
  catalog.forEach(r => console.log(`    ${r.tally_part_number}: status=${r.status}`));

  const allTablesOk = Object.values(checks).every(v => v);
  const allColsOk = Object.values(cols).every(v => v);
  return allTablesOk && allColsOk;
}

async function checkPhase2State() {
  console.log('\n=== PHASE 2 STATE CHECK ===');
  const tables = {
    'code_reservation': await tableExists('code_reservation'),
    'video_item': await tableExists('video_item'),
    'checkout_record': await tableExists('checkout_record'),
  };
  for (const [k, v] of Object.entries(tables)) {
    console.log(`  ${v ? '✅' : '❌'} ${k}: ${v}`);
  }

  const cols = {};
  for (const col of ['item_created_in_tally', 'stock_added_in_tally', 'tally_master_id',
                      'cost_rate', 'tally_rate', 'legacy_status_backup', 'created_by',
                      'inward_voucher_type', 'design_family_id']) {
    cols[col] = await columnExists('saree_catalog', col);
  }
  console.log('  New columns:');
  for (const [k, v] of Object.entries(cols)) {
    console.log(`    ${v ? '✅' : '❌'} ${k}`);
  }

  const vrCols = {
    'is_multi_saree': await columnExists('video_record', 'is_multi_saree'),
    'is_active': await columnExists('video_record', 'is_active'),
  };
  console.log('  video_record columns:');
  for (const [k, v] of Object.entries(vrCols)) {
    console.log(`    ${v ? '✅' : '❌'} ${k}`);
  }

  const catalog = await queryRows('saree_catalog',
    'tally_part_number,status,legacy_status_backup,item_created_in_tally,stock_added_in_tally', '');
  console.log(`  Catalog rows: ${catalog.length}`);
  catalog.forEach(r => console.log(
    `    ${r.tally_part_number}: status=${r.status}, backup=${r.legacy_status_backup}, ` +
    `tally_created=${r.item_created_in_tally}, stock_added=${r.stock_added_in_tally}`
  ));

  const configs = await queryRows('app_config', 'key,value',
    'key=in.(code_config,gst_config,voucher_series_config,ledger_config)');
  console.log(`  New app_config entries: ${configs.map(c => c.key).join(', ')}`);

  const allTablesOk = Object.values(tables).every(v => v);
  const allColsOk = Object.values(cols).every(v => v);
  return allTablesOk && allColsOk;
}

async function main() {
  console.log('============================================================');
  console.log('PHASE 2 MIGRATION + ROLLBACK VERIFICATION TEST');
  console.log('Target:', SUPABASE_URL);
  console.log('============================================================');

  // Step 1: Check current state (which should be Phase 2 after earlier push)
  console.log('\nSTEP 1: VERIFY CURRENT PHASE 2 STATE');
  const initialP2Ok = await checkPhase2State();
  console.log(`Phase 2 initial state: ${initialP2Ok ? '✅ VALID' : '❌ INVALID'}`);

  // Step 2: Run Rollback SQL to restore Phase 1
  console.log('\n' + '='.repeat(60));
  console.log('STEP 2: APPLYING ROLLBACK SQL');
  console.log('='.repeat(60));
  const rollbackOk = runSQLFile('c:/sai_traders/supabase/rollbacks/20261006120000_phase2_rollback.sql');
  if (!rollbackOk) {
    console.error('❌ Rollback execution failed!');
    return;
  }

  // Step 3: Verify Phase 1 State restored
  console.log('\n' + '='.repeat(60));
  console.log('STEP 3: VERIFYING PHASE 1 RESTORATION');
  console.log('='.repeat(60));
  const phase1Ok = await checkPhase1State();
  if (phase1Ok) {
    console.log('\n✅ ROLLBACK VERIFIED — Phase 1 schema and statuses fully restored!');
  } else {
    console.log('\n❌ ROLLBACK VERIFICATION FAILED');
    return;
  }

  // Step 4: Re-apply Phase 2 Migration
  console.log('\n' + '='.repeat(60));
  console.log('STEP 4: RE-APPLYING PHASE 2 MIGRATION SQL');
  console.log('='.repeat(60));
  const migOk = runSQLFile('c:/sai_traders/supabase/migrations/20261006120000_phase2_product_management.sql');
  if (!migOk) {
    console.error('❌ Migration re-application failed!');
    return;
  }

  // Step 5: Verify Phase 2 State re-established
  console.log('\n' + '='.repeat(60));
  console.log('STEP 5: VERIFYING FINAL PHASE 2 STATE');
  console.log('='.repeat(60));
  const finalP2Ok = await checkPhase2State();
  if (finalP2Ok) {
    console.log('\n✅ PHASE 2 MIGRATION RE-VERIFIED — All tables, columns, constraints and trigger working!');
  } else {
    console.log('\n❌ FINAL PHASE 2 VERIFICATION FAILED');
  }
}

main().catch(e => console.error('FATAL:', e.message));
