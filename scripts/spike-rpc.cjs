'use strict';
/*
 * Phase 0 transport spike for the pi RPC UI design.
 *
 * Boots AgentVM with a test workspace mounted at /workspace, seeds the guest
 * RPC bridge, opens an AgentVM port forward, drives `pi --mode rpc` over a host
 * TCP socket, and runs a real prompt end to end.
 *
 *   node scripts/spike-rpc.cjs
 *
 * Env knobs:
 *   SPIKE_WS          host workspace dir (default ~/pi-box-rpc-spike)
 *   SPIKE_GUEST_PORT  guest port for the bridge (default 7199)
 *   SPIKE_VM_STDOUT=1 mirror the VM console to stderr
 *   SPIKE_PROMPT      prompt text
 */

const { AgentVM } = require('deepclause-agentvm');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');

const HOME = os.homedir();
const REPO = path.resolve(__dirname, '..');
const WS = process.env.SPIKE_WS || path.join(HOME, 'pi-box-rpc-spike');
const GLOBAL_PI = path.join(HOME, '.pi', 'agent');
const MOUNT = '/workspace';
const GUEST_PORT = Number(process.env.SPIKE_GUEST_PORT || 7199);
const BRIDGE_SRC = path.join(REPO, 'scripts', 'pi-rpc-bridge.py');
const PROMPT = process.env.SPIKE_PROMPT || 'Reply with exactly the token RPC_OK and nothing else.';
const HARD_TIMEOUT_MS = 900000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(file)) return;
    if (Date.now() > deadline) throw new Error('timeout waiting for ' + file);
    await sleep(150);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

function connectRetry(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.connect(port, '127.0.0.1');
      const onErr = (err) => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error('connect timeout: ' + err.message));
        else setTimeout(tryOnce, 300);
      };
      sock.once('error', onErr);
      sock.once('connect', () => {
        sock.removeListener('error', onErr);
        sock.setNoDelay(true);
        resolve(sock);
      });
    };
    tryOnce();
  });
}

