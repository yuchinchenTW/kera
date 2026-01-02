import { GameEngine } from "../src/engine.js";
import { Phase, Theme } from "../src/roles.js";

function runOne(seed, theme = Theme.GOOD_VS_EVIL.id, difficulty = "normal") {
  const engine = new GameEngine(seed, theme, difficulty);
  let safety = 200;
  while (!engine.state.victory && safety-- > 0) {
    engine.resolveNight(null, { includeHuman: true });
    if (engine.state.phase === Phase.END || engine.state.victory) break;
    engine.resolveVote(null, "", { includeHuman: true });
  }
  if (!engine.state.victory) return { winner: "NONE", reason: "Timeout" };
  return engine.state.victory;
}

function simulateGames(count = 500, theme = Theme.GOOD_VS_EVIL.id, difficulty = "normal") {
  const tally = { RED: 0, BLUE: 0, ZOMBIE: 0, GRUDGE: 0, NONE: 0 };
  for (let i = 0; i < count; i++) {
    const seed = Date.now() + i * 7919;
    const result = runOne(seed, theme, difficulty);
    tally[result.winner] = (tally[result.winner] || 0) + 1;
  }
  return tally;
}

const count = Number(process.argv[2]) || 200;
const theme = Theme.GOOD_VS_EVIL.id;
const difficulty = process.argv[3] || "normal";
const tally = simulateGames(count, theme, difficulty);
const total = Object.values(tally).reduce((a, b) => a + b, 0);

console.log(`Simulated ${total} games (theme ${theme}, difficulty ${difficulty}):`);
for (const [side, wins] of Object.entries(tally)) {
  console.log(`${side}: ${(wins / total * 100).toFixed(1)}% (${wins})`);
}
