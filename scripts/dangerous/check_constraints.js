require('dotenv').config({path:'.env'});
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY);

async function run() {
  const moreStatuses = ['active', 'available', 'sold', 'ready', 'in_stock', 'pending', 'cancelled'];
  for (const st of moreStatuses) {
    const { error } = await sb.from('saree_catalog')
      .update({ status: st })
      .eq('id', '56cb1db7-2a6d-4aad-ae7a-d4159c9d507f');
    console.log(`Status '${st}':`, error ? `FAILED` : 'ALLOWED');
  }
  // Restore back to 'draft'
  await sb.from('saree_catalog').update({ status: 'draft', is_active: true, stock_quantity: 10 }).eq('id', '56cb1db7-2a6d-4aad-ae7a-d4159c9d507f');
}
run();
