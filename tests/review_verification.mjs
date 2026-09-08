// Local-only audit probes. #1-5 and #15 now assert the repaired behavior.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { GameEngine, checkVictory } from '../src/engine.js';
import { createInitialState, cloneState } from '../src/state.js';
import { buildPlayerView, buildSpectatorView } from '../src/view.js';
import { Roles } from '../src/roles.js';
import { createRng } from '../src/rng.js';
import { ensureBeliefs } from '../src/ai/memory.js';
import { publicPoliceConfirmed, analyzeChatBehavior, canSeeFaction, estimateFactionCounts } from '../src/ai/analysis.js';
import { publicChatMemory } from '../src/ai/utils.js';
import { buildAiNightActions } from '../src/ai/night.js';
import { buildAiVoteActions } from '../src/ai/vote.js';
import { generateLastWords, generateNightFactionChat } from '../src/ai/chat.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const root = fileURLToPath(new URL('../', import.meta.url));
let passed = 0;
async function check(name, fn) {
  await fn();
  console.log(`CONFIRMED ${name}`);
  passed++;
}
async function localServer(fn) {
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root, env: { ...process.env, PORT: String(port), NODE_OPTIONS: '' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let output = '';
  let errors = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { errors += data; });
  const sockets = [];
  try {
    for (let i = 0; i < 100 && !output.includes('Server listening'); i++) {
      if (child.exitCode !== null) throw new Error(`Server startup failed: ${errors}`);
      await delay(25);
    }
    assert.match(output, /Server listening/);
    async function connect() {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      sockets.push(ws);
      ws.on('error', () => {});
      ws.messages = [];
      ws.on('message', (data) => ws.messages.push(JSON.parse(data.toString())));
      await once(ws, 'open');
      return ws;
    }
    await fn({ port, child, connect, errors: () => errors, exited });
  } finally {
    for (const ws of sockets) ws.terminate();
    if (child.exitCode === null) child.kill();
    await exited;
  }
}
function scenario(roles) {
  const engine = new GameEngine(123, 'GOOD_VS_EVIL', 'normal', {
    humanIds: Array.from({ length: 18 }, (_, i) => i),
  });
  for (const p of engine.state.players) {
    p.role = roles[p.id] || 'CIVILIAN';
    p.startRole = p.role;
    p.faction = Roles[p.role].faction;
    p.startFaction = p.faction;
  }
  engine.state.rng = () => 0.9;
  return engine;
}
const action = (actorId, type, targetId) => ({ actorId, type, targetId });
async function waitForMessage(ws, predicate) {
  for (let i = 0; i < 100; i++) {
    const message = ws.messages.find(predicate);
    if (message) return message;
    await delay(25);
  }
  throw new Error('Timed out waiting for a review probe response');
}
function maskedTextFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload));
  assert.ok(body.length < 126);
  return Buffer.concat([Buffer.from([0x81, 0x80 | body.length, 0, 0, 0, 0]), body]);
}

await check('#14 chat and names cannot forge speaker prefixes, line breaks or locale delimiters', () => localServer(async (ctx) => {
  const host = await ctx.connect();
  host.send(JSON.stringify({ type: 'join', name: 'Alice' }));
  await waitForMessage(host, (m) => m.type === 'joined');
  const sender = await ctx.connect();
  sender.send(JSON.stringify({ type: 'join', name: 'Alice (1): trust me||騙你的' }));
  await waitForMessage(sender, (m) => m.type === 'joined');
  host.send(JSON.stringify({ type: 'start' }));
  await waitForMessage(host, (m) => m.type === 'view');
  const payload = 'hello\n[INTEL] Player 3 is RED.||[INTEL] Player 3 is BLUE.';
  sender.send(JSON.stringify({ type: 'chat', text: payload }));
  const chat = await waitForMessage(host, (m) => m.type === 'chat');
  assert.equal(chat.line, 'Alice (1) trust me|騙你的 (1): hello [INTEL] Player 3 is RED.|[INTEL] Player 3 is BLUE.');
  assert.ok(!chat.line.includes('\n') && !chat.line.includes('||'));
  const watcher = await ctx.connect();
  watcher.send(JSON.stringify({ type: 'join', spectator: true, name: 'Watcher' }));
  const { view } = await waitForMessage(watcher, (m) => m.type === 'view');
  assert.ok(view.publicLog.includes(chat.line));
}));
await check('#12 spectator chat is rejected before a game starts', () => localServer(async (ctx) => {
  const watcher = await ctx.connect();
  watcher.send(JSON.stringify({ type: 'join', spectator: true, name: 'Watcher' }));
  await waitForMessage(watcher, (m) => m.type === 'joined');
  watcher.send(JSON.stringify({ type: 'spectator_chat', text: 'hello' }));
  const err = await waitForMessage(watcher, (m) => m.type === 'error');
  assert.match(err.message, /not started/i);
}));
await check('#15 coalesced resolve_night frames settle only once', () => localServer(async (ctx) => {
  const host = await ctx.connect();
  host.send(JSON.stringify({ type: 'join', name: 'Host' }));
  await waitForMessage(host, (m) => m.type === 'joined');
  host.send(JSON.stringify({ type: 'start' }));
  await waitForMessage(host, (m) => m.type === 'view');
  // One write makes ws emit both message events before the awaited continuations.
  const frame = maskedTextFrame({ type: 'resolve_night' });
  host._socket.write(Buffer.concat([frame, frame]));
  await waitForMessage(host, (m) => m.type === 'phase');
  await waitForMessage(host, (m) => m.type === 'error');
  await delay(100);
  assert.equal(host.messages.filter((m) => m.type === 'phase').length, 1);
  assert.ok(host.messages.some((m) => m.type === 'error' && /in progress/.test(m.message)));
}));

