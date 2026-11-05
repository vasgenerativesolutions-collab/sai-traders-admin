/**
 * The agent must refuse to be a second copy on the same machine.
 *
 * Not a theoretical concern: the installer starts the agent at login, so running it
 * by hand produced two agents polling the same shop. Closing the visible window left
 * the hidden one running stale code, and a published fix looked broken for an entire
 * evening. This runs the real agent and fails if it does not stand down.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const AGENT = path.join(__dirname, '..', 'agent', 'sai-agent.js');
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'sai-lock-'));
const LOCK = path.join(STATE, 'SaiAgent', 'agent.lock');

const children = [];
let stub;
process.on('exit', () => {
  for (const c of children) { try { c.kill(); } catch (_) {} }
  if (stub) { try { stub.close(); } catch (_) {} }
  try { fs.rmSync(STATE, { recursive: true, force: true }); } catch (_) {}
});

function runAgent(env) {
  return spawnSync(process.execPath, [AGENT], { encoding: 'utf8', timeout: 30000, env });
}

(async () => {
  // A cloud that accepts the connection and never answers, so the agent under test
  // stays alive holding its lock instead of dying on a refused connection.
  stub = http.createServer(() => { /* deliberately never responds */ });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const env = {
    ...process.env,
    PROGRAMDATA: STATE,
    SAI_NO_UPDATE: '1',
    SAI_SUPABASE_URL: `http://127.0.0.1:${stub.address().port}`,
  };

  // --- 1. A running agent takes the lock -----------------------------------
  const first = spawn(process.execPath, [AGENT], { env, stdio: 'ignore' });
  children.push(first);

  const deadline = Date.now() + 20000;
  while (!fs.existsSync(LOCK)) {
    assert.strictEqual(first.exitCode, null, 'the first agent exited before taking the lock');
    assert.ok(Date.now() < deadline, 'the first agent never took the lock');
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.strictEqual(JSON.parse(fs.readFileSync(LOCK, 'utf8')).pid, first.pid,
    'the lock must record the running agent');
  console.log(`ok   a running agent takes the lock (pid ${first.pid})`);

  // --- 2. A second copy stands down ----------------------------------------
  const second = runAgent(env);
  const out = (second.stdout || '') + (second.stderr || '');
  assert.match(out, /another agent is already running/i, `it did not stand down:\n${out}`);
  assert.strictEqual(second.status, 0, 'standing down is not a failure');
  console.log('ok   a second copy stands down instead of competing');

  assert.strictEqual(JSON.parse(fs.readFileSync(LOCK, 'utf8')).pid, first.pid,
    'the copy that stood down must not touch the running agent lock');
  console.log('ok   the running agent keeps its lock');

  // --- 3. A lock left by a dead agent must not lock the machine out --------
  first.kill();
  await new Promise((r) => first.on('exit', r));

  // Simulate the crash case explicitly: a lock naming a PID that is gone.
  fs.writeFileSync(LOCK, JSON.stringify({ pid: 0x7ffffffe, startedAt: '2026-01-01T00:00:00.000Z' }));
  const third = runAgent(env);
  const out3 = (third.stdout || '') + (third.stderr || '');
  assert.doesNotMatch(out3, /another agent is already running/i,
    `a stale lock must not block a restart:\n${out3}`);
  console.log('ok   a stale lock from a dead agent does not block a restart');

  // --- 4. --restart takes over from the copy already running ---------------
  const holder = spawn(process.execPath, [AGENT], { env, stdio: 'ignore' });
  children.push(holder);
  const d4 = Date.now() + 20000;
  while (!fs.existsSync(LOCK) || JSON.parse(fs.readFileSync(LOCK, 'utf8')).pid !== holder.pid) {
    assert.ok(Date.now() < d4, 'the holding agent never took the lock');
    await new Promise((r) => setTimeout(r, 50));
  }

  const taker = spawn(process.execPath, [AGENT, '--restart'], { env, stdio: 'ignore' });
  children.push(taker);
  await new Promise((r) => holder.on('exit', r));
  console.log('ok   --restart stops the copy that was already running');

  const d5 = Date.now() + 20000;
  while (!fs.existsSync(LOCK) || JSON.parse(fs.readFileSync(LOCK, 'utf8')).pid !== taker.pid) {
    assert.ok(Date.now() < d5, 'the restarting agent never took the lock over');
    await new Promise((r) => setTimeout(r, 50));
  }
  console.log('ok   the restarted agent holds the lock afterwards');

  console.log('\nall single-instance checks passed');
  process.exit(0);
})().catch((err) => { console.error('\nFAILED:', err.message); process.exit(1); });
