// Evaluate the real server with controlled timers and deferred engine calls.
// Run: node --experimental-vm-modules tests/server_resolution.mjs
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createInitialState } from '../src/state.js';
import { buildPlayerView, buildSpectatorView } from '../src/view.js';
import { Theme, Phase } from '../src/roles.js';

const serverUrl = new URL('../server.js', import.meta.url);
const source = await fs.readFile(serverUrl, 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function setup(phase = Phase.NIGHT) {
  const engines = [];
  const timers = [];
  let wss;
  class Socket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    messages = [];
    send(data) { this.messages.push(JSON.parse(data)); }
    terminate() { this.readyState = 3; this.emit('close'); }
  }
  class TestEngine {
    calls = { NIGHT: 0, VOTE: 0 };
    gates = {};
    constructor(seed, theme, difficulty, opts) {
      this.state = createInitialState(seed, theme, difficulty, opts);
      this.state.players[0].role = 'KILLER';
      this.state.players[0].faction = 'RED';
      engines.push(this);
    }
    async resolveNight(_, opts) {
      this.calls.NIGHT++;
      this.nightActions = opts.humanActions;
      if (this.gates.NIGHT) await this.gates.NIGHT.promise;
      this.state.phase = Phase.DAY;
    }
    async resolveVote() {
      this.calls.VOTE++;
      if (this.gates.VOTE) await this.gates.VOTE.promise;
      this.state.phase = Phase.NIGHT;
      this.state.dayNumber++;
    }
  }
  const addTimer = (callback, ms, interval) => {
    const timer = { callback, ms, interval, active: true };
    timers.push(timer);
    return timer;
  };
  const clear = (timer) => { if (timer) timer.active = false; };
  const context = vm.createContext({
    console: { log() {} }, process: { env: {} }, URL,
    setTimeout: (fn, ms) => addTimer(fn, ms, false), clearTimeout: clear,
    setInterval: (fn, ms) => addTimer(fn, ms, true), clearInterval: clear,
  });
  const modules = {
    'node:http': { default: { createServer: () => ({ listen: (_, cb) => cb() }) } },
    'node:fs': { promises: fs },
    'node:path': { default: path },
    'node:url': { fileURLToPath },
    ws: { default: Socket, WebSocketServer: class extends EventEmitter { constructor() { super(); wss = this; } } },
    './src/engine.js': { GameEngine: TestEngine },
    './src/view.js': { buildPlayerView, buildSpectatorView },
    './src/roles.js': { Theme, Phase },
    './src/ai/index.js': { generateNightFactionChat() {} },
  };
  const server = new vm.SourceTextModule(source, {
    context, identifier: serverUrl.href, initializeImportMeta: (meta) => { meta.url = serverUrl.href; },
  });
  await server.link((specifier) => {
    const exports = modules[specifier];
    assert.ok(exports, `Unexpected server dependency: ${specifier}`);
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await server.evaluate();
  const host = new Socket();
  wss.emit('connection', host, { socket: { remoteAddress: '127.0.0.1' } });
  const send = (payload) => host.emit('message', Buffer.from(JSON.stringify(payload)));
  const phaseMessages = () => host.messages.filter((m) => m.type === 'phase');
  const activeTimers = () => timers.filter((t) => t.active && !t.interval && t.ms >= 20000);
  const currentTimer = () => {
    assert.equal(activeTimers().length, 1);
    return activeTimers()[0];
  };
  const fire = (timer) => { timer.active = false; timer.callback(); };
  send({ type: 'join', name: 'Host' });
  send({ type: 'start' });
  await flush();
  if (phase === Phase.VOTE) {
    send({ type: 'resolve_night' });
    await flush();
    fire(currentTimer());
    await flush();
  }
  return { host, engines, send, phaseMessages, currentTimer, fire };
}

let checks = 0;
for (const phase of [Phase.NIGHT, Phase.VOTE]) {
  for (const starter of ['manual', 'timer']) {
    for (const fails of [false, true]) {
      const rig = await setup(phase);
      const engine = rig.engines[0];
      const pending = deferred();
      engine.gates[phase] = pending;
      const oldTimer = rig.currentTimer();
      const before = rig.phaseMessages().length;
      const request = { type: phase === Phase.NIGHT ? 'resolve_night' : 'resolve_vote' };
      if (starter === 'manual') rig.send(request);
      else rig.fire(oldTimer);
      rig.send(request);
      // Invoke even a cancelled callback, as if it had already been queued.
      rig.fire(oldTimer);
      assert.equal(engine.calls[phase], 1);
      assert.equal(oldTimer.active, false);
      if (fails) pending.reject(new Error('Injected asynchronous failure'));
      else pending.resolve();
      await flush();
      assert.equal(engine.calls[phase], 1);
      assert.equal(rig.phaseMessages().length, before + 1);
      assert.equal(engine.state.phase, phase === Phase.NIGHT ? Phase.DAY : Phase.NIGHT);
      assert.equal(engine.state.dayNumber, phase === Phase.NIGHT ? 1 : 2);
      assert.ok(rig.host.messages.some((m) => m.type === 'error' && /in progress/.test(m.message)));
      rig.currentTimer();
      // The lock must be released after success as well as failure.
      if (phase === Phase.NIGHT) rig.fire(rig.currentTimer());
      rig.send({ type: phase === Phase.NIGHT ? 'resolve_vote' : 'resolve_night' });
      await flush();
      assert.equal(rig.phaseMessages().length, before + (phase === Phase.NIGHT ? 3 : 2));
      console.log(`PASS settlement ${phase}, ${starter}, ${fails ? 'failure recovery' : 'success'}`);
      checks++;
    }
  }
}
for (const phase of [Phase.NIGHT, Phase.VOTE]) {
  for (const rejects of [false, true]) {
    const rig = await setup(phase);
    const oldEngine = rig.engines[0];
    const oldPending = deferred();
    oldEngine.gates[phase] = oldPending;
    rig.send({ type: phase === Phase.NIGHT ? 'resolve_night' : 'resolve_vote' });
    rig.send({ type: 'restart' });
    rig.send({ type: 'start' });
    await flush();
    const newEngine = rig.engines[1];
    const newPending = deferred();
    newEngine.gates.NIGHT = newPending;
    // Isolate the settlement test from the independent request-rate quota.
    rig.host.rateLimiter.tokens = 8;
    rig.send({ type: 'night_action', action: { type: 'KILLER_VOTE', targetId: 1 } });
    rig.send({ type: 'resolve_night' });
    const before = rig.phaseMessages().length;
    if (rejects) oldPending.reject(new Error('Stale failure'));
    else oldPending.resolve();
    await flush();
    assert.equal(rig.phaseMessages().length, before);
    assert.equal(newEngine.state.phase, Phase.NIGHT);
    rig.send({ type: 'resolve_night' });
    assert.equal(newEngine.calls.NIGHT, 1);
    newPending.resolve();
    await flush();
    assert.equal(rig.phaseMessages().length, before + 1);
    assert.equal(newEngine.nightActions[0].targetId, 1);
    assert.equal(newEngine.state.phase, Phase.DAY);
    rig.currentTimer();
    console.log(`PASS stale ${phase} ${rejects ? 'failure' : 'completion'} cannot affect a new game`);
    checks++;
  }
}
{
  const rig = await setup();
  // Input validation now rejects malformed targets up front, so inject the
  // unexpected exception from inside the engine state instead.
  const engine = rig.engines[0];
  const players = engine.state.players;
  Object.defineProperty(engine.state, 'players', {
    configurable: true, get() { throw new TypeError('Injected synchronous failure'); },
  });
  rig.send({ type: 'night_action', action: { type: 'KILLER_VOTE', targetId: 1 } });
  await flush();
  Object.defineProperty(engine.state, 'players', { configurable: true, writable: true, enumerable: true, value: players });
  assert.ok(rig.host.messages.some((m) => m.message === 'Unable to process message.'));
  rig.send({ type: 'resolve_night' });
  await flush();
  assert.equal(rig.engines[0].state.phase, Phase.DAY);
  console.log('PASS unexpected message exception is contained and later messages still work');
  checks++;
}
console.log(`${checks} server settlement regressions passed.`);

if (process.argv[2]) {
  const base = new URL(process.argv[2]);
  assert.equal(base.hostname, '127.0.0.1');
  const context = vm.createContext({});
  const modules = new Map();
  async function loadModule(url) {
    if (!modules.has(url)) {
      modules.set(url, (async () => {
        const response = await fetch(url);
        assert.equal(response.status, 200, url);
        assert.match(response.headers.get('content-type'), /javascript/);
        return new vm.SourceTextModule(await response.text(), { context, identifier: url });
      })());
    }
    return modules.get(url);
  }
  // Linking parses all static imports and validates exports without running DOM code.
  for (const entry of ['/src/main.js', '/src/multi.js']) {
    const module = await loadModule(new URL(entry, base).href);
    await module.link((specifier, parent) => {
      assert.ok(specifier.startsWith('.'), `Unexpected browser import: ${specifier}`);
      return loadModule(new URL(specifier, parent.identifier).href);
    });
  }
  assert.ok(modules.has(new URL('/training/state_encoder.js', base).href));
  console.log(`PASS browser static module graph (${modules.size} modules)`);
}
