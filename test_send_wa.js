const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(path.resolve(__dirname, '.env'), 'utf-8');
const env = {};
for (const line of content.split(/\r?\n/)) {
  const t = line.trim();
  if (t && !t.startsWith('#')) {
    const eq = t.indexOf('=');
    if (eq !== -1) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
  }
}
const token = env.WHATSAPP_ACCESS_TOKEN;
const phoneId = env.WHATSAPP_PHONE_NUMBER_ID;
const to = '916363777390';

console.log('Sending test message to:', to);
fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body: '🌸 Namaste from Sai Traders! Testing WhatsApp bot connection.' }
  })
}).then(async r => {
  const data = await r.json();
  console.log('HTTP Status:', r.status);
  console.log('Response:', JSON.stringify(data, null, 2));
}).catch(console.error);
