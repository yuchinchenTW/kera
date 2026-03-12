import { GameEngine } from "../src/engine.js";
import { Phase, Theme, Roles, DeathCause, roleMeta } from "../src/roles.js";

// ─── i18n ───────────────────────────────────────────────────────────────────

const LANG = {
  en: {
    simulating: (n, t, d) => `Simulating ${n} games | theme: ${t} | difficulty: ${d}`,
    factionWinRates: (n, s) => `FACTION WIN RATES (${n} games, ${s}s)`,
    timeoutWarn: (n) => `Warning: ${n} games timed out (excluded)`,
    gameLength: "GAME LENGTH",
    avg: "Average", median: "Median", min: "Min", max: "Max",
    day: (d) => `Day ${String(d).padStart(2)}`,
    victoryReasons: "VICTORY REASONS",
    roleStats: "ROLE STATS",
    hdrRole: "Role", hdrFaction: "Faction", hdrWin: "WinRate", hdrSurv: "Survive",
    hdrNight: "NightDie", hdrVote: "VoteDie", hdrSeen: "Seen",
    diffCompare: (n) => `DIFFICULTY COMPARISON (${n} games each)`,
    hdrDiff: "Difficulty", hdrBlue: "BLUE", hdrRed: "RED", hdrOther: "OTHER",
    hdrDays: "AvgDays", hdrTime: "Time", hdrTimeout: "Timeout",
    progress: (i, n) => `Progress: ${i}/${n} (${((i / n) * 100).toFixed(0)}%)`,
    factionName: { BLUE: "BLUE", RED: "RED", ZOMBIE: "ZOMBIE", GRUDGE: "GRUDGE", NONE: "NONE" },
    diffName: { easy: "easy", normal: "normal", hard: "hard", nightmare: "nightmare" },
    roleName: (id) => id,
    factionLabel: (f) => f,
    reasonText: (r) => r,
    helpText: (themes) => `
Usage: node tests/simulate.js [count] [theme] [difficulty] [flags]

Arguments:
  count       Number of games to simulate (default: 200)
  theme       Theme id: ${themes}
  difficulty  easy | normal | hard | nightmare (default: normal)

Flags:
  --compare   Run all 4 difficulties side-by-side
  --json      Output raw stats as JSON (no formatting)
  --zh        Output in Chinese
  --help      Show this help

Examples:
  node tests/simulate.js 500 GOOD_VS_EVIL hard
  node tests/simulate.js 200 --compare
  node tests/simulate.js 100 GOOD_VS_EVIL hard --json
  node tests/simulate.js 200 GOOD_VS_EVIL hard --zh
`,
  },
  zh: {
    simulating: (n, t, d) => `模擬 ${n} 場遊戲 | 主題：${t} | 難度：${d}`,
    factionWinRates: (n, s) => `陣營勝率（${n} 場，${s} 秒）`,
    timeoutWarn: (n) => `警告：${n} 場遊戲超時（已排除）`,
    gameLength: "遊戲長度",
    avg: "平均", median: "中位數", min: "最短", max: "最長",
    day: (d) => `第${String(d).padStart(2)}天`,
    victoryReasons: "勝利原因",
    roleStats: "角色統計",
    hdrRole: "角色", hdrFaction: "陣營", hdrWin: "勝率", hdrSurv: "存活率",
    hdrNight: "夜殺率", hdrVote: "票殺率", hdrSeen: "場次",
    diffCompare: (n) => `難度比較（每個難度 ${n} 場）`,
    hdrDiff: "難度", hdrBlue: "藍方", hdrRed: "紅方", hdrOther: "其他",
    hdrDays: "平均天數", hdrTime: "耗時", hdrTimeout: "超時",
    progress: (i, n) => `進度：${i}/${n}（${((i / n) * 100).toFixed(0)}%）`,
    factionName: { BLUE: "藍方", RED: "紅方", ZOMBIE: "殭屍", GRUDGE: "怨靈", NONE: "無" },
    diffName: { easy: "簡單", normal: "普通", hard: "困難", nightmare: "噩夢" },
    roleName: (id) => {
      const map = {
        CIVILIAN: "平民", POLICE: "警察", KILLER: "殺手", DOCTOR: "醫生",
        SNIPER: "狙擊手", AGENT: "特務", TERRORIST: "恐怖份子", COWBOY: "牛仔",
        KIDNAPPER: "綁匪", ZOMBIE: "殭屍", RIOT_POLICE: "鎮暴警察",
        ARSONIST: "縱火犯", HEAVENLY_FIEND: "天煞", VINE_DEMON: "藤魔",
        BRAT: "屁孩", NIGHTMARE_DEMON: "夢魔", EXORCIST: "驅魔師",
        NECROMANCER: "死靈法師", PURIFIER: "淨化者", GRUDGE_BEAST: "怨靈獸",
      };
      return map[id] || id;
    },
    factionLabel: (f) => ({ BLUE: "藍", RED: "紅", GREEN: "綠" }[f] || f),
    reasonText: (r) => {
      const map = {
        "All killers eliminated.": "所有殺手被消滅。",
        "Red faction satisfied elimination condition.": "紅方達成殲滅條件。",
        "Zombies outnumber the living.": "殭屍數量超過存活者。",
        "Grudge Beasts finished their rage condition.": "怨靈獸完成狂暴條件。",
        "Grudge Beasts survive without berserk (overriding red win).": "怨靈獸未狂暴存活（覆寫紅方勝利）。",
        "Grudge Beasts survive without berserk (overriding blue win).": "怨靈獸未狂暴存活（覆寫藍方勝利）。",
        "Grudge co-win after berserk triggered by BLUE; RED cleared police.": "怨靈共贏（藍方觸發狂暴，紅方消滅警察）。",
        "Grudge co-win after berserk triggered by RED; BLUE cleared killers.": "怨靈共贏（紅方觸發狂暴，藍方消滅殺手）。",
      };
      return map[r] || r;
    },
    helpText: (themes) => `
用法：node tests/simulate.js [場數] [主題] [難度] [選項]

參數：
  場數        模擬遊戲數量（預設：200）
  主題        主題 ID：${themes}
  難度        easy | normal | hard | nightmare（預設：normal）

選項：
  --compare   比較所有 4 種難度
  --json      輸出 JSON 格式
  --zh        中文輸出
  --help      顯示說明

範例：
  node tests/simulate.js 500 GOOD_VS_EVIL hard
  node tests/simulate.js 200 --compare
  node tests/simulate.js 100 GOOD_VS_EVIL hard --json
  node tests/simulate.js 200 GOOD_VS_EVIL hard --zh
`,
  },
};

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