await check('#22 no police or killers means RED under the specified precedence', () => {
  const e = scenario({});
  assert.ok(e.state.players.every((p) => p.faction === 'BLUE'));
  assert.equal(checkVictory(e.state).winner, 'RED');
});
await check('#23 two votes out of 18 execute without an absolute majority', async () => {
  const e = scenario({ 0: 'KILLER', 1: 'POLICE' });
  await e.resolveVote(null, '', { humanVotes: { 0: 5, 1: 5 } });
  assert.equal(e.state.players[5].alive, false);
  assert.ok(e.state.publicLog.includes('Player 6 was executed by highest votes (2).'));
});
await check('#23 tied day votes execute the lower id, regardless of submission order', async () => {
  for (const targets of [[6, 5], [5, 6]]) {
    const e = scenario({ 0: 'KILLER', 1: 'POLICE' });
    await e.resolveVote(null, '', { humanVotes: { 0: targets[0], 1: targets[1] } });
    assert.equal(e.state.players[5].alive, false);
    assert.equal(e.state.players[6].alive, true);
    assert.equal(e.state.history.votes[0].tally[5], 1);
    assert.equal(e.state.history.votes[0].tally[6], 1);
  }
});
await check('#23 zero votes skip execution; majority still selects the majority log', async () => {
  const zero = scenario({ 0: 'KILLER', 1: 'POLICE' });
  await zero.resolveVote(null);
  assert.ok(zero.state.players.every((p) => p.alive));
  assert.ok(zero.state.publicLog.includes('No majority reached. Nobody was executed.'));
  const majority = scenario({ 0: 'KILLER', 1: 'POLICE' });
  await majority.resolveVote(null, '', {
    humanVotes: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, 17])),
  });
  assert.ok(majority.state.publicLog.includes('Player 18 was executed by vote (10/18).'));
});
await check('#23 killer vote without a majority of acting killers is invalid', async () => {
  const e = scenario({ 0: 'KILLER', 1: 'KILLER', 2: 'KILLER', 3: 'KILLER', 4: 'POLICE' });
  await e.resolveNight(null, { humanActions: [action(0, 'KILLER_VOTE', 6), action(1, 'KILLER_VOTE', 5)] });
  assert.equal(e.state.players[5].alive, true);
  assert.equal(e.state.players[6].alive, true);
  assert.ok(e.state.privateLogs.killer.includes('Killers failed to agree on a target.'));
  const majority = scenario({ 0: 'KILLER', 1: 'KILLER', 2: 'KILLER', 3: 'KILLER', 4: 'POLICE' });
  await majority.resolveNight(null, { humanActions: [action(0, 'KILLER_VOTE', 5), action(1, 'KILLER_VOTE', 5), action(2, 'KILLER_VOTE', 5), action(3, 'KILLER_VOTE', 6)] });
  assert.equal(majority.state.players[5].deathCause, 'KILLER_MURDER');
});
await check('#24 killers with no votes kill nobody regardless of rng', async () => {
  for (const roll of [0.1, 0.9]) {
    const e = scenario({ 3: 'KILLER', 4: 'KILLER', 5: 'POLICE' });
    e.state.rng = () => roll;
    await e.resolveNight(null);
    assert.ok(e.state.players.every((p) => p.alive));
    assert.ok(e.state.privateLogs.killer.includes('Killers failed to agree on a target.'));
  }
});
await check('#24 split police votes produce no investigation', async () => {
  const e = scenario({ 0: 'CIVILIAN', 1: 'KILLER', 2: 'POLICE', 3: 'POLICE', 4: 'POLICE' });
  await e.resolveNight(null, { humanActions: [action(2, 'POLICE_INVESTIGATE', 5), action(3, 'POLICE_INVESTIGATE', 6)] });
  assert.equal(e.state.players[2].aiMemory.investigationResults, undefined);
  assert.ok(!e.state.privateLogs.police.some((line) => line.startsWith('Investigation result:')));
  assert.ok(e.state.privateLogs.police.includes('Police could not agree on a target.'));
  const agreed = scenario({ 0: 'CIVILIAN', 1: 'KILLER', 2: 'POLICE', 3: 'POLICE', 4: 'POLICE' });
  await agreed.resolveNight(null, { humanActions: [action(2, 'POLICE_INVESTIGATE', 1), action(3, 'POLICE_INVESTIGATE', 1)] });
  assert.ok(agreed.state.privateLogs.police.some((line) => line.startsWith('Investigation result: Player 2 is RED')));
});
await check('#24 Police could not agree is reachable when no non-police target is alive', async () => {
  const e = scenario({ 0: 'POLICE', 1: 'POLICE' });
  for (const p of e.state.players) p.alive = p.id < 2;
  await e.resolveNight(null);
  assert.ok(e.state.privateLogs.police.includes('Police could not agree on a target.'));
});
await check('#25 revived brat is excluded upstream in every difficulty', async () => {
  for (const difficulty of ['easy', 'normal', 'hard', 'nightmare']) {
    for (const includeHuman of [false, true]) {
      const e = scenario({ 0: 'BRAT', 1: 'KILLER', 2: 'POLICE' });
      e.state.difficulty = difficulty;
      e.state.players[0].isHuman = includeHuman;
      e.state.players[0].status.bratRevived = true;
      e.state.players[0].status.bratRevealed = true;
      const votes = await buildAiVoteActions(e.state, null, { includeHuman });
      assert.equal(votes.some((v) => v.actorId === 0), false);
      await e.resolveVote(null, '', { includeHuman });
      assert.equal(e.state.history.votes[0].order.some((v) => v.actorId === 0), false);
    }
  }
});
await check('#26 vine death swap works on planting night but not the next night', async () => {
  for (const nextNight of [false, true]) {
    const e = scenario({ 0: 'VINE_DEMON', 2: 'SNIPER', 3: 'KILLER', 4: 'POLICE' });
    e.state.players[0].status.vineActive = true;
    // Keep police from investigating the seed target and triggering a blue-action swap.
    const investigate = action(4, 'POLICE_INVESTIGATE', 5);
    const plant = action(0, 'VINE_SEED', 1);
    const shoot = action(2, 'SNIPER_SHOT', 0);
    if (nextNight) {
      await e.resolveNight(null, { humanActions: [plant, investigate] });
      assert.equal(e.state.players[1].status.vineSeededBy, 0);
      e.state.dayNumber++;
      await e.resolveNight(null, { humanActions: [shoot, investigate] });
    } else {
      await e.resolveNight(null, { humanActions: [plant, shoot, investigate] });
    }
    assert.equal(e.state.players[0].alive, !nextNight);
    assert.equal(e.state.players[1].alive, nextNight);
    assert.equal(e.state.players[1].status.vineSeededBy, 0);
  }
});
await check('#26 vine blue-action trigger also expires after planting night', async () => {
  // Shields now resolve before seeds (#30), so use a police investigation as the blue action.
  for (const nextNight of [false, true]) {
    const e = scenario({ 0: 'VINE_DEMON', 2: 'AGENT', 3: 'KILLER', 4: 'POLICE' });
    e.state.players[0].status.vineActive = true;
    const investigateOther = action(4, 'POLICE_INVESTIGATE', 5);
    const investigateSeeded = action(4, 'POLICE_INVESTIGATE', 1);
    const plant = action(0, 'VINE_SEED', 1);
    if (nextNight) {
      await e.resolveNight(null, { humanActions: [plant, investigateOther] });
      e.state.dayNumber++;
      await e.resolveNight(null, { humanActions: [investigateSeeded] });
    } else {
      await e.resolveNight(null, { humanActions: [plant, investigateSeeded] });
    }
    assert.equal(e.state.players[1].alive, nextNight);
    assert.equal(e.state.players[4].alive, nextNight);
  }
});
await check('#27 nightmare investigation reaches the demon and nobody else', async () => {
  const e = scenario({ 0: 'NIGHTMARE_DEMON', 1: 'SNIPER', 2: 'KILLER', 3: 'POLICE' });
  await e.resolveNight(null, { humanActions: [action(0, 'NIGHTMARE_ATTACK', 1)] });
  const intel = 'Player 1 learned Player 2 is SNIPER.';
  assert.ok(e.state.privateLogs.nightmare.includes(intel));
  const view = buildPlayerView(e.state, 0);
  assert.equal(view.players[1].role, 'HIDDEN');
  assert.equal(view.privateIntel.includes(intel), true);
  assert.equal(JSON.stringify(buildPlayerView(e.state, 5)).includes(intel), false);
});

