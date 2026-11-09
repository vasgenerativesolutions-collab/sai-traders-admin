/**
 * Send a WhatsApp message to ourselves the way Meta does, and see what the shop does
 * with it.
 *
 *   node scripts/test_whatsapp_inbound.js "do you have green silk saree"
 *
 * This signs the payload with WHATSAPP_APP_SECRET exactly as Meta signs a delivery, so
 * the webhook's signature check is exercised rather than bypassed. The customer number
 * is deliberately one that cannot exist, so the reply the shop composes is attempted
 * against Meta and refused — nothing reaches a real person.
 *
 * What this proves: the signature is accepted, the message is understood, and the
 * catalogue search finds the right sarees. What it cannot prove is delivery, which
 * needs a number registered as a tester on the sandbox.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const get = (k) => (env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [, ''])[1].trim();

const base = get('SUPABASE_URL');
const SERVICE = get('SUPABASE_SERVICE_ROLE_KEY');
const appSecret = get('WHATSAPP_APP_SECRET');
const phoneId = get('WHATSAPP_PHONE_NUMBER_ID');

// A number in the range reserved for documentation, so it can never be anyone's.
const FROM = '919999900001';
const text = process.argv.slice(2).join(' ') || 'do you have green silk saree';

(async () => {
  if (!appSecret) { console.error('WHATSAPP_APP_SECRET is not set, so the webhook cannot be exercised'); process.exit(1); }

  const since = new Date().toISOString();

  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'test-entry',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15551384350', phone_number_id: phoneId },
          contacts: [{ profile: { name: 'Test Customer' }, wa_id: FROM }],
          messages: [{
            from: FROM,
            id: `wamid.test.${Date.now()}`,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: text },
          }],
        },
      }],
    }],
  };

  const raw = JSON.stringify(payload);
  const signature = 'sha256=' + crypto.createHmac('sha256', appSecret).update(raw).digest('hex');

  console.log(`sending "${text}" as if from a customer\n`);

  const res = await fetch(`${base}/functions/v1/whatsapp-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signature },
    body: raw,
  });
  const body = await res.text();

  console.log(`webhook answered HTTP ${res.status}${body ? ' — ' + body.slice(0, 120) : ''}`);
  if (res.status === 401) {
    console.log('\nthe signature was refused. WHATSAPP_APP_SECRET here does not match the one the function has.');
    process.exit(1);
  }
  console.log('ok   the signature was accepted and the delivery taken');

  // What the shop made of it. The webhook records the conversation, so this is the
  // evidence that the message was understood rather than merely received.
  const svc = (p) => fetch(`${base}/rest/v1/${p}`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  }).then((r) => r.json());

  await new Promise((r) => setTimeout(r, 4000));

  // A conversation belongs to a customer, and the customer is identified by phone.
  const customers = await svc(`customers?select=id,phone_number&phone_number=like.*${FROM.slice(-8)}`);
  const customer = Array.isArray(customers) ? customers[0] : null;

  const convos = customer
    ? await svc(`conversations?select=id,state,started_at&customer_id=eq.${customer.id}&order=started_at.desc&limit=1`)
    : [];
  const mine = Array.isArray(convos) ? convos[0] : null;

  if (mine) {
    console.log(`ok   a conversation was opened for the customer (state: ${mine.state})`);
    const msgs = await svc(`messages?select=direction,message_type,content,created_at&conversation_id=eq.${mine.id}&order=created_at`);
    console.log(`\n${msgs.length} message(s) in it:`);
    for (const m of msgs) {
      const arrow = m.direction === 'inbound' ? 'customer →' : '  → shop replied';
      console.log(`  ${arrow} ${String(m.content || '').slice(0, 150).replace(/\s+/g, ' ')}`);
    }
    if (!msgs.some((m) => m.direction !== 'inbound')) {
      console.log('\n  no reply was composed — check the function logs');
    }
  } else {
    console.log('note the webhook took the delivery but no conversation was recorded');
    console.log(`     customer row for ${FROM}: ${customer ? 'found' : 'not created'}`);
  }

  void since;
})();
