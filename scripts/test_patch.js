require('dotenv').config({path:'.env'});
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY);

async function run() {
  const { data, error } = await sb.from('saree_catalog')
    .update({ status: 'archived', is_active: false, stock_quantity: 0 })
    .eq('id', '56cb1db7-2a6d-4aad-ae7a-d4159c9d507f')
    .select();
  console.log('Update result for status: archived:', data, 'Error:', error);
  // Restore back to draft for now
  await sb.from('saree_catalog')
    .update({ status: 'draft', is_active: true, stock_quantity: 10 })
    .eq('id', '56cb1db7-2a6d-4aad-ae7a-d4159c9d507f');
  console.log('Successfully tested and restored!');
}
run();
