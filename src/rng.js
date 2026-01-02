// Simple seeded PRNG (Mulberry32) to keep simulations deterministic.
export function createRng(seed) {
  let s = seed >>> 0;
  return function next() {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function choice(rng, list) {
  if (!list.length) return undefined;
  const idx = Math.floor(rng() * list.length);
  return list[idx];
}

export function shuffle(rng, list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}
