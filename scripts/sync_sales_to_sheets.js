/**
 * Sai Traders — Daily Sales Sync to Google Spreadsheet
 * 
 * Fetches completed orders from Supabase database and syncs them
 * directly into your Google Spreadsheet via Google Apps Script Webhook.
 * 
 * Usage:
 *   node scripts/sync_sales_to_sheets.js [options]
 * 
 * Options:
 *   --today       Sync today's sales (default)
 *   --all         Sync all-time historical orders
 *   --url=<URL>   Google Apps Script Webhook URL (or set GOOGLE_SHEET_WEBHOOK_URL in .env)
 */

const fs = require('fs');
const path = require('path');

// 1. Read environment variables from .env
function loadEnv() {
  const envPath = path.resolve(__dirname, '../.env');
  const env = {};
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
    lines.forEach(line => {
      const idx = line.indexOf('=');
      if (idx !== -1 && !line.trim().startsWith('#')) {
        env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      }
    });
  }
  return env;
}

const env = loadEnv();
const SUPABASE_URL = env.SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

// 2. Parse command line arguments
const args = process.argv.slice(2);
const isAllTime = args.includes('--all');
const urlArg = args.find(a => a.startsWith('--url='));
const webhookUrl = urlArg ? urlArg.split('=')[1].trim() : (env.GOOGLE_SHEET_WEBHOOK_URL || '');

async function fetchOrdersFromDatabase() {
  console.log('📡 Fetching orders from Supabase database...');
  
  // Build query
  let url = `${SUPABASE_URL}/rest/v1/orders?select=id,order_number,status,total_amount,payment_status,channel,items,created_at,customers(name,phone_number)&order=created_at.desc`;
  
  if (!isAllTime) {
    // Default to start of today (local IST)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const isoDate = today.toISOString();
    url += `&created_at=gte.${encodeURIComponent(isoDate)}`;
  }

  const res = await fetch(url, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`
    }
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch orders: HTTP ${res.status} - ${await res.text()}`);
  }

  return await res.json();
}

function formatOrdersForSheet(orders) {
  return orders.map(ord => {
    // Calculate total units and item list description
    let totalUnits = 0;
    let sareeList = [];

    if (Array.isArray(ord.items)) {
      ord.items.forEach(it => {
        const qty = parseInt(it.quantity || it.qty || 1, 10);
        totalUnits += qty;
        sareeList.push(`${it.name || it.title || it.sku || 'Saree'} (${qty}x)`);
      });
    }

    if (sareeList.length === 0) {
      sareeList.push('Saree Order');
      totalUnits = 1;
    }

    const d = new Date(ord.created_at);
    const dateFormatted = d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' });

    return {
      date: dateFormatted,
      orderNumber: ord.order_number || `ORD-${ord.id.slice(0, 8)}`,
      customerName: ord.customers?.name || 'Walk-in / WhatsApp Customer',
      customerPhone: ord.customers?.phone_number || '-',
      sareeItems: sareeList.join(', '),
      totalUnits: totalUnits,
      totalAmount: Number(ord.total_amount || 0),
      paymentStatus: (ord.payment_status || 'paid').toUpperCase(),
      channel: (ord.channel || 'WhatsApp').toUpperCase(),
      status: (ord.status || 'completed').toUpperCase()
    };
  });
}

async function syncToGoogleSheet() {
  console.log('===============================================================================');
  console.log('📊 SAI TRADERS — DAILY SALES TO GOOGLE SPREADSHEET SYNC');
  console.log('===============================================================================\n');

  if (!webhookUrl) {
    console.warn('⚠️ No Google Apps Script Webhook URL provided!\n');
    console.log('To connect your Google Sheet:');
    console.log('1. Open your Google Sheet -> Extensions -> Apps Script.');
    console.log('2. Paste the provided Google Apps Script code and deploy as Web App.');
    console.log('3. Run this script with:');
    console.log('   node scripts/sync_sales_to_sheets.js --url="YOUR_WEB_APP_URL"');
    console.log('   Or add GOOGLE_SHEET_WEBHOOK_URL="YOUR_WEB_APP_URL" in your .env file.\n');
    return;
  }

  const rawOrders = await fetchOrdersFromDatabase();
  console.log(`Found ${rawOrders.length} order(s) to synchronize.`);

  if (rawOrders.length === 0) {
    console.log('ℹ️ No orders found for the specified period. Nothing to sync.');
    return;
  }

  const formattedRows = formatOrdersForSheet(rawOrders);
  console.log('\nPreview of Rows to Send:');
  console.table(formattedRows.map(r => ({
    Order: r.orderNumber,
    Customer: r.customerName,
    Items: r.sareeItems.slice(0, 25) + '...',
    Units: r.totalUnits,
    Amount: `₹${r.totalAmount.toLocaleString('en-IN')}`,
    Status: r.status
  })));

  console.log(`\n🚀 Sending ${formattedRows.length} transaction(s) to Google Sheets...`);

  // POST data to Google Apps Script Webhook (follow 302 redirects)
  const postRes = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(formattedRows),
    redirect: 'follow'
  });

  const responseText = await postRes.text();
  let result;
  try {
    result = JSON.parse(responseText);
  } catch (_) {
    result = { raw: responseText };
  }

  if (postRes.ok) {
    console.log('✅ SYNC SUCCESSFUL!');
    console.log(`🎉 Google Spreadsheet updated: ${formattedRows.length} rows appended.`);
    console.log('Server Response:', result);
  } else {
    console.error(`❌ SYNC FAILED (HTTP ${postRes.status}):`, result);
  }
}

syncToGoogleSheet().catch(err => {
  console.error('❌ Sync script execution error:', err.message);
});
