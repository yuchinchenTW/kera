// Simple seeded PRNG (Mulberry32) to keep simulations deterministic.

// FNV-1a 32-bit, for string seeds that are not plain integers.
function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function normalizeSeed(seed) {
  if (typeof seed === "number" && Number.isFinite(seed)) return seed >>> 0;
  if (typeof seed === "string") return /^\d+$/.test(seed) ? Number(seed) >>> 0 : hashSeed(seed);
  throw new TypeError("seed must be a finite number or a string");
}

// `resumeState` restores a generator at an exact position (see cloneState).
export function createRng(seed, resumeState) {
  let s = resumeState !== undefined ? resumeState >>> 0 : normalizeSeed(seed);
  const next = function next() {
    s = (s + 0x6D2B79F5) | 0; // keep the state in int32 like the reference implementation
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.getState = () => s >>> 0;
  return next;
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