function simulateGames(count, theme, difficulty, { onProgress, L } = {}) {
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
      process.stderr.write(`\r  ${L.progress(i, count)}`);
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

// ─── Main ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  const L = args.includes("--zh") ? LANG.zh : LANG.en;
  const themes = Object.values(Theme).map((t) => t.id).join(", ");
  console.log(L.helpText(themes));
  process.exit(0);
}

const zhMode = args.includes("--zh");
const jsonMode = args.includes("--json");
const compareMode = args.includes("--compare");
const L = zhMode ? LANG.zh : LANG.en;
const positional = args.filter((a) => !a.startsWith("--"));

const count = Number(positional[0]) || 200;
const themeArg = positional[1];
const { id: theme, matched: themeMatched } = themeArg
  ? resolveTheme(themeArg)
  : { id: Theme.GOOD_VS_EVIL.id, matched: false };
const difficulty = positional[2] || (!themeArg || themeMatched ? "normal" : themeArg);

const progressInterval = count >= 100 ? 50 : 0;

if (!jsonMode) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${L.simulating(count, theme, L.diffName[difficulty] || difficulty)}`);
  console.log(`${"═".repeat(60)}\n`);
}

const t0 = Date.now();
const stats = simulateGames(count, theme, difficulty, { onProgress: progressInterval, L });
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const total = Object.values(stats.tally).reduce((a, b) => a + b, 0);

// ── JSON Mode ──

if (jsonMode && !compareMode) {
  console.log(JSON.stringify({ count: total, theme, difficulty, elapsed, ...stats }, null, 2));
  process.exit(0);
}

// ── Faction Win Rates ──

console.log(`  ${L.factionWinRates(total, elapsed)}`);
if (stats.timeouts > 0) {
  console.log(`  ${L.timeoutWarn(stats.timeouts)}`);
}
console.log(`  ${"─".repeat(50)}`);
const factionOrder = ["BLUE", "RED", "ZOMBIE", "GRUDGE", "NONE"];
for (const side of factionOrder) {
  const wins = stats.tally[side] || 0;
  if (wins === 0 && (side === "NONE" || side === "ZOMBIE" || side === "GRUDGE")) continue;
  const ratio = wins / total;
  console.log(`  ${(L.factionName[side] || side).padEnd(8)} ${bar(ratio)} ${pct(wins, total)} (${wins})`);
}

// ── Game Length Stats ──

const days = stats.dayLengths;
if (days.length > 0) {
  const avgDays = (days.reduce((a, b) => a + b, 0) / days.length).toFixed(1);
  const sorted = [...days].sort((a, b) => a - b);
  const minDays = sorted[0];
  const maxDays = sorted[sorted.length - 1];
  const medianDays = sorted[Math.floor(sorted.length / 2)];

  console.log(`\n  ${L.gameLength}`);
  console.log(`  ${"─".repeat(50)}`);
  console.log(`  ${L.avg}：${avgDays} | ${L.median}：${medianDays} | ${L.min}：${minDays} | ${L.max}：${maxDays}`);

  const dayBuckets = {};
  for (const d of days) dayBuckets[d] = (dayBuckets[d] || 0) + 1;
  const bucketKeys = Object.keys(dayBuckets).map(Number).sort((a, b) => a - b);
  for (const d of bucketKeys) {
    const cnt = dayBuckets[d];
    const ratio = cnt / total;
    console.log(`  ${L.day(d)}：${bar(ratio, 30)} ${pct(cnt, total)} (${cnt})`);
  }
}

// ── Victory Reasons ──

console.log(`\n  ${L.victoryReasons}`);
console.log(`  ${"─".repeat(50)}`);
for (const [reason, cnt] of Object.entries(stats.reasonCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${L.reasonText(reason).padEnd(40)} ${pct(cnt, total)} (${cnt})`);
}

