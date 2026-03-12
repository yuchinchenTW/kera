import { GameEngine } from "../src/engine.js";
import { Phase, Theme, Roles, DeathCause, roleMeta } from "../src/roles.js";
import { alivePlayers } from "../src/state.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolveTheme(input) {
  if (!input) return { id: Theme.GOOD_VS_EVIL.id, matched: false };
  const normalized = String(input).trim().toUpperCase();
  const match = Object.values(Theme).find(
    (t) => t.id.toUpperCase() === normalized || t.name.toUpperCase() === normalized
  );
  return match ? { id: match.id, matched: true } : { id: Theme.GOOD_VS_EVIL.id, matched: false };
}

function hashSeed(i) {
  // Simple hash to spread seeds instead of clustering around Date.now()
  let h = (i * 2654435761) >>> 0;
  h = ((h ^ (h >>> 16)) * 0x45d9f3b) >>> 0;
  h = ((h ^ (h >>> 16)) * 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

const NIGHT_KILL_CAUSES = new Set([
  DeathCause.KILLER_MURDER,
  DeathCause.SNIPER_HEADSHOT,
  DeathCause.TERROR_BOMB,
  DeathCause.COWBOY_SHOT,
  DeathCause.COWBOY_BACKFIRE,
  DeathCause.KIDNAP_EXECUTION,
  DeathCause.ZOMBIE_FATAL,
  DeathCause.SMOKE_OVERDOSE,
  DeathCause.ARSON_BURN,
  DeathCause.FIEND_SHOT,
  DeathCause.EXORCIST_PETRIFY,
  DeathCause.NECROMANCER_CURSE,
  DeathCause.VINE_SWAP,
  DeathCause.NIGHTMARE_STRIKE,
  DeathCause.GRUDGE_PUNISH,
  DeathCause.AGENT_LINK,
  DeathCause.EMPTY_INJECTION,
]);

// ─── Single Game Runner ─────────────────────────────────────────────────────

function runOne(seed, theme = Theme.GOOD_VS_EVIL.id, difficulty = "normal") {
  const engine = new GameEngine(seed, theme, difficulty);
  const playerCount = engine.state.players.length;
  const startRoles = engine.state.players.map((p) => ({
    id: p.id,
    role: p.role,
    faction: p.faction,
    name: p.name,
  }));

  let safety = 200;
  while (!engine.state.victory && safety-- > 0) {
    // resolveNight internally calls startNight() which generates faction chat,
    // then resolves all night actions, then transitions to DAY phase which
    // generates dayChat + faction chat — full AI pipeline runs.
    engine.resolveNight(null, { includeHuman: true });
    if (engine.state.phase === Phase.END || engine.state.victory) break;

    // resolveVote generates AI votes (which references dayChat for chat analysis),
    // executes vote, generates last words for dead players.
    engine.resolveVote(null, "", { includeHuman: true });
  }

  const victory = engine.state.victory || { winner: "NONE", reason: "Timeout" };
  const dayNumber = engine.state.dayNumber || 1;

  // Gather per-player survival & death info
  const playerResults = engine.state.players.map((p) => ({
    id: p.id,
    role: p.role,
    faction: p.faction,
    alive: p.alive,
    deathCause: p.deathCause || null,
    nightKill: p.deathCause ? NIGHT_KILL_CAUSES.has(p.deathCause) : false,
    voteKill: p.deathCause === DeathCause.VOTE_EXECUTION,
  }));

  // Count chat lines generated (verifies chat system ran)
  const chatLines = (engine.state.dayChat || []).length;
  const publicLogLines = (engine.state.publicLog || []).length;

  return { victory, startRoles, dayNumber, playerCount, playerResults, chatLines, publicLogLines };
}

// ─── Batch Simulator ────────────────────────────────────────────────────────

function simulateGames(count = 500, theme = Theme.GOOD_VS_EVIL.id, difficulty = "normal") {
  const tally = {};
  const roleSeen = {};
  const roleWins = {};
  const roleSurvived = {};    // survived to end of game
  const roleDeathByVote = {}; // killed by vote
  const roleDeathByNight = {}; // killed at night
  const dayLengths = [];      // how many days each game lasted
  const reasonCounts = {};    // victory reasons

  const baseSeed = Date.now();

  for (let i = 0; i < count; i++) {
    const seed = baseSeed + hashSeed(i);
    const result = runOne(seed, theme, difficulty);
    const { victory, startRoles, dayNumber, playerResults } = result;

    const winner = victory.winner || "NONE";
    tally[winner] = (tally[winner] || 0) + 1;
    dayLengths.push(dayNumber);

    const reason = victory.reason || "Unknown";
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;

    // Per-role stats
    for (const pr of playerResults) {
      const { role, faction, alive, nightKill, voteKill } = pr;
      roleSeen[role] = (roleSeen[role] || 0) + 1;

      const roleCountsAsWin =
        (winner === "RED" && faction === "RED") ||
        (winner === "BLUE" && faction === "BLUE") ||
        (winner === "ZOMBIE" && role === Roles.ZOMBIE.id) ||
        (winner === "GRUDGE" && role === Roles.GRUDGE_BEAST.id);
      if (roleCountsAsWin) roleWins[role] = (roleWins[role] || 0) + 1;

      if (alive) roleSurvived[role] = (roleSurvived[role] || 0) + 1;
      if (voteKill) roleDeathByVote[role] = (roleDeathByVote[role] || 0) + 1;
      if (nightKill) roleDeathByNight[role] = (roleDeathByNight[role] || 0) + 1;
    }
  }

  return {
    tally, roleSeen, roleWins, roleSurvived,
    roleDeathByVote, roleDeathByNight,
    dayLengths, reasonCounts,
  };
}

// ─── Pretty Print ───────────────────────────────────────────────────────────

function pct(n, d) {
  if (!d) return "  0.0%";
  return (((n / d) * 100).toFixed(1) + "%").padStart(6);
}

function bar(ratio, width = 20) {
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// ─── Main ───────────────────────────────────────────────────────────────────

const count = Number(process.argv[2]) || 200;
const themeArg = process.argv[3];
const { id: theme, matched: themeMatched } = themeArg
  ? resolveTheme(themeArg)
  : { id: Theme.GOOD_VS_EVIL.id, matched: false };
const difficulty = process.argv[4] || (!themeArg || themeMatched ? "normal" : themeArg);

console.log(`\n${"═".repeat(60)}`);
console.log(`  Simulating ${count} games | theme: ${theme} | difficulty: ${difficulty}`);
console.log(`${"═".repeat(60)}\n`);

const t0 = Date.now();
const stats = simulateGames(count, theme, difficulty);
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const total = Object.values(stats.tally).reduce((a, b) => a + b, 0);

// ── Faction Win Rates ──

console.log(`  FACTION WIN RATES (${total} games, ${elapsed}s)`);
console.log(`  ${"─".repeat(50)}`);
const factionOrder = ["BLUE", "RED", "ZOMBIE", "GRUDGE", "NONE"];
for (const side of factionOrder) {
  const wins = stats.tally[side] || 0;
  if (wins === 0 && side === "NONE") continue;
  const ratio = wins / total;
  console.log(`  ${side.padEnd(8)} ${bar(ratio)} ${pct(wins, total)} (${wins})`);
}

// ── Game Length Stats ──

const days = stats.dayLengths;
const avgDays = (days.reduce((a, b) => a + b, 0) / days.length).toFixed(1);
const minDays = Math.min(...days);
const maxDays = Math.max(...days);
const medianDays = days.sort((a, b) => a - b)[Math.floor(days.length / 2)];

console.log(`\n  GAME LENGTH`);
console.log(`  ${"─".repeat(50)}`);
console.log(`  Average: ${avgDays} days | Median: ${medianDays} | Min: ${minDays} | Max: ${maxDays}`);

// Day length distribution
const dayBuckets = {};
for (const d of days) dayBuckets[d] = (dayBuckets[d] || 0) + 1;
const bucketKeys = Object.keys(dayBuckets).map(Number).sort((a, b) => a - b);
for (const d of bucketKeys) {
  const cnt = dayBuckets[d];
  const ratio = cnt / total;
  console.log(`  Day ${String(d).padStart(2)}: ${bar(ratio, 30)} ${pct(cnt, total)} (${cnt})`);
}

// ── Victory Reasons ──

if (Object.keys(stats.reasonCounts).length > 1) {
  console.log(`\n  VICTORY REASONS`);
  console.log(`  ${"─".repeat(50)}`);
  for (const [reason, cnt] of Object.entries(stats.reasonCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason.padEnd(35)} ${pct(cnt, total)} (${cnt})`);
  }
}

// ── Role Stats Table ──

console.log(`\n  ROLE STATS`);
console.log(`  ${"─".repeat(72)}`);
console.log(
  `  ${"Role".padEnd(20)} ${"Faction".padEnd(7)} ${"WinRate".padStart(7)} ${"Survive".padStart(8)} ${"NightDie".padStart(9)} ${"VoteDie".padStart(8)} ${"Seen".padStart(5)}`
);
console.log(`  ${"─".repeat(72)}`);

const roles = Object.keys(stats.roleSeen).sort((a, b) => {
  // Sort by faction then name
  const fa = roleMeta(a)?.faction || "ZZZ";
  const fb = roleMeta(b)?.faction || "ZZZ";
  if (fa !== fb) return fa < fb ? -1 : 1;
  return a < b ? -1 : 1;
});

for (const role of roles) {
  const seen = stats.roleSeen[role];
  const wins = stats.roleWins[role] || 0;
  const survived = stats.roleSurvived[role] || 0;
  const nightDied = stats.roleDeathByNight[role] || 0;
  const voteDied = stats.roleDeathByVote[role] || 0;
  const faction = roleMeta(role)?.faction || "?";
  console.log(
    `  ${role.padEnd(20)} ${faction.padEnd(7)} ${pct(wins, seen)} ${pct(survived, seen)} ${pct(nightDied, seen)} ${pct(voteDied, seen)} ${String(seen).padStart(5)}`
  );
}

// ── Difficulty Comparison Mode ──

if (process.argv.includes("--compare")) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  DIFFICULTY COMPARISON`);
  console.log(`${"═".repeat(60)}\n`);

  const difficulties = ["easy", "normal", "hard", "nightmare"];
  const compareCount = Math.min(count, 100); // Faster for comparison

  const results = {};
  for (const diff of difficulties) {
    const t1 = Date.now();
    const s = simulateGames(compareCount, theme, diff);
    const dt = ((Date.now() - t1) / 1000).toFixed(1);
    const t = Object.values(s.tally).reduce((a, b) => a + b, 0);
    const avgD = (s.dayLengths.reduce((a, b) => a + b, 0) / s.dayLengths.length).toFixed(1);
    results[diff] = { stats: s, total: t, elapsed: dt, avgDays: avgD };
  }

  console.log(`  ${"Difficulty".padEnd(12)} ${"BLUE".padStart(7)} ${"RED".padStart(7)} ${"OTHER".padStart(7)} ${"AvgDays".padStart(8)} ${"Time".padStart(6)}`);
  console.log(`  ${"─".repeat(55)}`);

  for (const diff of difficulties) {
    const r = results[diff];
    const blue = r.stats.tally["BLUE"] || 0;
    const red = r.stats.tally["RED"] || 0;
    const other = r.total - blue - red;
    console.log(
      `  ${diff.padEnd(12)} ${pct(blue, r.total)} ${pct(red, r.total)} ${pct(other, r.total)} ${r.avgDays.padStart(8)} ${(r.elapsed + "s").padStart(6)}`
    );
  }
}

console.log("");
