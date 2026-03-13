import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
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
    threads: (n) => `Using ${n} threads`,
    actionStats: "ACTION STATS",
    doctorSaves: "Doctor saves", agentBlocks: "Agent/Fiend blocks",
    voteNoExec: "No-execution votes", perGame: "/game",
    voteAccuracy: "Vote accuracy (red killed)", zombieConverts: "Zombie conversions",
    aliveCurve: "ALIVE CURVE (avg per day)",
    firstNightKill: "1stNight",
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
    threads: (n) => `使用 ${n} 個執行緒`,
    actionStats: "行動統計",
    doctorSaves: "醫生救援", agentBlocks: "特務/天煞擋下",
    voteNoExec: "未處決投票", perGame: "/場",
    voteAccuracy: "投票準確率（殺到紅方）", zombieConverts: "殭屍轉化",
    aliveCurve: "存活曲線（每日平均）",
    firstNightKill: "首夜",
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
  const engine = new GameEngine(seed, theme, difficulty, { allAi: true });

  let safety = 200;
  let doctorSaves = 0;
  let agentBlocks = 0;
  let totalVoteRounds = 0;
  let noExecutionRounds = 0;
  let correctVoteKills = 0;
  let totalVoteKills = 0;
  let zombieConversions = 0;
  const aliveCurve = [];  // alive count at start of each day
  const firstNightKills = []; // roles killed on night 1

  let roundNum = 0;
  while (!engine.state.victory && safety-- > 0) {
    roundNum++;
    const summaryBefore = engine.state.lastNightSummary?.length || 0;
    const aliveBeforeNight = engine.state.players.filter((p) => p.alive).length;

    engine.resolveNight(null, { includeHuman: true });

    // Count protections from lastNightSummary
    for (const entry of (engine.state.lastNightSummary || []).slice(summaryBefore)) {
      if (typeof entry === "string") {
        if (entry.includes("saved") && entry.includes("from death")) doctorSaves++;
        if (entry.includes("Agent shield") || entry.includes("Fiend absorbed")) agentBlocks++;
      }
    }

    // Track zombie conversions (players whose role changed to ZOMBIE from something else)
    for (const p of engine.state.players) {
      if (p.role === Roles.ZOMBIE.id && p.startRole !== Roles.ZOMBIE.id && p.alive && !p._countedConversion) {
        zombieConversions++;
        p._countedConversion = true;
      }
    }

    // Track first night kills
    if (roundNum === 1) {
      for (const p of engine.state.players) {
        if (!p.alive && p.deathCause && NIGHT_KILL_CAUSES.has(p.deathCause)) {
          firstNightKills.push(p.startRole);
        }
      }
    }

    if (engine.state.phase === Phase.END || engine.state.victory) break;

    // Record alive count at start of day phase
    aliveCurve.push(engine.state.players.filter((p) => p.alive).length);

    const aliveBefore = engine.state.players.filter((p) => p.alive).length;
    engine.resolveVote(null, "", { includeHuman: true });
    const aliveAfter = engine.state.players.filter((p) => p.alive).length;
    totalVoteRounds++;
    if (aliveBefore === aliveAfter) {
      noExecutionRounds++;
    } else {
      // Track correct vote kills (was the executed player red?)
      totalVoteKills++;
      const executed = engine.state.players.find(
        (p) => !p.alive && p.deathCause === DeathCause.VOTE_EXECUTION && !p._countedVoteKill
      );
      if (executed) {
        executed._countedVoteKill = true;
        if (executed.startFaction === "RED") correctVoteKills++;
      }
    }
  }

  const victory = engine.state.victory || { winner: "NONE", reason: "Timeout" };
  const timedOut = safety <= 0 && !engine.state.victory;
  const dayNumber = engine.state.dayNumber || 1;

  const playerResults = engine.state.players.map((p) => ({
    role: p.startRole,
    faction: p.startFaction,
    finalRole: p.role,
    finalFaction: p.faction,
    alive: p.alive,
    deathCause: p.deathCause || null,
    nightKill: p.deathCause ? NIGHT_KILL_CAUSES.has(p.deathCause) : false,
    voteKill: p.deathCause === DeathCause.VOTE_EXECUTION,
    converted: p.role !== p.startRole,
  }));

  return {
    victory, dayNumber, playerResults, timedOut,
    doctorSaves, agentBlocks, totalVoteRounds, noExecutionRounds,
    correctVoteKills, totalVoteKills, zombieConversions,
    aliveCurve, firstNightKills,
  };
}

