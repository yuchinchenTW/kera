/**
 * Weight Evaluator for CMA-ES Optimization
 *
 * Takes a weights JSON file, patches them into the AI system via global config,
 * runs N simulations, and outputs fitness metrics as JSON to stdout.
 *
 * Usage:
 *   node training/eval_weights.js <weights.json> [games=100] [theme=GOOD_VS_EVIL] [difficulty=hard]
 *
 * The weights JSON has flat keys like "KILLER.night.policeProb": 0.8
 * which get injected into the LEARNED_WEIGHTS structure used by getWeight().
 */

import { readFile } from "node:fs/promises";
import { GameEngine } from "../src/engine.js";
import { alivePlayers } from "../src/state.js";
import { Theme } from "../src/roles.js";

// ─── Parse Args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const weightsPath = args[0];
const numGames = parseInt(args[1] || "100", 10);
const theme = args[2] || "GOOD_VS_EVIL";
const difficulty = args[3] || "hard";

if (!weightsPath) {
  console.error("Usage: node eval_weights.js <weights.json> [games] [theme] [difficulty]");
  process.exit(1);
}

// ─── Inject Weights ───────────────────────────────────────────────────────────

/**
 * Dynamically patch LEARNED_WEIGHTS in the ai module.
 * Flat keys like "KILLER.night.policeProb" -> LEARNED_WEIGHTS.KILLER.night.policeProb
 */
async function injectWeights(flatWeights) {
  // Import the learned_weights module and patch it directly
  const lwModule = await import("../src/ai/learned_weights.js");
  const LW = lwModule.LEARNED_WEIGHTS;

  for (const [flatKey, value] of Object.entries(flatWeights)) {
    if (flatKey.startsWith("_")) continue; // skip _doc etc.
    const parts = flatKey.split(".");
    if (parts.length === 3) {
      const [role, phase, feat] = parts;
      if (!LW[role]) LW[role] = {};
      if (!LW[role][phase]) LW[role][phase] = {};
      LW[role][phase][feat] = value;
    }
    // VOTE.* and BELIEF.* keys are stored under special namespaces
    if (parts.length === 2) {
      const [ns, feat] = parts;
      if (!LW[ns]) LW[ns] = {};
      if (!LW[ns]["params"]) LW[ns]["params"] = {};
      LW[ns]["params"][feat] = value;
    }
  }
}

// ─── Run Simulation ───────────────────────────────────────────────────────────

async function runOne(seed) {
  const engine = new GameEngine(seed, theme, difficulty, { allAi: true });
  let safety = 200;

  while (!engine.state.victory && safety-- > 0) {
    await engine.resolveNight(null, { includeHuman: true });
    if (engine.state.victory) break;
    await engine.resolveVote(null, "", { includeHuman: true });
  }

  const v = engine.state.victory;
  return {
    winner: v?.winner || "NONE",
    day: engine.state.dayNumber,
    usage: engine.state.usage,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Load weights
  const raw = await readFile(weightsPath, "utf-8");
  const parsed = JSON.parse(raw);

  // Support both formats: {key: value} and {key: [default, min, max]}
  const flatWeights = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (k.startsWith("_")) continue;
    flatWeights[k] = Array.isArray(v) ? v[0] : v;
  }

  // Inject into AI module
  await injectWeights(flatWeights);

  // Run games
  const wins = { BLUE: 0, RED: 0, ZOMBIE: 0, GRUDGE: 0, NONE: 0 };
  const days = [];
  let totalDoctorSaves = 0;
  let totalSniperShots = 0;

  for (let i = 0; i < numGames; i++) {
    const seed = 50000 + i; // fixed seeds for reproducibility
    const result = await runOne(seed);
    wins[result.winner] = (wins[result.winner] || 0) + 1;
    days.push(result.day);
    totalDoctorSaves += result.usage?.doctorSaves || 0;
    totalSniperShots += result.usage?.sniperShots || 0;
  }

  const blueRate = wins.BLUE / numGames;
  const redRate = wins.RED / numGames;
  const avgDay = days.reduce((a, b) => a + b, 0) / days.length;

  // Fitness: reward strong, skilled play from BOTH sides
  //
  // Good AI = longer games (more back-and-forth), more doctor saves,
  // more police discoveries, balanced outcome.
  //
  // 1. Game length: longer = both sides playing well (short = one side stomps)
  const lengthScore = Math.min(avgDay / 8, 1.0);  // max at 8+ days
  // 2. Doctor saves: high saves = doctor is smart AND killers pick challenging targets
  const saveScore = Math.min(totalDoctorSaves / numGames / 2, 1.0);
  // 3. Balance: mild preference for 50/50
  const balanceScore = 1.0 - Math.abs(blueRate - 0.5);
  // 4. Total kills diversity: both night and vote kills happening = healthy game
  const totalDeaths = days.reduce((a, d) => a + (18 - 3), 0) / numGames; // rough proxy
  const diversityScore = Math.min(avgDay * 2 / 15, 1.0);
  // Combined: game quality (length + saves + diversity) is dominant, balance is secondary
  const fitness = lengthScore * 0.35 + saveScore * 0.2 + balanceScore * 0.25 + diversityScore * 0.2;

  const output = {
    fitness,
    blueRate,
    redRate,
    avgDay,
    games: numGames,
    wins,
    avgDoctorSaves: totalDoctorSaves / numGames,
    avgSniperShots: totalSniperShots / numGames,
  };

  process.stdout.write(JSON.stringify(output) + "\n");
}

main().catch((e) => {
  process.stderr.write(e.message + "\n");
  process.exit(1);
});