function prepareWorkspace() {
  fs.mkdirSync(path.join(WS, '.pi', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(WS, '.pi-box'), { recursive: true });
  for (const f of ['auth.json', 'models-store.json', 'settings.json']) {
    const src = path.join(GLOBAL_PI, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(WS, '.pi', f));
  }
  fs.copyFileSync(BRIDGE_SRC, path.join(WS, '.pi', 'pi-rpc-bridge.py'));
}

async function main() {
  prepareWorkspace();
  console.log('[spike] workspace:', WS);
  console.log('[spike] agentvm :', require('deepclause-agentvm/package.json').version);

  const vm = new AgentVM({ mounts: { [MOUNT]: WS }, network: true });
  if (process.env.SPIKE_VM_STDOUT === '1') {
    const dec = new TextDecoder();
    vm.onStdout = (d) => process.stderr.write(dec.decode(d, { stream: true }));
    vm.onStderr = (d) => process.stderr.write(dec.decode(d, { stream: true }));
  }

  const t0 = Date.now();
  await vm.start();
  console.log('[spike] vm started in %d ms', Date.now() - t0);

  const hostPort = await freePort();
  await vm.addPortForward({ hostPort, guestPort: GUEST_PORT });
  console.log('[spike] port forward 127.0.0.1:%d -> guest:%d', hostPort, GUEST_PORT);

  const logPath = `${MOUNT}/.pi-box/rpc-bridge.log`;
  const readyPath = path.join(WS, '.pi-box', 'rpc-bridge.log.ready');
  fs.rmSync(readyPath, { force: true });
  const launch =
    `nohup python3 ${MOUNT}/.pi/pi-rpc-bridge.py --port ${GUEST_PORT} --log ${logPath} --once ` +
    `>/dev/null 2>&1 &`;
  const launchRes = await vm.exec(launch);
  console.log('[spike] bridge launch exit=%d', launchRes.exitCode);

  // Wait for the guest bridge to actually bind before connecting: AgentVM's
  // port-forward listener accepts the host connection immediately, so an early
  // connect would be RST by the guest and the socket would die.
  await waitForFile(readyPath, 30000);
  console.log('[spike] guest bridge ready; connecting');
  const sock = await connectRetry(hostPort, 30000);
  console.log('[spike] host socket connected');

  // ---- JSONL framing (LF only, strip trailing CR) ----
  let buf = '';
  let reqId = 0;
  const pending = new Map();
  const waiters = [];
  const events = [];

  function waitForEvent(type, timeoutMs) {
    const found = events.find((e) => e.type === type);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitFor ' + type + ' timeout')), timeoutMs);
      waiters.push({ type, resolve: (e) => { clearTimeout(timer); resolve(e); } });
    });
  }

  function send(cmd, timeoutMs = 300000) {
    const id = 'req-' + ++reqId;
    cmd.id = id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('timeout waiting for response to ' + cmd.type));
      }, timeoutMs);
      pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); } });
      sock.write(JSON.stringify(cmd) + '\n');
    });
  }

  function onEvent(msg) {
    events.push(msg);
    switch (msg.type) {
      case 'message_update': {
        const d = msg.assistantMessageEvent || {};
        if (d.type === 'text_delta') process.stdout.write(d.delta);
        else if (d.type === 'thinking_start') process.stdout.write('\n[thinking] ');
        else if (d.type === 'thinking_delta') process.stdout.write(d.delta);
        else if (d.type === 'toolcall_start') process.stdout.write(`\n[toolcall ${d.toolName}] `);
        break;
      }
      case 'tool_execution_start':
        process.stdout.write(`\n[exec ${msg.toolName} start]\n`);
        break;
      case 'tool_execution_end':
        process.stdout.write(`[exec ${msg.toolName} ${msg.isError ? 'ERROR' : 'ok'}]\n`);
        break;
      case 'agent_start': console.log('\n[agent_start]'); break;
      case 'agent_end': console.log('[agent_end] willRetry=' + msg.willRetry); break;
      case 'agent_settled': console.log('[agent_settled]'); break;
      case 'turn_start': console.log('[turn_start]'); break;
      case 'turn_end': console.log('[turn_end]'); break;
      case 'extension_ui_request': console.log('[extension_ui_request]', JSON.stringify(msg).slice(0, 240)); break;
      case 'auto_retry_start': console.log('[auto_retry_start]', JSON.stringify(msg).slice(0, 200)); break;
      case 'auto_retry_end': console.log('[auto_retry_end]', JSON.stringify(msg).slice(0, 200)); break;
      case 'compaction_start': console.log('[compaction_start]', JSON.stringify(msg).slice(0, 200)); break;
      case 'compaction_end': console.log('[compaction_end]', JSON.stringify(msg).slice(0, 200)); break;
      default: break;
    }
    for (const w of waiters.slice()) {
      if (w.type === msg.type) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  }

  function handle(msg) {
    if (msg.type === 'response' && msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      p.resolve(msg);
      return;
    }
    if (msg.type === 'response') {
      console.log('[spike] <unmatched response>', JSON.stringify(msg).slice(0, 300));
      return;
    }
    onEvent(msg);
  }

  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    for (;;) {
      const i = buf.indexOf('\n');
      if (i < 0) break;
      let line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { console.log('[spike] bad json:', line.slice(0, 200)); continue; }
      handle(msg);
    }
  });

  console.log('[spike] pi is starting (this is the slow part, ~20-60s)...');
  const tState = Date.now();
  const state = await send({ type: 'get_state' }, 300000);
  console.log('\n[spike] get_state in %d ms: %s', Date.now() - tState, JSON.stringify(state).slice(0, 600));

  const modelsRes = await send({ type: 'get_available_models' });
  const models = modelsRes?.data?.models || [];
  console.log('[spike] available models: %d  e.g. %s', models.length,
    models.slice(0, 4).map((m) => `${m.provider}/${m.id}`).join(', '));

  if (!state.data?.model && models.length) {
    const pick = models.find((m) => m.provider === 'deepseek') || models[0];
    const r = await send({ type: 'set_model', provider: pick.provider, modelId: pick.id });
    console.log('[spike] set_model %s/%s -> success=%s', pick.provider, pick.id, r.success);
  }

  console.log('\n[spike] === prompting: %s ===', JSON.stringify(PROMPT));
  const tPrompt = Date.now();
  const promptRes = await send({ type: 'prompt', message: PROMPT });
  console.log('\n[spike] prompt response after %d ms: %s', Date.now() - tPrompt, JSON.stringify(promptRes));
  if (!promptRes.success) throw new Error('prompt rejected: ' + promptRes.error);

  const settled = await waitForEvent('agent_settled', 600000);
  console.log('\n[spike] agent_settled after %d ms', Date.now() - tPrompt);

  const last = await send({ type: 'get_last_assistant_text' });
  console.log('[spike] last assistant text: %s', JSON.stringify(last.data?.text));

  const stats = await send({ type: 'get_session_stats' });
  console.log('[spike] stats: %s', JSON.stringify({ tokens: stats.data?.tokens, cost: stats.data?.cost, contextUsage: stats.data?.contextUsage }).slice(0, 400));

  const entries = await send({ type: 'get_entries' });
  console.log('[spike] session file: %s entries=%d leaf=%s',
    state.data?.sessionFile, (entries.data?.entries || []).length, entries.data?.leafId);

  console.log('[spike] events received: %s', events.map((e) => e.type).filter((v, i, a) => a.indexOf(v) === i).join(', '));

  sock.end();
  await vm.stop();
  console.log('[spike] done in %d ms total', Date.now() - t0);
}

const hard = setTimeout(() => {
  console.error('[spike] HARD TIMEOUT');
  process.exit(2);
}, HARD_TIMEOUT_MS);
hard.unref?.();

main().catch((err) => {
  console.error('[spike] FATAL:', err && err.stack ? err.stack : err);
  process.exit(1);
});