await check('#1 type:null does NOT crash', () => localServer(async (ctx) => {
  const ws = await ctx.connect();
  ws.send(JSON.stringify({ type: null }));
  await delay(100);
  assert.equal(ctx.child.exitCode, null);
  assert.equal(ws.messages.at(-1).type, 'error');
}));
for (const payload of [null, { type: 'join', name: 42 }, { type: 'spectator_chat', text: {} }]) {
  await check(`#1 rejects ${JSON.stringify(payload)} without exiting`, () => localServer(async (ctx) => {
    const ws = await ctx.connect();
    ws.send(JSON.stringify(payload));
    await waitForMessage(ws, (m) => m.type === 'error');
    assert.equal(ctx.child.exitCode, null);
    ws.send(JSON.stringify({ type: 'join', name: 'Still connected' }));
    await waitForMessage(ws, (m) => m.type === 'joined');
  }));
}
for (const [name, bytes, closeCode] of [
  ['invalid UTF-8', [0x81, 0x81, 0, 0, 0, 0, 0xff], 1007],
  ['RSV1 without extension', [0xc1, 0x80, 0, 0, 0, 0], 1002],
]) {
  await check(`#2 ${name} closes only the offending socket`, () => localServer(async (ctx) => {
    const ws = await ctx.connect();
    const closed = once(ws, 'close');
    ws._socket.write(Buffer.from(bytes));
    assert.equal((await closed)[0], closeCode);
    assert.equal(ctx.child.exitCode, null);
    const healthy = await ctx.connect();
    healthy.send(JSON.stringify({ type: 'join', name: 'Healthy' }));
    await waitForMessage(healthy, (m) => m.type === 'joined');
  }));
}
await check('#3 malformed absolute URL receives 400 without exiting', () => localServer(async (ctx) => {
  const socket = net.createConnection(ctx.port, '127.0.0.1');
  socket.on('error', () => {});
  let response = '';
  socket.on('data', (data) => { response += data; });
  try {
    await once(socket, 'connect');
    const ended = once(socket, 'end');
    socket.write('GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    await ended;
    assert.match(response, /^HTTP\/1.1 400 /);
    assert.equal(ctx.child.exitCode, null);
    const healthy = await fetch(`http://127.0.0.1:${ctx.port}/`);
    assert.equal(healthy.status, 200);
    await healthy.arrayBuffer();
  } finally { socket.destroy(); }
}));
await check('#4 oversized and fragmented messages are rejected at 16 KiB', () => localServer(async (ctx) => {
  for (const fragmented of [false, true]) {
    const ws = await ctx.connect();
    const closed = once(ws, 'close');
    if (fragmented) {
      ws.send('x'.repeat(8192), { fin: false });
      ws.send('x'.repeat(8193), { fin: true });
    } else {
      ws.send('x'.repeat(16385));
    }
    assert.equal((await closed)[0], 1009);
    assert.equal(ctx.child.exitCode, null);
  }
  const ws = await ctx.connect();
  const payload = { type: 'unknown', pad: '' };
  payload.pad = 'x'.repeat(16384 - Buffer.byteLength(JSON.stringify(payload)));
  ws.send(JSON.stringify(payload));
  assert.equal((await waitForMessage(ws, (m) => m.type === 'error')).message, 'Unknown message type.');
}));
await check('#5 non-public repository files are denied', () => localServer(async ({ port }) => {
  for (const path of ['/.git/config', '/server.js', '/training/eval_weights.js', '/tests/behavior_audit.js', '/request.md', '/README.md.bak', '/src/engine.js.bak', '/package.json', '/package-lock.json', '/node_modules/ws/index.js', '/audit/2026-09-07-verification.md', '/training/mafia_policy.onnx', '/%2e%67it/config', '/src/../server.js', '/src/%2e%2e%2fserver.js', '/src/engine.js%00', '/src/engine.js:secret', '/src/engine.js/']) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(response.status, 404, path);
    await response.arrayBuffer();
  }
}));
await check('#1 all text handlers reject non-string fields before role checks', () => localServer(async (ctx) => {
  for (const type of ['chat', 'last_words', 'spectator_chat', 'killer_chat', 'police_chat', 'grudge_chat', 'join']) {
    const ws = await ctx.connect();
    const field = type === 'join' ? 'name' : 'text';
    for (const value of [42, {}, [], true, false, null]) {
      ws.messages.length = 0;
      ws.send(JSON.stringify({ type, [field]: value }));
      const error = await waitForMessage(ws, (m) => m.type === 'error');
      assert.equal(error.message, `${field} must be a string.`);
      assert.equal(ctx.child.exitCode, null);
    }
  }
}));
await check('#1 invalid JSON and non-object envelopes leave the connection usable', () => localServer(async (ctx) => {
  const ws = await ctx.connect();
  for (const data of ['{', '42', 'true', '"hello"', '[]', '{}', '{"type":42}']) {
    ws.messages.length = 0;
    ws.send(data);
    await waitForMessage(ws, (m) => m.type === 'error');
  }
  ws.send(JSON.stringify({ type: 'join', name: 'Valid' }));
  await waitForMessage(ws, (m) => m.type === 'joined');
  assert.equal(ctx.child.exitCode, null);
}));
await check('#3/#5 valid pages, HEAD and query strings work; malformed escapes fail', () => localServer(async ({ port }) => {
  const base = `http://127.0.0.1:${port}`;
  for (const asset of ['/', '/index.html', '/multiplayer.html', '/styles.css', '/src/main.js?v=1', '/src/multi.js', '/src/%72ng.js']) {
    const response = await fetch(`${base}${asset}`);
    assert.equal(response.status, 200, asset);
    assert.ok((await response.text()).length > 0);
  }
  const head = await fetch(`${base}/src/main.js`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.match(head.headers.get('content-type'), /javascript/);
  assert.equal(await head.text(), '');
  const deniedHead = await fetch(`${base}/server.js`, { method: 'HEAD' });
  assert.equal(deniedHead.status, 404);
  assert.equal(await deniedHead.text(), '');
  for (const asset of ['/%', '/%FF', '/%E0%A4']) {
    const response = await fetch(`${base}${asset}`);
    assert.equal(response.status, 400);
    await response.arrayBuffer();
  }
  const post = await fetch(`${base}/`, { method: 'POST' });
  assert.equal(post.status, 405);
  await post.arrayBuffer();
}));
await check('#15 deferred settlement regressions and #5 browser module graph', () => localServer(async ({ port }) => {
  const child = spawn(process.execPath, [
    '--experimental-vm-modules', 'tests/server_resolution.mjs', `http://127.0.0.1:${port}`,
  ], { cwd: root, env: { ...process.env, NODE_OPTIONS: '' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const timeout = setTimeout(() => child.kill(), 15000);
  try {
    const [code] = await exited;
    assert.equal(code, 0, output);
    assert.match(output, /13 server settlement regressions passed/);
    assert.match(output, /PASS browser static module graph/);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill();
    await exited;
  }
}));
await check('#7 repeated join takes one seat and frees it on disconnect', () => localServer(async (ctx) => {
  const keeper = await ctx.connect();
  keeper.send(JSON.stringify({ type: 'join', name: 'Keeper' }));
  const repeat = await ctx.connect();
  for (let i = 0; i < 3; i++) repeat.send(JSON.stringify({ type: 'join', name: 'Repeat' }));
  await delay(250);
  assert.equal(repeat.messages.filter((m) => m.type === 'joined').length, 1);
  assert.equal(repeat.messages.filter((m) => m.type === 'error' && /already joined/i.test(m.message)).length, 2);
  assert.equal(keeper.messages.filter((m) => m.type === 'lobby').at(-1).seats.length, 2);
  const closed = once(repeat, 'close');
  repeat.close();
  await closed;
  await delay(250);
  assert.equal(keeper.messages.filter((m) => m.type === 'lobby').at(-1).seats.length, 1);
}));
await check('#9 AI-controlled actor casts exactly one vote and one night action', async () => {
  const e = scenario({ 0: 'KILLER', 1: 'POLICE' });
  e.state.players[0].isHuman = false;
  e.state.phase = 'VOTE';
  await e.resolveVote(null, '', { humanVotes: { 0: 2 } });
  assert.equal(e.state.history.votes[0].order.filter((v) => v.actorId === 0).length, 1);
  const night = scenario({ 0: 'SNIPER', 1: 'KILLER', 2: 'POLICE' });
  await night.resolveNight(null, { humanActions: [action(0, 'SNIPER_SHOT', 4), action(0, 'SNIPER_SHOT', 5)] });
  assert.equal(night.state.usage.sniperShots, 1);
  assert.equal(night.state.players[4].alive, true);
  assert.equal(night.state.players[5].alive, false);
});
await check('#8 disconnected seat is released and not re-seated on restart', () => localServer(async (ctx) => {
  const host = await ctx.connect();
  host.send(JSON.stringify({ type: 'join', name: 'Host' }));
  const guest = await ctx.connect();
  guest.send(JSON.stringify({ type: 'join', name: 'Guest' }));
  await delay(200);
  host.send(JSON.stringify({ type: 'start' }));
  await delay(200);
  const closed = once(guest, 'close');
  guest.close();
  await closed;
  await delay(100);
  host.send(JSON.stringify({ type: 'restart' }));
  host.send(JSON.stringify({ type: 'start' }));
  await delay(200);
  assert.equal(host.messages.filter((m) => m.type === 'started').at(-1).humans, 1);
  const view = host.messages.filter((m) => m.type === 'view').at(-1).view;
  assert.notEqual(view.players[1].name, 'Guest (1)');
}));
await check('#11 host who switches to spectator loses host rights', () => localServer(async (ctx) => {
  const host = await ctx.connect();
  host.send(JSON.stringify({ type: 'join', name: 'Host' }));
  const other = await ctx.connect();
  other.send(JSON.stringify({ type: 'join', name: 'Other' }));
  await delay(150);
  host.send(JSON.stringify({ type: 'join', name: 'Watcher', spectator: true }));
  host.send(JSON.stringify({ type: 'start' }));
  await delay(250);
  assert.equal(host.messages.filter((m) => m.type === 'joined').at(-1).host, false);
  assert.ok(host.messages.some((m) => m.type === 'error' && /only host/i.test(m.message)));
  assert.ok(!host.messages.some((m) => m.type === 'started'));
  assert.ok(other.messages.some((m) => m.type === 'host' && m.value === true));
  assert.equal(other.messages.filter((m) => m.type === 'lobby').at(-1).seats.length, 1);
}));
await check('#13 server rejects non-integer night and vote targets', () => localServer(async (ctx) => {
  const host = await ctx.connect();
  host.send(JSON.stringify({ type: 'join', name: 'Host' }));
  await waitForMessage(host, (m) => m.type === 'joined');
  host.send(JSON.stringify({ type: 'start' }));
  await waitForMessage(host, (m) => m.type === 'view');
  host.send(JSON.stringify({ type: 'night_action', action: { type: 'KILLER_VOTE', targetId: '3' } }));
  const err = await waitForMessage(host, (m) => m.type === 'error');
  assert.match(err.message, /invalid target/i);
  host.send(JSON.stringify({ type: 'night_action', action: { type: 'KILLER_VOTE', targetId: 3, extraTargets: ['4'] } }));
  await waitForMessage(host, (m) => m.type === 'error' && /invalid extra target/i.test(m.message));
}));
await check('#13 engine still drops string targets (server now rejects them first)', async () => {
  const e = scenario({ 0: 'SNIPER', 1: 'KILLER', 2: 'POLICE' });
  await e.resolveNight(null, { humanActions: [action(0, 'SNIPER_SHOT', '3')] });
  assert.equal(e.state.players[3].alive, true);
  assert.equal(e.state.usage.sniperShots, 0);
});
await check('#31 object-form submissions use the map key, not the payload actorId', async () => {
  const spoof = scenario({ 0: 'CIVILIAN', 1: 'SNIPER', 2: 'KILLER', 3: 'POLICE' });
  await spoof.resolveNight(null, { humanActions: { 0: action(1, 'SNIPER_SHOT', 4) } });
  assert.equal(spoof.state.players[4].alive, true);
  assert.equal(spoof.state.usage.sniperShots, 0);
  const legit = scenario({ 0: 'CIVILIAN', 1: 'SNIPER', 2: 'KILLER', 3: 'POLICE' });
  await legit.resolveNight(null, { humanActions: { 1: action(99, 'SNIPER_SHOT', 5) } });
  assert.equal(legit.state.players[5].alive, false);
  assert.equal(legit.state.usage.sniperShots, 1);
});
await check('#18 agent self-protection blocks sniper', async () => {
  const e = scenario({ 0: 'AGENT', 1: 'SNIPER', 2: 'KILLER', 3: 'POLICE' });
  await e.resolveNight(null, { humanActions: [action(0, 'AGENT_PROTECT', 0), action(1, 'SNIPER_SHOT', 0)] });
  assert.equal(e.state.players[0].alive, true);
  assert.equal(e.state.usage.agentBlocks, 1);
});
for (const attacker of ['COWBOY', 'NECROMANCER']) {
  await check(`#19 ${attacker} delayed kill is blocked by the agent shield`, async () => {
    const e = scenario({ 0: 'AGENT', 1: attacker, 3: 'KILLER', 4: 'POLICE' });
    e.state.players[1].souls = 2;
    e.state.rng = () => 0.1;
    await e.resolveNight(null, { humanActions: [action(0, 'AGENT_PROTECT', 2), action(1, attacker === 'COWBOY' ? 'COWBOY_GAMBLE' : 'NECROMANCER_CURSE', 2), action(3, 'KILLER_VOTE', 5)] });
    assert.equal(e.state.players[2].alive, true);
    assert.equal(e.state.usage.agentBlocks, 1);
    // Unprotected, the same delayed attack still lands.
    const open = scenario({ 0: 'AGENT', 1: attacker, 3: 'KILLER', 4: 'POLICE' });
    open.state.players[1].souls = 2;
    open.state.rng = () => 0.1;
    await open.resolveNight(null, { humanActions: [action(1, attacker === 'COWBOY' ? 'COWBOY_GAMBLE' : 'NECROMANCER_CURSE', 2), action(3, 'KILLER_VOTE', 5)] });
    assert.equal(open.state.players[2].alive, false);
  });
}
await check('#20 killer murder records RED as the grudge trigger faction', async () => {
  const e = scenario({ 0: 'KILLER', 1: 'GRUDGE_BEAST', 2: 'GRUDGE_BEAST', 3: 'POLICE' });
  await e.resolveNight(null, { humanActions: [action(0, 'KILLER_VOTE', 1)] });
  assert.equal(e.state.grudgeState.berserk, true);
  assert.equal(e.state.grudgeState.triggerFaction, 'RED');
  const arson = scenario({ 0: 'ARSONIST', 1: 'GRUDGE_BEAST', 2: 'GRUDGE_BEAST', 3: 'KILLER', 4: 'POLICE' });
  await arson.resolveNight(null, { humanActions: [action(0, 'ARSON_MARK', 1)] });
  await arson.resolveNight(null, { humanActions: [action(0, 'ARSON_IGNITE', 1)] });
  assert.equal(arson.state.players[1].alive, false);
  assert.equal(arson.state.grudgeState.triggerFaction, 'RED');
});
await check('#21 sniper prevents numerical red victory', () => {
  const e = scenario({ 0: 'KILLER', 1: 'KILLER', 2: 'SNIPER', 3: 'POLICE' });
  for (const p of e.state.players) p.alive = p.id < 5;
  assert.equal(checkVictory(e.state), null);
});
await check('#28 human exorcist strikes only the targets they chose', async () => {
  const e = scenario({ 0: 'EXORCIST', 1: 'KILLER', 2: 'KILLER', 3: 'POLICE' });
  e.state.players[0].maxChains = 3;
  await e.resolveNight(null, { humanActions: [action(0, 'EXORCIST_STRIKE', 1)] });
  assert.equal(e.state.players[0].status.exorcistChainsUsed, 1);
  assert.equal(e.state.players[0].exorcistMistakes, 0);
  assert.equal(e.state.players.filter((p) => !p.alive).length, 1);
});
await check('#29 kidnap forbids only the same target on consecutive nights', async () => {
  const e = scenario({ 0: 'KIDNAPPER', 1: 'KILLER' });
  for (const target of [3, 4, 3]) {
    await e.resolveNight(null, { humanActions: [action(0, 'KIDNAP', target)] });
    assert.equal(e.state.players[target].status.kidnapped, true);
  }
  await e.resolveNight(null, { humanActions: [action(0, 'KIDNAP', 3)] });
  assert.equal(e.state.players[3].status.kidnapped, false, 'A,A is rejected');
  await e.resolveNight(null);
  await e.resolveNight(null, { humanActions: [action(0, 'KIDNAP', 3)] });
  assert.equal(e.state.players[3].status.kidnapped, true, 'A,skip,A is allowed');
});
await check('#30 shield clears smoke regardless of action order', async () => {
  async function run(protectFirst) {
    const e = scenario({ 0: 'AGENT', 1: 'SNIPER', 2: 'RIOT_POLICE', 4: 'KILLER', 5: 'POLICE' });
    const protect = action(0, 'AGENT_PROTECT', 1);
    const shoot = action(1, 'SNIPER_SHOT', 3);
    await e.resolveNight(null, { humanActions: [action(2, 'RIOT_SMOKE', 1), ...(protectFirst ? [protect, shoot] : [shoot, protect])] });
    return e.state.players[3].alive;
  }
  assert.equal(await run(true), false);
  assert.equal(await run(false), false);
});
await check('#32 view exposes only the viewer\'s own ability counters', () => {
  const e = scenario({ 0: 'KILLER', 1: 'POLICE', 3: 'DOCTOR' });
  e.state.usage.doctorInjections = 3;
  const civilian = buildPlayerView(e.state, 2);
  assert.equal(civilian.usage.doctorInjections, undefined);
  assert.equal(civilian.winrateHint, undefined);
  assert.equal(buildPlayerView(e.state, 3).usage.doctorInjections, 3);
  const spectator = buildSpectatorView(e.state);
  assert.equal(spectator.winrateHint, undefined);
  assert.deepEqual(spectator.usage, {});
});
await check('#33 public log does not name the converted zombie', async () => {
  const e = scenario({ 0: 'ZOMBIE', 1: 'ZOMBIE', 2: 'KILLER', 3: 'POLICE' });
  await e.resolveNight(null, { humanActions: [action(0, 'ZOMBIE_BITE', 4), action(1, 'ZOMBIE_BITE', 4)] });
  const view = buildPlayerView(e.state, 5);
  assert.equal(view.players[4].role, 'HIDDEN');
  assert.ok(!view.publicLog.some((line) => line.includes('Player 5 was overwhelmed')));
  assert.ok(view.publicLog.some((line) => line.includes('Someone was overwhelmed and turned into a zombie')));
});
await check('#34 RNG matches the int32 reference for 6M draws', () => {
  const rng = createRng(0);
  let s = 0;
  let divergence = 0;
  for (let i = 1; i <= 6000000; i++) {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    const expected = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    if (rng() !== expected) { divergence = i; break; }
  }
  assert.equal(divergence, 0);
});
await check('#35-37 string seeds hash, clones keep rng position, unknown theme resolves', () => {
  assert.notEqual(createRng('abc')(), createRng(0)());
  assert.equal(createRng('abc')(), createRng('abc')());
  assert.equal(createRng('123')(), createRng(123)());
  assert.throws(() => createRng(null), TypeError);
  const state = createInitialState(0, 'INVALID');
  assert.equal(state.theme, 'GOOD_VS_EVIL');
  assert.equal(state.players.length, 18);
  state.rng(); state.rng();
  const clone = cloneState(state);
  assert.equal(typeof clone.rng, 'function');
  assert.equal(clone.rng(), state.rng());
});
await check('#39 non-police only see publicly claimed reds', () => {
  const state = createInitialState(1);
  state.policeConfirmed = { 1: true, 2: true };
  state.policePublicRevealedRed = 1;
  const civilianView = publicPoliceConfirmed(state, { role: 'CIVILIAN' });
  assert.equal(civilianView[1], true);
  assert.equal(civilianView[2], undefined);
  assert.equal(publicPoliceConfirmed(state, { role: 'POLICE' })[2], true);
  assert.equal(publicPoliceConfirmed({ policeConfirmed: { 2: true } }, { role: 'CIVILIAN' }), null);
});
await check('#38 red utility roles no longer exclude killers they cannot see', async () => {
  const e = scenario({ 0: 'ARSONIST', 1: 'KILLER', 2: 'CIVILIAN', 3: 'POLICE' });
  e.state.difficulty = 'hard';
  for (const p of e.state.players) p.alive = p.id <= 2;
  e.state.players[0].isHuman = false;
  e.state.players[0].aiMemory.roleProbs = { 1: { POLICE: 1 }, 2: { CIVILIAN: 1 } };
  e.state.rng = () => 0.9;
  const actions = await buildAiNightActions(e.state, {});
  const mark = actions.find((a) => a.actorId === 0 && a.type === 'ARSON_MARK');
  assert.ok(mark, 'arsonist marks someone');
  assert.equal(mark.targetId, 1, 'the (hidden) killer is chosen when beliefs say they are police');
});
await check('#41 faction visibility helper mirrors the view rules', () => {
  const e = scenario({ 0: 'KILLER', 1: 'KILLER', 2: 'SNIPER', 3: 'POLICE' });
  const [k1, k2, sniper, police, civ] = [0, 1, 2, 3, 4].map((id) => e.state.players[id]);
  assert.equal(canSeeFaction(k1, k2), true);
  assert.equal(canSeeFaction(sniper, k1), false);
  assert.equal(canSeeFaction(k1, sniper), false);
  assert.equal(canSeeFaction(police, civ), false);
  assert.equal(canSeeFaction(sniper, sniper), true);
  civ.alive = false;
  assert.equal(canSeeFaction(sniper, civ), true);
});
await check('#42 riot police headcount comes from beliefs, not true factions', () => {
  const e = scenario({ 0: 'RIOT_POLICE', 1: 'KILLER', 2: 'KILLER', 3: 'KILLER', 4: 'KILLER', 5: 'POLICE' });
  const est = estimateFactionCounts(e.state, e.state.players[0]);
  assert.ok(Math.abs(est.red - 17 * 0.3) < 1e-9);
  assert.ok(Math.abs(est.blue - (17 * 0.7 + 1)) < 1e-9);
  e.state.players[0].aiMemory.roleProbs = { 1: { KILLER: 1 } };
  const informed = estimateFactionCounts(e.state, e.state.players[0]);
  assert.ok(Math.abs(informed.red - (1 + 16 * 0.3)) < 1e-9);
});
await check('#43 private faction chat stays out of other players\' memory reads', () => {
  const e = scenario({ 0: 'KILLER', 1: 'KILLER', 2: 'POLICE' });
  e.state.difficulty = 'hard';
  e.state.players[0].isHuman = false;
  e.state.players[1].isHuman = true;
  e.state.killerChat = ['Player 2: target Player 5 tonight'];
  ensureBeliefs(e.state);
  const own = e.state.players[0].aiMemory.chatMemory;
  assert.ok(own.some((m) => m.source === 'faction' && m.speakerId === 1 && m.accusedId === 4));
  assert.ok(!publicChatMemory(e.state.players[0]).some((m) => m.source === 'faction'));
});
await check('#40 blue voter follows the public accusation, not the private police target', async () => {
  const e = scenario({ 0: 'KILLER', 1: 'POLICE' });
  e.state.players[2].isHuman = false;
  e.state.policeRevealedRed = 0;
  e.state.policePublicRevealedRed = 3;
  e.state.dayChat = ['Player 1: Player 4 is confirmed red'];
  e.state.rng = () => 0;
  const votes = await buildAiVoteActions(e.state);
  assert.equal(votes.find((v) => v.actorId === 2).targetId, 3);
});
await check('#46 grudge last words never contain undefined', () => {
  for (const roll of [0.01, 0.4, 0.6, 0.99]) {
    const e = scenario({ 0: 'GRUDGE_BEAST' });
    e.state.difficulty = 'hard';
    e.state.players[0].alive = false;
    e.state.players[0].isHuman = false;
    e.state.rng = () => roll;
    const words = generateLastWords(e.state, 0);
    assert.ok(words && !/undefined/.test(words), `roll ${roll}: ${words}`);
  }
});
await check('#45 easy/normal red attackers aim at the least suspicious player', async () => {
  const e = scenario({ 0: 'SNIPER', 1: 'KILLER', 2: 'POLICE' });
  e.state.players[0].isHuman = false;
  e.state.players[0].aiMemory.roleProbs = { 1: { KILLER: 1 }, 2: { POLICE: 1 } };
  e.state.rng = () => 0.1; // below the day-1 activation chance
  const actions = await buildAiNightActions(e.state, {});
  const shot = actions.find((a) => a.actorId === 0 && a.type === 'SNIPER_SHOT');
  assert.ok(shot, 'sniper fires');
  assert.equal(shot.targetId, 2, 'the player believed blue is chosen, not the one believed red');
});
await check('#50 killer night briefing names the target that is actually attacked', () => {
  const e = scenario({ 0: 'KILLER', 1: 'KILLER', 2: 'POLICE' });
  e.state.difficulty = 'hard';
  e.state.players[0].isHuman = false;
  e.state.players[1].isHuman = false;
  e.state.roleClaims = { 5: 'POLICE' };
  e.state.rng = () => 0.3;
  generateNightFactionChat(e.state);
  const briefing = (e.state.killerChat || []).find((l) => /Target Player \d+ tonight/.test(l));
  assert.ok(briefing, 'a first-night target line is produced');
  assert.equal(e.state._killerChatTarget, 5);
  assert.match(briefing, /Target Player 6 tonight/);
});
await check('#59 police keep voting their confirmed red against a bandwagon', async () => {
  const e = scenario({ 0: 'POLICE', 1: 'KILLER' });
  e.state.difficulty = 'hard';
  for (const p of e.state.players) p.isHuman = false;
  e.state.policeRevealedRed = 1;          // private: the police know 1 is red
  e.state.policePublicRevealedRed = 5;    // public claim everyone else piles onto
  e.state.policePublicRedIds = [5];
  e.state.rng = () => 0.1; // above the 5% random-abstain roll, below every follow/bandwagon threshold
  ensureBeliefs(e.state);
  e.state.players[0].aiMemory.suspicion[5] = 0.9; // the crowd's pick looks suspicious to the police too
  const votes = await buildAiVoteActions(e.state);
  assert.ok(votes.filter((v) => v.targetId === 5).length >= 2, 'a consensus forms on the public claim');
  assert.equal(votes.find((v) => v.actorId === 0).targetId, 1);
});
await check('#51 blue voters still follow a public reveal on later days', async () => {
  const e = scenario({ 0: 'KILLER', 1: 'POLICE' });
  e.state.players[2].isHuman = false;
  e.state.policePublicRevealedRed = 3;
  e.state.policePublicRedIds = [3];
  e.state.dayNumber = 3;
  e.state.dayChat = ['Player 8: nothing new today'];
  e.state.rng = () => 0;
  const votes = await buildAiVoteActions(e.state);
  assert.equal(votes.find((v) => v.actorId === 2).targetId, 3);
});
await check('#47 later public chat is parsed even after early faction memory', () => {
  const e = scenario({ 0: 'KILLER', 1: 'KILLER', 2: 'POLICE' });
  e.state.difficulty = 'hard';
  e.state.players[0].isHuman = false;
  e.state.killerChat = ['Player 2: kill Player 5'];
  ensureBeliefs(e.state);
  e.state.dayChat = ['Player 3: Player 6 is suspicious'];
  ensureBeliefs(e.state);
  const memory = e.state.players[0].aiMemory.chatMemory;
  assert.ok(memory.some((m) => m.source === 'faction'));
  assert.equal(memory.some((m) => m.speakerId === 2 && m.accusedId === 5), true);
  // Re-running without new lines does not duplicate entries.
  const count = memory.length;
  ensureBeliefs(e.state);
  assert.equal(e.state.players[0].aiMemory.chatMemory.length, count);
});
await check('#48 repeated belief calls are idempotent until new evidence arrives', () => {
  const state = createInitialState(1, 'GOOD_VS_EVIL', 'hard', { allAi: true });
  state.history.votes.push({ day: 1, order: [{ actorId: 1, targetId: 2 }], tally: { 2: 1 }, flips: [], mentions: {} });
  ensureBeliefs(state);
  const before = JSON.stringify(state.players[0].aiMemory.roleProbs);
  ensureBeliefs(state);
  assert.equal(JSON.stringify(state.players[0].aiMemory.roleProbs), before);
  state.history.votes.push({ day: 2, order: [{ actorId: 1, targetId: 2 }], tally: { 2: 1 }, flips: [], mentions: {} });
  ensureBeliefs(state);
  assert.notEqual(JSON.stringify(state.players[0].aiMemory.roleProbs), before);
});
await check('#49 shared killer target ignores a dead human target', async () => {
  const e = scenario({ 0: 'KILLER', 1: 'KILLER', 2: 'POLICE' });
  e.state.players[0].isHuman = false;
  e.state.players[3].alive = false;
  const actions = await buildAiNightActions(e.state, { humanActions: { 1: action(1, 'KILLER_VOTE', 3) } });
  const vote = actions.find((a) => a.actorId === 0);
  assert.ok(vote);
  assert.notEqual(vote.targetId, 3);
  assert.equal(e.state.players[vote.targetId].alive, true);
});
await check('#52 Player 10 no longer counts as a Player 1 mention', () => {
  const state = createInitialState(1);
  state.dayChat = ['Player 2: Player 10 is suspicious', 'Player 3: Player 1 and Player 11 both'];
  const { mentionedBy } = analyzeChatBehavior(state);
  assert.deepEqual(mentionedBy[9], [1]);
  assert.deepEqual(mentionedBy[0], [2]);
  assert.deepEqual(mentionedBy[10], [2]);
  assert.equal(mentionedBy[1], undefined);
});
function runNode(args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, {
      cwd: root, windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: '' },
    }, (error, stdout, stderr) => {
      if (error && (error.killed || typeof error.code !== 'number')) return reject(error);
      resolve({ code: error?.code || 0, stdout, stderr });
    });
  });
}
const preload = (source) => ['--import', `data:text/javascript,${encodeURIComponent(source)}`];
await check('#53-55 real frontend entry preserves games and accepts replay seeds', async () => {
  const result = await runNode(['tests/frontend_regression.mjs']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Frontend regressions passed/);
});
await check('#56 successful simulation returns all requested games', async () => {
  const result = await runNode(['tests/simulate.js', '8', 'GOOD_VS_EVIL', 'hard', '--json', '--seed=12345']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).count, 8);
});
for (const failure of [
  'throw new Error("injected worker failure")',
  'process.exit(0)',
  'process.exit(7)',
  'process.exit = () => { throw new Error("injected post-result failure"); }',
]) {
  await check(`#56 worker failure rejects partial results: ${failure}`, async () => {
    const result = await runNode([
      ...preload(`import os from 'node:os';
        import { syncBuiltinESMExports } from 'node:module';
        import { isMainThread } from 'node:worker_threads';
        os.cpus = () => [{}, {}]; syncBuiltinESMExports();
        if (!isMainThread) { ${failure}; }`),
      'tests/simulate.js', '2', '--json', '--seed=12345',
    ]);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /Simulation failed:/);
    assert.equal(result.stdout.trim(), '', 'partial statistics must not be reported as success');
  });
}
for (const injectIssue of [false, true]) {
  await check(`#56-57 audit uses all AI and exits ${injectIssue ? 1 : 0} for injected findings`, async () => {
    const result = await runNode([
      ...preload(`import assert from 'node:assert/strict';
        import { GameEngine } from ${JSON.stringify(new URL('../src/engine.js', import.meta.url).href)};
        GameEngine.prototype.resolveNight = async function(action, options) {
          assert.equal(action, null);
          assert.equal(options.includeHuman, true);
          assert.ok(this.state.players.every(p => !p.isHuman));
          this.state.phase = 'DAY';
          this.state.players[0].alive = false;
          this.state.dayChat = ${injectIssue ? '[this.state.players[0].name + ": injected dead speaker"]' : '[]'};
        };
        GameEngine.prototype.resolveVote = async function(target, words, options) {
          assert.equal(options.includeHuman, true);
          this.state.phase = 'END';
        };`),
      'tests/behavior_audit.js',
    ]);
    assert.equal(result.code, injectIssue ? 1 : 0, result.stderr);
    assert.match(result.stdout, injectIssue ? /Total issues: 250/ : /No issues found/);
  });
}
await check('#58 normal installs exclude the discontinued neural runtime', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.test, 'node tests/review_verification.mjs');
  assert.equal(pkg.scripts.prestart, undefined);
  assert.equal(pkg.dependencies['onnxruntime-node'], undefined);
  assert.ok(!Object.keys(lock.packages).some((key) => key.includes('onnxruntime')));
});
console.log(`${passed} review checks passed (#1-5, #7-9, #11-15, #19-20, #23-24 night, #27-58 regression checks; other findings remain audit probes).`);
