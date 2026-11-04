// Self-check for get_tunnel_url.js's LAN-IP selection.
// Run: node scripts/test_tunnel_url.js
//
// The old version returned the first non-internal IPv4, which on a machine with
// Bluetooth PAN / virtual adapters is a 169.254.* APIPA address — publishing a
// lanUrl nothing on the network could reach.
const assert = require('assert');

// Mirrors getLanIp() in scripts/get_tunnel_url.js
function pick(addrs) {
  const candidates = addrs
    .filter(a => a.family === 'IPv4' && !a.internal)
    .filter(a => !/^169\.254\./.test(a.address))
    .map(a => a.address);
  const isPrivate = ip => /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  return candidates.find(isPrivate) || candidates[0] || '127.0.0.1';
}

const V4 = (address, internal = false) => ({ family: 'IPv4', address, internal });

// The real adapter list from the admin laptop: four APIPA entries ahead of Wi-Fi.
// Must return the Wi-Fi address, not the first one enumerated.
assert.strictEqual(pick([
  V4('127.0.0.1', true),
  V4('169.254.218.190'),
  V4('169.254.30.187'),
  V4('169.254.132.184'),
  V4('169.254.245.17'),
  V4('192.168.1.7'),
]), '192.168.1.7');

// All three RFC1918 ranges are accepted
assert.strictEqual(pick([V4('10.0.0.5')]), '10.0.0.5');
assert.strictEqual(pick([V4('172.16.4.4')]), '172.16.4.4');

// 172.32.x is NOT private (range ends at 172.31) — kept only as last resort
assert.strictEqual(pick([V4('172.32.0.1')]), '172.32.0.1');
// ...but a real private address wins over it regardless of order
assert.strictEqual(pick([V4('172.32.0.1'), V4('192.168.1.7')]), '192.168.1.7');

// Loopback only, or APIPA only, must not be published as a LAN URL
assert.strictEqual(pick([V4('127.0.0.1', true)]), '127.0.0.1');
assert.strictEqual(pick([V4('169.254.1.1')]), '127.0.0.1');

console.log('lan-ip selection: all 7 cases pass');