// ── Role Stats Table ──

console.log(`\n  ${L.roleStats}`);
console.log(`  ${"─".repeat(72)}`);
console.log(
  `  ${L.hdrRole.padEnd(20)} ${L.hdrFaction.padEnd(7)} ${L.hdrWin.padStart(7)} ${L.hdrSurv.padStart(8)} ${L.hdrNight.padStart(9)} ${L.hdrVote.padStart(8)} ${L.hdrSeen.padStart(5)}`
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
    `  ${L.roleName(role).padEnd(20)} ${L.factionLabel(faction).padEnd(7)} ${pct(wins, seen)} ${pct(survived, seen)} ${pct(nightDied, seen)} ${pct(voteDied, seen)} ${String(seen).padStart(5)}`
  );
}

// ── Difficulty Comparison Mode ──

if (compareMode) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${L.diffCompare(count)}`);
  console.log(`${"═".repeat(60)}\n`);

  const difficulties = ["easy", "normal", "hard", "nightmare"];
  const allResults = {};

  allResults[difficulty] = { stats, total, elapsed, avgDays: days.length > 0 ? (days.reduce((a, b) => a + b, 0) / days.length).toFixed(1) : "0" };

  for (const diff of difficulties) {
    if (diff === difficulty) continue;
    const t1 = Date.now();
    const s = simulateGames(count, theme, diff, { onProgress: progressInterval, L });
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
    console.log(`  ${L.hdrDiff.padEnd(12)} ${L.hdrBlue.padStart(7)} ${L.hdrRed.padStart(7)} ${L.hdrOther.padStart(7)} ${L.hdrDays.padStart(8)} ${L.hdrTime.padStart(6)} ${L.hdrTimeout.padStart(8)}`);
    console.log(`  ${"─".repeat(62)}`);

    for (const diff of difficulties) {
      const r = allResults[diff];
      const blue = r.stats.tally["BLUE"] || 0;
      const red = r.stats.tally["RED"] || 0;
      const other = r.total - blue - red;
      const to = r.stats.timeouts || 0;
      console.log(
        `  ${(L.diffName[diff] || diff).padEnd(12)} ${pct(blue, r.total)} ${pct(red, r.total)} ${pct(other, r.total)} ${r.avgDays.padStart(8)} ${(r.elapsed + "s").padStart(6)} ${String(to).padStart(8)}`
      );
    }
  }
}

console.log("");
