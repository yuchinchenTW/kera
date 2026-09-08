import assert from 'node:assert/strict';
import { GameEngine } from '../src/engine.js';
import { Roles } from '../src/roles.js';

// Minimal DOM adapter: execute the real entry point and its event handlers.
class Element {
  children = [];
  value = '';
  textContent = '';
  listeners = new Map();
  classList = { toggle() {} };
  set innerHTML(value) {
    assert.equal(value, '');
    this.children = [];
    this.value = '';
  }
  appendChild(child) { this.children.push(child); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  async fire(type) { await this.listeners.get(type)?.({}); }
}

const elements = new Map();
const get = (id) => {
  if (!elements.has(id)) elements.set(id, new Element());
  return elements.get(id);
};
globalThis.document = {
  getElementById: get,
  createElement: () => new Element(),
  querySelectorAll: () => [],
  documentElement: {},
};
globalThis.window = { location: { search: '' } };

let seed = 1;
let expected;
for (; seed < 1000; seed++) {
  expected = new GameEngine(seed, 'GOOD_VS_EVIL', 'hard');
  if (expected.human().role === Roles.KILLER.id) break;
}
assert.ok(seed < 1000);
window.location.search = `?seed=${seed}`;
await import('../src/main.js');
assert.equal(get('seedDisplay').textContent, `Seed ${seed}`);
const targets = get('nightTarget').children.slice(1).map((option) => Number(option.value));
assert.deepEqual(targets, expected.state.players
  .filter((p) => p.alive && p.role !== Roles.KILLER.id && p.id !== expected.human().id)
  .map((p) => p.id));
assert.ok(expected.state.players.some((p) => p.faction === 'RED' && targets.includes(p.id)),
  'hidden red roles remain targetable');

await get('runNightBtn').fire('click');
await get('toVoteBtn').fire('click');
const phaseBefore = get('phaseDisplay').textContent;
const snapshot = () => ['seedDisplay', 'dayDisplay', 'roleDisplay', 'doctorUsage', 'sniperUsage']
  .map((id) => get(id).textContent);
const before = snapshot();
get('localeSelect').value = 'en';
await get('localeSelect').fire('change');
assert.equal(document.documentElement.lang, 'en');
assert.equal(get('phaseDisplay').textContent, 'Vote');
assert.deepEqual(snapshot(), before);
get('localeSelect').value = 'zh';
await get('localeSelect').fire('change');
assert.equal(get('phaseDisplay').textContent, phaseBefore);
assert.deepEqual(snapshot(), before);

await get('restartBtn').fire('click');
assert.equal(get('seedDisplay').textContent, `Seed ${seed}`);
assert.deepEqual(get('nightTarget').children.slice(1).map((option) => Number(option.value)), targets);
for (const valid of ['0', '12345', '1770000000000']) {
  window.location.search = `?seed=${valid}`;
  await get('restartBtn').fire('click');
  assert.equal(get('seedDisplay').textContent, `Seed ${valid}`);
}
for (const invalid of ['', '?seed=', '?seed=nope', '?seed=-1', '?seed=1.5', '?seed=9007199254740992']) {
  window.location.search = invalid;
  const start = Date.now();
  await get('restartBtn').fire('click');
  const actual = Number(get('seedDisplay').textContent.slice(5));
  assert.ok(actual >= start && actual <= Date.now(), `fallback for ${invalid}`);
}
console.log('Frontend regressions passed (#53-55).');
