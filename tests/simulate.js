import { GameEngine } from "../src/engine.js";
import { Phase, Theme, Roles } from "../src/roles.js";

function resolveTheme(input) {
  if (!input) return { id: Theme.GOOD_VS_EVIL.id, matched: false };
  const normalized = String(input).trim().toUpperCase();
  const match = Object.values(Theme).find(
    (t) => t.id.toUpperCase() === normalized || t.name.toUpperCase() === normalized
  );
  return match ? { id: match.id, matched: true } : { id: Theme.GOOD_VS_EVIL.id, matched: false };
}

function runOne(seed, theme = Theme.GOOD_VS_EVIL.id, difficulty = "normal") {
  const engine = new GameEngine(seed, theme, difficulty);
  const startRoles = engine.state.players.map((p) => ({ role: p.role, faction: p.faction }));
  let safety = 200;
  while (!engine.state.victory && safety-- > 0) {
    engine.resolveNight(null, { includeHuman: true });
    if (engine.state.phase === Phase.END || engine.state.victory) break;
    engine.resolveVote(null, "", { includeHuman: true });
  }
  const victory = engine.state.victory || { winner: "NONE", reason: "Timeout" };
  return { victory, startRoles };
}

function simulateGames(count = 500, theme = Theme.GOOD_VS_EVIL.id, difficulty = "normal") {
  const tally = { RED: 0, BLUE: 0, ZOMBIE: 0, GRUDGE: 0, NONE: 0 };
  const roleSeen = {};
  const roleWins = {};
  for (let i = 0; i < count; i++) {
    const seed = Date.now() + i * 7919;
    const { victory, startRoles } = runOne(seed, theme, difficulty);
    tally[victory.winner] = (tally[victory.winner] || 0) + 1;

    // Record per-role win contribution based on starting faction and final winner.
    for (const { role, faction } of startRoles) {
      roleSeen[role] = (roleSeen[role] || 0) + 1;
      const win = victory.winner;
      const roleCountsAsWin =
        (win === "RED" && faction === "RED") ||
        (win === "BLUE" && faction === "BLUE") ||
        (win === "ZOMBIE" && role === Roles.ZOMBIE.id) ||
        (win === "GRUDGE" && role === Roles.GRUDGE_BEAST.id);
      if (roleCountsAsWin) roleWins[role] = (roleWins[role] || 0) + 1;
    }
  }
  return { tally, roleSeen, roleWins };
}

const count = Number(process.argv[2]) || 200;
const themeArg = process.argv[3];
const { id: theme, matched: themeMatched } = themeArg ? resolveTheme(themeArg) : { id: Theme.GOOD_VS_EVIL.id, matched: false };
const difficulty = process.argv[4] || (!themeArg || themeMatched ? "normal" : themeArg);
const { tally, roleSeen, roleWins } = simulateGames(count, theme, difficulty);
const total = Object.values(tally).reduce((a, b) => a + b, 0);

console.log(`Simulated ${total} games (theme ${theme}, difficulty ${difficulty}):`);
for (const [side, wins] of Object.entries(tally)) {
  console.log(`${side}: ${(wins / total * 100).toFixed(1)}% (${wins})`);
}

console.log("\nRole win rates (based on starting faction vs final winner):");
Object.keys(roleSeen)
  .sort()
  .forEach((role) => {
    const seen = roleSeen[role];
    const win = roleWins[role] || 0;
    const pct = ((win / seen) * 100).toFixed(1);
    console.log(`${role}: ${pct}% (${win}/${seen})`);
  });
