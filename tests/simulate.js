import { GameEngine } from "../src/engine.js";
import { Phase, Theme, Roles, DeathCause, roleMeta } from "../src/roles.js";

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
  let h = (i * 2654435761) >>> 0;
  h = ((h ^ (h >>> 16)) * 0x45d9f3b) >>> 0;
  h = ((h ^ (h >>> 16)) * 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

const NIGHT_KILL_CAUSES = new Set([
  DeathCause.KILLER_MURDER, DeathCause.SNIPER_HEADSHOT, DeathCause.TERROR_BOMB,
  DeathCause.COWBOY_SHOT, DeathCause.COWBOY_BACKFIRE, DeathCause.KIDNAP_EXECUTION,
  DeathCause.ZOMBIE_FATAL, DeathCause.SMOKE_OVERDOSE, DeathCause.ARSON_BURN,
  DeathCause.FIEND_SHOT, DeathCause.EXORCIST_PETRIFY, DeathCause.NECROMANCER_CURSE,
  DeathCause.VINE_SWAP, DeathCause.NIGHTMARE_STRIKE, DeathCause.GRUDGE_PUNISH,
  DeathCause.AGENT_LINK, DeathCause.EMPTY_INJECTION,
]);

// ─── Single Game Runner ─────────────────────────────────────────────────────

function runOne(seed, theme = Theme.GOOD_VS_EVIL.id, difficulty = "normal") {
  const engine = new GameEngine(seed, theme, difficulty);

  let safety = 200;
  while (!engine.state.victory && safety-- > 0) {
    engine.resolveNight(null, { includeHuman: true });
    if (engine.state.phase === Phase.END || engine.state.victory) break;
    engine.resolveVote(null, "", { includeHuman: true });
  }

  const victory = engine.state.victory || { winner: "NONE", reason: "Timeout" };
  const timedOut = safety <= 0 && !engine.state.victory;
  const dayNumber = engine.state.dayNumber || 1;

  const playerResults = engine.state.players.map((p) => ({
    role: p.role,
    faction: p.faction,
    alive: p.alive,
    deathCause: p.deathCause || null,
    nightKill: p.deathCause ? NIGHT_KILL_CAUSES.has(p.deathCause) : false,
    voteKill: p.deathCause === DeathCause.VOTE_EXECUTION,
  }));

  return { victory, dayNumber, playerResults, timedOut };
}

// ─── Batch Simulator ────────────────────────────────────────────────────────

function simulateGames(count, theme, difficulty, { onProgress } = {}) {
  const tally = {};
  const roleSeen = {};
  const roleWins = {};
  const roleSurvived = {};
  const roleDeathByVote = {};
  const roleDeathByNight = {};
  const dayLengths = [];
  const reasonCounts = {};
  let timeouts = 0;

  const baseSeed = Date.now();

  for (let i = 0; i < count; i++) {
    if (onProgress && i > 0 && i % onProgress === 0) {
      process.stderr.write(`\r  Progress: ${i}/${count} (${((i / count) * 100).toFixed(0)}%)`);
    }

    const seed = baseSeed + hashSeed(i);
    const result = runOne(seed, theme, difficulty);
    const { victory, dayNumber, playerResults, timedOut } = result;

    if (timedOut) { timeouts++; continue; }

    const winner = victory.winner || "NONE";
    tally[winner] = (tally[winner] || 0) + 1;
    dayLengths.push(dayNumber);

    const reason = victory.reason || "Unknown";
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;

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

  if (onProgress) process.stderr.write("\r" + " ".repeat(50) + "\r");

  return {
    tally, roleSeen, roleWins, roleSurvived,
    roleDeathByVote, roleDeathByNight,
    dayLengths, reasonCounts, timeouts,
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

function printHelp() {
  const themes = Object.values(Theme).map((t) => t.id).join(", ");
  console.log(`
Usage: node tests/simulate.js [count] [theme] [difficulty] [flags]

Arguments:
  count       Number of games to simulate (default: 200)
  theme       Theme id: ${themes}
  difficulty  easy | normal | hard | nightmare (default: normal)

Flags:
  --compare   Run all 4 difficulties side-by-side
  --json      Output raw stats as JSON (no formatting)
  --help      Show this help

Examples:
  node tests/simulate.js 500 GOOD_VS_EVIL hard
  node tests/simulate.js 200 --compare
  node tests/simulate.js 100 GOOD_VS_EVIL hard --json
`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}

const jsonMode = args.includes("--json");
const compareMode = args.includes("--compare");
const positional = args.filter((a) => !a.startsWith("--"));

const count = Number(positional[0]) || 200;
const themeArg = positional[1];
const { id: theme, matched: themeMatched } = themeArg
  ? resolveTheme(themeArg)
  : { id: Theme.GOOD_VS_EVIL.id, matched: false };
const difficulty = positional[2] || (!themeArg || themeMatched ? "normal" : themeArg);

// Progress indicator: show every 50 games for large runs
const progressInterval = count >= 100 ? 50 : 0;

if (!jsonMode) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Simulating ${count} games | theme: ${theme} | difficulty: ${difficulty}`);
  console.log(`${"═".repeat(60)}\n`);
}

const t0 = Date.now();
const stats = simulateGames(count, theme, difficulty, { onProgress: progressInterval });
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const total = Object.values(stats.tally).reduce((a, b) => a + b, 0);

// ── JSON Mode ──

if (jsonMode && !compareMode) {
  console.log(JSON.stringify({ count: total, theme, difficulty, elapsed, ...stats }, null, 2));
  process.exit(0);
}

// ── Faction Win Rates ──

console.log(`  FACTION WIN RATES (${total} games, ${elapsed}s)`);
if (stats.timeouts > 0) {
  console.log(`  ⚠ ${stats.timeouts} games timed out (excluded from stats)`);
}
console.log(`  ${"─".repeat(50)}`);
const factionOrder = ["BLUE", "RED", "ZOMBIE", "GRUDGE", "NONE"];
for (const side of factionOrder) {
  const wins = stats.tally[side] || 0;
  if (wins === 0 && (side === "NONE" || side === "ZOMBIE" || side === "GRUDGE")) continue;
  const ratio = wins / total;
  console.log(`  ${side.padEnd(8)} ${bar(ratio)} ${pct(wins, total)} (${wins})`);
}

// ── Game Length Stats ──

const days = stats.dayLengths;
if (days.length > 0) {
  const avgDays = (days.reduce((a, b) => a + b, 0) / days.length).toFixed(1);
  const sorted = [...days].sort((a, b) => a - b);
  const minDays = sorted[0];
  const maxDays = sorted[sorted.length - 1];
  const medianDays = sorted[Math.floor(sorted.length / 2)];

  console.log(`\n  GAME LENGTH`);
  console.log(`  ${"─".repeat(50)}`);
  console.log(`  Average: ${avgDays} days | Median: ${medianDays} | Min: ${minDays} | Max: ${maxDays}`);

  const dayBuckets = {};
  for (const d of days) dayBuckets[d] = (dayBuckets[d] || 0) + 1;
  const bucketKeys = Object.keys(dayBuckets).map(Number).sort((a, b) => a - b);
  for (const d of bucketKeys) {
    const cnt = dayBuckets[d];
    const ratio = cnt / total;
    console.log(`  Day ${String(d).padStart(2)}: ${bar(ratio, 30)} ${pct(cnt, total)} (${cnt})`);
  }
}

// ── Victory Reasons ──

console.log(`\n  VICTORY REASONS`);
console.log(`  ${"─".repeat(50)}`);
for (const [reason, cnt] of Object.entries(stats.reasonCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${reason.padEnd(40)} ${pct(cnt, total)} (${cnt})`);
}

// ── Role Stats Table ──

console.log(`\n  ROLE STATS`);
console.log(`  ${"─".repeat(72)}`);
console.log(
  `  ${"Role".padEnd(20)} ${"Faction".padEnd(7)} ${"WinRate".padStart(7)} ${"Survive".padStart(8)} ${"NightDie".padStart(9)} ${"VoteDie".padStart(8)} ${"Seen".padStart(5)}`
);
console.log(`  ${"─".repeat(72)}`);

const roles = Object.keys(stats.roleSeen).sort((a, b) => {
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

if (compareMode) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  DIFFICULTY COMPARISON (${count} games each)`);
  console.log(`${"═".repeat(60)}\n`);

  const difficulties = ["easy", "normal", "hard", "nightmare"];
  const allResults = {};

  // Reuse the already-computed stats for the current difficulty
  allResults[difficulty] = { stats, total, elapsed, avgDays: days.length > 0 ? (days.reduce((a, b) => a + b, 0) / days.length).toFixed(1) : "0" };

  for (const diff of difficulties) {
    if (diff === difficulty) continue;
    const t1 = Date.now();
    const s = simulateGames(count, theme, diff, { onProgress: progressInterval });
    const dt = ((Date.now() - t1) / 1000).toFixed(1);
    const t = Object.values(s.tally).reduce((a, b) => a + b, 0);
    const avgD = s.dayLengths.length > 0 ? (s.dayLengths.reduce((a, b) => a + b, 0) / s.dayLengths.length).toFixed(1) : "0";
    allResults[diff] = { stats: s, total: t, elapsed: dt, avgDays: avgD };
  }

  if (jsonMode) {
    const jsonOut = {};
    for (const diff of difficulties) {
      const r = allResults[diff];
      jsonOut[diff] = { count: r.total, elapsed: r.elapsed, ...r.stats };
    }
    console.log(JSON.stringify(jsonOut, null, 2));
  } else {
    console.log(`  ${"Difficulty".padEnd(12)} ${"BLUE".padStart(7)} ${"RED".padStart(7)} ${"OTHER".padStart(7)} ${"AvgDays".padStart(8)} ${"Time".padStart(6)} ${"Timeout".padStart(8)}`);
    console.log(`  ${"─".repeat(62)}`);

    for (const diff of difficulties) {
      const r = allResults[diff];
      const blue = r.stats.tally["BLUE"] || 0;
      const red = r.stats.tally["RED"] || 0;
      const other = r.total - blue - red;
      const to = r.stats.timeouts || 0;
      console.log(
        `  ${diff.padEnd(12)} ${pct(blue, r.total)} ${pct(red, r.total)} ${pct(other, r.total)} ${r.avgDays.padStart(8)} ${(r.elapsed + "s").padStart(6)} ${String(to).padStart(8)}`
      );
    }
  }
}

console.log("");