// ─── Worker Thread Logic ────────────────────────────────────────────────────

if (!isMainThread) {
  // Worker: run assigned game range and return aggregated stats
  const { startIdx, endIdx, baseSeed, theme, difficulty } = workerData;

  const tally = {};
  const roleSeen = {};
  const roleWins = {};
  const roleSurvived = {};
  const roleDeathByVote = {};
  const roleDeathByNight = {};
  const roleFirstNightKill = {};
  const dayLengths = [];
  const reasonCounts = {};
  let timeouts = 0;
  let completed = 0;
  let totalDoctorSaves = 0;
  let totalAgentBlocks = 0;
  let totalVoteRounds = 0;
  let totalNoExecRounds = 0;
  let totalCorrectVoteKills = 0;
  let totalVoteKills = 0;
  let totalZombieConversions = 0;
  const aliveCurveSums = {};  // day -> total alive across games
  const aliveCurveCounts = {}; // day -> number of games that reached this day

  for (let i = startIdx; i < endIdx; i++) {
    const seed = baseSeed + hashSeed(i);
    const result = runOne(seed, theme, difficulty);
    const { victory, dayNumber, playerResults, timedOut } = result;

    completed++;
    if (completed % 20 === 0) {
      parentPort.postMessage({ type: "progress", completed });
    }

    if (timedOut) { timeouts++; continue; }

    const winner = victory.winner || "NONE";
    tally[winner] = (tally[winner] || 0) + 1;
    dayLengths.push(dayNumber);
    totalDoctorSaves += result.doctorSaves || 0;
    totalAgentBlocks += result.agentBlocks || 0;
    totalVoteRounds += result.totalVoteRounds || 0;
    totalNoExecRounds += result.noExecutionRounds || 0;
    totalCorrectVoteKills += result.correctVoteKills || 0;
    totalVoteKills += result.totalVoteKills || 0;
    totalZombieConversions += result.zombieConversions || 0;

    // Alive curve aggregation
    for (let d = 0; d < (result.aliveCurve || []).length; d++) {
      const day = d + 1;
      aliveCurveSums[day] = (aliveCurveSums[day] || 0) + result.aliveCurve[d];
      aliveCurveCounts[day] = (aliveCurveCounts[day] || 0) + 1;
    }

    // First night kill tracking
    for (const role of (result.firstNightKills || [])) {
      roleFirstNightKill[role] = (roleFirstNightKill[role] || 0) + 1;
    }

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

  parentPort.postMessage({
    type: "done",
    stats: {
      tally, roleSeen, roleWins, roleSurvived,
      roleDeathByVote, roleDeathByNight, roleFirstNightKill,
      dayLengths, reasonCounts, timeouts,
      totalDoctorSaves, totalAgentBlocks, totalVoteRounds, totalNoExecRounds,
      totalCorrectVoteKills, totalVoteKills, totalZombieConversions,
      aliveCurveSums, aliveCurveCounts,
    },
  });
  process.exit(0);
}

// ─── Multi-threaded Batch Simulator ─────────────────────────────────────────

const MERGE_SUM_KEYS = [
  "tally", "roleSeen", "roleWins", "roleSurvived",
  "roleDeathByVote", "roleDeathByNight", "roleFirstNightKill",
  "reasonCounts", "aliveCurveSums", "aliveCurveCounts",
];
const MERGE_SCALAR_KEYS = [
  "timeouts", "totalDoctorSaves", "totalAgentBlocks",
  "totalVoteRounds", "totalNoExecRounds",
  "totalCorrectVoteKills", "totalVoteKills", "totalZombieConversions",
];

function mergeStats(a, b) {
  const merged = { dayLengths: [...a.dayLengths, ...b.dayLengths] };
  for (const key of MERGE_SUM_KEYS) {
    merged[key] = { ...(a[key] || {}) };
    for (const [k, v] of Object.entries(b[key] || {})) {
      merged[key][k] = (merged[key][k] || 0) + v;
    }
  }
  for (const key of MERGE_SCALAR_KEYS) {
    merged[key] = (a[key] || 0) + (b[key] || 0);
  }
  return merged;
}

function emptyStats() {
  const s = { dayLengths: [] };
  for (const key of MERGE_SUM_KEYS) s[key] = {};
  for (const key of MERGE_SCALAR_KEYS) s[key] = 0;
  return s;
}

function simulateGames(count, theme, difficulty, { L }) {
  const numThreads = Math.min(cpus().length, count);

  return new Promise((resolve) => {
    if (numThreads <= 1) {
      // Fallback to single-threaded for very small counts
      const baseSeed = Date.now();
      let acc = emptyStats();

      for (let i = 0; i < count; i++) {
        const seed = baseSeed + hashSeed(i);
        const result = runOne(seed, theme, difficulty);
        const { victory, dayNumber, playerResults, timedOut } = result;

        if (timedOut) { acc.timeouts++; continue; }

        const winner = victory.winner || "NONE";
        acc.tally[winner] = (acc.tally[winner] || 0) + 1;
        acc.dayLengths.push(dayNumber);
        acc.totalDoctorSaves += result.doctorSaves || 0;
        acc.totalAgentBlocks += result.agentBlocks || 0;
        acc.totalVoteRounds += result.totalVoteRounds || 0;
        acc.totalNoExecRounds += result.noExecutionRounds || 0;
        acc.totalCorrectVoteKills += result.correctVoteKills || 0;
        acc.totalVoteKills += result.totalVoteKills || 0;
        acc.totalZombieConversions += result.zombieConversions || 0;

        for (let d = 0; d < (result.aliveCurve || []).length; d++) {
          const day = d + 1;
          acc.aliveCurveSums[day] = (acc.aliveCurveSums[day] || 0) + result.aliveCurve[d];
          acc.aliveCurveCounts[day] = (acc.aliveCurveCounts[day] || 0) + 1;
        }
        for (const role of (result.firstNightKills || [])) {
          acc.roleFirstNightKill[role] = (acc.roleFirstNightKill[role] || 0) + 1;
        }

        const reason = victory.reason || "Unknown";
        acc.reasonCounts[reason] = (acc.reasonCounts[reason] || 0) + 1;

        for (const pr of playerResults) {
          const { role, faction, alive, nightKill, voteKill } = pr;
          acc.roleSeen[role] = (acc.roleSeen[role] || 0) + 1;

          const roleCountsAsWin =
            (winner === "RED" && faction === "RED") ||
            (winner === "BLUE" && faction === "BLUE") ||
            (winner === "ZOMBIE" && role === Roles.ZOMBIE.id) ||
            (winner === "GRUDGE" && role === Roles.GRUDGE_BEAST.id);
          if (roleCountsAsWin) acc.roleWins[role] = (acc.roleWins[role] || 0) + 1;

          if (alive) acc.roleSurvived[role] = (acc.roleSurvived[role] || 0) + 1;
          if (voteKill) acc.roleDeathByVote[role] = (acc.roleDeathByVote[role] || 0) + 1;
          if (nightKill) acc.roleDeathByNight[role] = (acc.roleDeathByNight[role] || 0) + 1;
        }
      }

      resolve(acc);
      return;
    }

    // Multi-threaded
    const baseSeed = Date.now();
    const chunkSize = Math.ceil(count / numThreads);
    let completedGames = 0;
    let finishedWorkers = 0;
    let merged = emptyStats();
    const workerFile = fileURLToPath(import.meta.url);

    for (let t = 0; t < numThreads; t++) {
      const startIdx = t * chunkSize;
      const endIdx = Math.min(startIdx + chunkSize, count);
      if (startIdx >= count) break;

      const worker = new Worker(workerFile, {
        workerData: { startIdx, endIdx, baseSeed, theme, difficulty },
      });

      worker.on("message", (msg) => {
        if (msg.type === "progress") {
          completedGames += 20;
          if (count >= 100) {
            process.stderr.write(`\r  ${L.progress(Math.min(completedGames, count), count)}        `);
          }
        } else if (msg.type === "done") {
          merged = mergeStats(merged, msg.stats);
          finishedWorkers++;
          if (finishedWorkers === Math.min(numThreads, Math.ceil(count / chunkSize))) {
            if (count >= 100) process.stderr.write("\r" + " ".repeat(50) + "\r");
            resolve(merged);
          }
        }
      });

      worker.on("error", (err) => {
        console.error("Worker error:", err);
      });
    }
  });
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

const numThreads = Math.min(cpus().length, count);

if (!jsonMode) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${L.simulating(count, theme, L.diffName[difficulty] || difficulty)}`);
  console.log(`  ${L.threads(numThreads)}`);
  console.log(`${"═".repeat(60)}\n`);
}

const t0 = Date.now();

async function main() {
  const stats = await simulateGames(count, theme, difficulty, { L });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const total = Object.values(stats.tally).reduce((a, b) => a + b, 0);
  const days = stats.dayLengths;

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
  console.log(`  ${"─".repeat(82)}`);
  console.log(
    `  ${L.hdrRole.padEnd(20)} ${L.hdrFaction.padEnd(7)} ${L.hdrWin.padStart(7)} ${L.hdrSurv.padStart(8)} ${L.hdrNight.padStart(9)} ${L.hdrVote.padStart(8)} ${L.firstNightKill.padStart(8)} ${L.hdrSeen.padStart(5)}`
  );
  console.log(`  ${"─".repeat(82)}`);

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
    const firstNight = stats.roleFirstNightKill[role] || 0;
    const faction = roleMeta(role)?.faction || "?";
    console.log(
      `  ${L.roleName(role).padEnd(20)} ${L.factionLabel(faction).padEnd(7)} ${pct(wins, seen)} ${pct(survived, seen)} ${pct(nightDied, seen)} ${pct(voteDied, seen)} ${pct(firstNight, seen)} ${String(seen).padStart(5)}`
    );
  }

  // ── Action Stats ──

  if (total > 0) {
    const avgDocSaves = (stats.totalDoctorSaves / total).toFixed(2);
    const avgAgentBlocks = (stats.totalAgentBlocks / total).toFixed(2);
    const noExecPct = stats.totalVoteRounds > 0 ? pct(stats.totalNoExecRounds, stats.totalVoteRounds) : "  0.0%";
    const voteAccPct = stats.totalVoteKills > 0 ? pct(stats.totalCorrectVoteKills, stats.totalVoteKills) : "  0.0%";
    const avgZombie = (stats.totalZombieConversions / total).toFixed(2);

    console.log(`\n  ${L.actionStats}`);
    console.log(`  ${"─".repeat(50)}`);
    console.log(`  ${L.doctorSaves.padEnd(24)} ${avgDocSaves} ${L.perGame}`);
    console.log(`  ${L.agentBlocks.padEnd(24)} ${avgAgentBlocks} ${L.perGame}`);
    console.log(`  ${L.voteNoExec.padEnd(24)} ${noExecPct} (${stats.totalNoExecRounds}/${stats.totalVoteRounds})`);
    console.log(`  ${L.voteAccuracy.padEnd(24)} ${voteAccPct} (${stats.totalCorrectVoteKills}/${stats.totalVoteKills})`);
    if (stats.totalZombieConversions > 0) {
      console.log(`  ${L.zombieConverts.padEnd(24)} ${avgZombie} ${L.perGame}`);
    }
  }

  // ── Alive Curve ──

  const curveKeys = Object.keys(stats.aliveCurveSums || {}).map(Number).sort((a, b) => a - b);
  if (curveKeys.length > 0) {
    console.log(`\n  ${L.aliveCurve}`);
    console.log(`  ${"─".repeat(50)}`);
    for (const day of curveKeys) {
      const avg = (stats.aliveCurveSums[day] / stats.aliveCurveCounts[day]).toFixed(1);
      const ratio = stats.aliveCurveSums[day] / stats.aliveCurveCounts[day] / 18;
      console.log(`  ${L.day(day)}：${bar(ratio, 18)} ${avg}`);
    }
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
      const s = await simulateGames(count, theme, diff, { L });
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
}

main();
