/**
 * A browser must be able to reach everything the hosted dashboard calls.
 *
 * Node ignores CORS, so every test in this project passed while the dashboard could not
 * make a single signed-in request: the function allowed only `content-type`, and a
 * browser sending `authorization` and `apikey` had its preflight refused. All anyone
 * saw was "Failed to fetch", which names no header and no endpoint.
 *
 * This sends the preflight exactly as a browser does and checks the answer permits the
 * real request.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const get = (k) => (env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [, ''])[1].trim();
const base = get('SUPABASE_URL');

// Where the dashboard is actually served from.
const ORIGIN = 'https://vasgenerativesolutions-collab.github.io';

// Every action the dashboard calls, and the headers the browser attaches to each.
const ACTIONS = [
  'set-stock', 'job-status', 'approve',
  'update-product', 'set-off-sale', 'add-video', 'attach-photo',
];
const BROWSER_HEADERS = ['authorization', 'apikey', 'content-type'];

(async () => {
  let failures = 0;

  for (const action of ACTIONS) {
    const res = await fetch(`${base}/functions/v1/agent-sync/${action}`, {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': BROWSER_HEADERS.join(','),
      },
    });

    const allowOrigin = res.headers.get('access-control-allow-origin') || '';
    const allowHeaders = (res.headers.get('access-control-allow-headers') || '').toLowerCase();
    const allowMethods = (res.headers.get('access-control-allow-methods') || '').toUpperCase();

    const missing = BROWSER_HEADERS.filter((h) => !allowHeaders.includes(h));
    const ok = res.ok
      && (allowOrigin === '*' || allowOrigin === ORIGIN)
      && allowMethods.includes('POST')
      && !missing.length;

    if (ok) {
      console.log(`ok   ${action.padEnd(16)} a browser may call it`);
    } else {
      failures++;
      console.log(`FAIL ${action.padEnd(16)} HTTP ${res.status}`);
      if (allowOrigin !== '*' && allowOrigin !== ORIGIN) console.log(`       origin ${ORIGIN} is not allowed (got "${allowOrigin}")`);
      if (!allowMethods.includes('POST')) console.log(`       POST is not allowed (got "${allowMethods}")`);
      if (missing.length) console.log(`       these headers are refused: ${missing.join(', ')}`);
    }
  }

  // Uploading a photo goes straight to storage, which is a different service with its
  // own CORS. A dashboard that cannot upload cannot list a saree.
  const storage = await fetch(`${base}/storage/v1/object/saree-catalog-images/preflight-check.png`, {
    method: 'OPTIONS',
    headers: {
      Origin: ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,apikey,content-type,x-upsert',
    },
  });
  const sAllow = (storage.headers.get('access-control-allow-headers') || '').toLowerCase();
  const sOrigin = storage.headers.get('access-control-allow-origin') || '';
  if (storage.ok && (sOrigin === '*' || sOrigin === ORIGIN) && sAllow.includes('authorization')) {
    console.log('ok   storage          a browser may upload a photo');
  } else {
    failures++;
    console.log(`FAIL storage          HTTP ${storage.status}, origin "${sOrigin}", headers "${sAllow}"`);
  }

  // And the reads the dashboard makes against PostgREST.
  const rest = await fetch(`${base}/rest/v1/saree_catalog?select=sku&limit=1`, {
    method: 'OPTIONS',
    headers: {
      Origin: ORIGIN,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization,apikey',
    },
  });
  const rAllow = (rest.headers.get('access-control-allow-headers') || '').toLowerCase();
  if (rest.ok && rAllow.includes('authorization')) {
    console.log('ok   rest             a browser may read the catalogue');
  } else {
    failures++;
    console.log(`FAIL rest             HTTP ${rest.status}, headers "${rAllow}"`);
  }

  console.log(failures ? `\n${failures} path(s) a browser cannot use` : '\nevery path the dashboard uses is reachable from a browser');
  process.exitCode = failures ? 1 : 0;
})();
