/**
 * Behavioral audit: run 200+ hard AI games and check logic consistency
 * for Police, Civilian, Killer, Doctor, Sniper across actions, public chat, private chat.
 */
import { GameEngine } from "../src/engine.js";
import { Roles } from "../src/roles.js";

const GAMES = 250;
const MAX_ROUNDS = 8;

const issues = [];
const stats = {
  games: 0,
  // Police
  policeInvestigatedSelf: 0,
  policeInvestigatedPolice: 0,
  policeRevealCount: 0,
  policeVotedRevealedRed: 0,
  policeDidNotVoteRevealedRed: 0,
  policeChatMentionsTarget: 0,
  policeChatTotal: 0,
  // Killer
  killerTargetedRed: 0,
  killerTargetedBlue: 0,
  killerChatMentionsTarget: 0,
  killerChatTotal: 0,
  killerSplitVoteWhen3Plus: 0,
  killerClusteredVoteWhen3Plus: 0,
  // Doctor
  doctorSavedSelf: 0,
  doctorSavedOthers: 0,
  doctorConsecutiveSameTarget: 0,
  doctorActions: 0,
  // Sniper
  sniperHitBlue: 0,
  sniperHitRed: 0,
  sniperHitGreen: 0,
  sniperTotal: 0,
  // Civilian
  civVotedRevealedRed: 0,
  civDidNotVoteRevealedRed: 0,
  civVoteMatchesChat: 0,
  civVoteMismatchesChat: 0,
  // Chat logic
  deadSpeakerInChat: 0,
  emptyChatRounds: 0,
  chatRounds: 0,
  // Private chat
  killerPrivateChatRounds: 0,
  killerPrivateChatEmpty: 0,
  policePrivateChatRounds: 0,
  policePrivateChatEmpty: 0,
  // Info leak checks
  civDefendedKillerByName: 0,
  nonKillerRedDefendedKillerByRole: 0,
};

(async () => {
for (let seed = 1; seed <= GAMES; seed++) {
  const e = new GameEngine(seed, "GOOD_VS_EVIL", "hard");
  let lastDoctorTarget = {};
  let prevKillerChat = 0;
  let prevPoliceChat = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const dayBefore = e.state.dayNumber;

    // Capture state before night
    const aliveBeforeNight = e.state.players.filter((p) => p.alive).map((p) => p.id);

    await e.resolveNight({});
    if (e.state.phase === "END") break;

    // ─ Analyze night actions from publicLog + state ─
    const nightSummary = e.state.lastNightSummary || [];

    // Doctor consecutive same target check
    for (const p of e.state.players) {
      if (p.role !== Roles.DOCTOR.id || !p.alive) continue;
      const lastProt = p.aiMemory?.lastProtected;
      if (lastProt !== undefined && lastProt !== null) {
        if (lastDoctorTarget[p.id] === lastProt) {
          stats.doctorConsecutiveSameTarget++;
        }
        lastDoctorTarget[p.id] = lastProt;
        stats.doctorActions++;
      }
    }

    // ─ Analyze dayChat ─
    const dayChat = e.state.dayChat || [];
    stats.chatRounds++;
    if (dayChat.length === 0) stats.emptyChatRounds++;

    // Check for dead speakers in dayChat
    for (const line of dayChat) {
      if (line.startsWith("[VOTE] ")) continue;
      for (const p of e.state.players) {
        if (!p) continue;
        if (line.startsWith(p.name + ":") && !p.alive) {
          stats.deadSpeakerInChat++;
          issues.push(`Seed ${seed} R${round}: Dead ${p.name} spoke in dayChat: "${line.split("||")[0].slice(0, 60)}"`);
        }
      }
    }

    // ─ Analyze killer private chat ─
    const kchat = e.state.killerChat || [];
    const newKillerLines = kchat.slice(prevKillerChat);
    prevKillerChat = kchat.length;
    if (e.state.players.some((p) => p.role === Roles.KILLER.id && p.alive && !p.isHuman)) {
      stats.killerPrivateChatRounds++;
      if (newKillerLines.length === 0) stats.killerPrivateChatEmpty++;

      // Check if killer chat mentions the actual kill target
      const killed = e.state.players.find(
        (p) => !p.alive && p.deathCause === "KILLER_MURDER" && !aliveBeforeNight.includes(p.id) === false
      );
      // More reliable: find who died this night by murder
      const murderedThisRound = e.state.players.filter(
        (p) => !p.alive && p.deathCause === "KILLER_MURDER" && aliveBeforeNight.includes(p.id)
      );
      stats.killerChatTotal++;
      if (murderedThisRound.length > 0) {
        const targetName = murderedThisRound[0].name;
        const mentioned = newKillerLines.some((l) => l.includes(targetName));
        if (mentioned) stats.killerChatMentionsTarget++;
      }
    }

    // ─ Analyze police private chat ─
    const pchat = e.state.policeChat || [];
    const newPoliceLines = pchat.slice(prevPoliceChat);
    prevPoliceChat = pchat.length;
    if (e.state.players.some((p) => p.role === Roles.POLICE.id && p.alive && !p.isHuman)) {
      stats.policePrivateChatRounds++;
      if (newPoliceLines.length === 0) stats.policePrivateChatEmpty++;

      // Check if police chat mentions investigation target
      const policeActions = e.state.publicLog.filter(
        (l) => typeof l === "string" && l.includes("Investigation result")
      );
      stats.policeChatTotal++;
    }

    // ─ Voting phase ─
    const revealedRedBefore = e.state.policeRevealedRed;
    const revealedRedPlayer = revealedRedBefore !== null ? e.state.players[revealedRedBefore] : null;

    await e.resolveVote(null);
    if (e.state.phase === "END") break;

    // Analyze votes from history
    const lastVoteRound = e.state.history?.votes?.[e.state.history.votes.length - 1];
    if (!lastVoteRound?.order) continue;

    // Track killer vote scatter when 3+ alive
    const aliveKillers = e.state.players.filter(
      (p) => p.role === Roles.KILLER.id && aliveBeforeNight.includes(p.id)
    );
    if (aliveKillers.length >= 3) {
      const killerVotes = lastVoteRound.order.filter((v) =>
        aliveKillers.some((k) => k.id === v.actorId)
      );
      const killerTargets = new Set(killerVotes.map((v) => v.targetId));
      if (killerTargets.size >= 2) {
        stats.killerSplitVoteWhen3Plus++;
      } else if (killerVotes.length >= 3) {
        stats.killerClusteredVoteWhen3Plus++;
      }
    }

    for (const entry of lastVoteRound.order) {
      const voter = e.state.players[entry.actorId];
      const target = e.state.players[entry.targetId];
      if (!voter || !target || voter.isHuman) continue;

      // Police: should always vote revealed red
      if (voter.role === Roles.POLICE.id && revealedRedPlayer?.alive) {
        if (entry.targetId === revealedRedBefore) {
          stats.policeVotedRevealedRed++;
        } else {
          stats.policeDidNotVoteRevealedRed++;
          issues.push(
            `Seed ${seed} R${round}: Police ${voter.name} didn't vote revealed red ${revealedRedPlayer.name}, voted ${target.name} instead`
          );
        }
      }

      // Civilian: should ~95% vote revealed red
      if (
        voter.faction === "BLUE" &&
        voter.role !== Roles.POLICE.id &&
        voter.role !== Roles.AGENT?.id &&
        revealedRedPlayer?.alive
      ) {
        if (entry.targetId === revealedRedBefore) {
          stats.civVotedRevealedRed++;
        } else {
          stats.civDidNotVoteRevealedRed++;
        }
      }

      // Killer targeting check
      if (voter.role === Roles.KILLER.id) {
        if (target.faction === "RED") stats.killerTargetedRed++;
        else stats.killerTargetedBlue++;
      }
    }

    // Check civilian chat vs vote consistency
    for (const entry of lastVoteRound.order) {
      const voter = e.state.players[entry.actorId];
      const target = e.state.players[entry.targetId];
      if (!voter || !target || voter.isHuman) continue;
      if (voter.faction !== "BLUE" || voter.role === Roles.POLICE.id) continue;

      // Find if voter accused someone in dayChat
      let chatTarget = null;
      for (const line of dayChat) {
        if (line.startsWith("[VOTE] ")) continue;
        if (!line.startsWith(voter.name + ":")) continue;
        const en = (line.split("||")[0] || "").toLowerCase();
        if (
          en.includes("suspicious") ||
          en.includes("don't trust") ||
          en.includes("confirmed red")
        ) {
          for (const p of e.state.players) {
            if (p && p.id !== voter.id && line.includes(p.name)) {
              chatTarget = p.id;
              break;
            }
          }
        }
        if (chatTarget !== null) break;
      }
      if (chatTarget !== null) {
        if (chatTarget === entry.targetId) stats.civVoteMatchesChat++;
        else stats.civVoteMismatchesChat++;
      }
    }
  }

  // ─ Post-game analysis ─

  // Sniper accuracy
  for (const p of e.state.players) {
    if (p.deathCause === "SNIPER_HEADSHOT") {
      stats.sniperTotal++;
      if (p.faction === "BLUE") stats.sniperHitBlue++;
      else if (p.faction === "RED") stats.sniperHitRed++;
      else stats.sniperHitGreen++;
    }
  }

  // Police investigated self/police check
  for (const p of e.state.players) {
    if (p.role !== Roles.POLICE.id) continue;
    const results = p.aiMemory?.investigationResults || [];
    for (const r of results) {
      const tp = e.state.players[r.targetId];
      if (tp?.role === Roles.POLICE.id) stats.policeInvestigatedPolice++;
      if (r.targetId === p.id) stats.policeInvestigatedSelf++;
    }
  }

  // Police reveal count
  if (e.state.policeRevealedRed !== null) stats.policeRevealCount++;

  stats.games++;
}

// ─ Print report ─
console.log("\n══════════════════════════════════════════════════════════");
console.log(`  Behavioral Audit: ${stats.games} games, GOOD_VS_EVIL hard`);
console.log("══════════════════════════════════════════════════════════\n");

console.log("── POLICE ──");
console.log(`  Investigated self: ${stats.policeInvestigatedSelf}`);
console.log(`  Investigated fellow police: ${stats.policeInvestigatedPolice}`);
console.log(`  Games with reveal: ${stats.policeRevealCount}/${stats.games}`);
console.log(
  `  Voted revealed red: ${stats.policeVotedRevealedRed}/${stats.policeVotedRevealedRed + stats.policeDidNotVoteRevealedRed} (${((stats.policeVotedRevealedRed / (stats.policeVotedRevealedRed + stats.policeDidNotVoteRevealedRed || 1)) * 100).toFixed(1)}%)`
);
console.log(
  `  Private chat empty rounds: ${stats.policePrivateChatEmpty}/${stats.policePrivateChatRounds}`
);

console.log("\n── KILLER ──");
console.log(
  `  Vote targeted RED (friendly fire): ${stats.killerTargetedRed}/${stats.killerTargetedRed + stats.killerTargetedBlue} (${((stats.killerTargetedRed / (stats.killerTargetedRed + stats.killerTargetedBlue || 1)) * 100).toFixed(1)}%)`
);
console.log(
  `  3+ killers split vote: ${stats.killerSplitVoteWhen3Plus}/${stats.killerSplitVoteWhen3Plus + stats.killerClusteredVoteWhen3Plus} (${((stats.killerSplitVoteWhen3Plus / (stats.killerSplitVoteWhen3Plus + stats.killerClusteredVoteWhen3Plus || 1)) * 100).toFixed(1)}%)`
);
console.log(
  `  Private chat mentions actual target: ${stats.killerChatMentionsTarget}/${stats.killerChatTotal} (${((stats.killerChatMentionsTarget / (stats.killerChatTotal || 1)) * 100).toFixed(1)}%)`
);
console.log(
  `  Private chat empty rounds: ${stats.killerPrivateChatEmpty}/${stats.killerPrivateChatRounds}`
);

console.log("\n── DOCTOR ──");
console.log(`  Total actions: ${stats.doctorActions}`);
console.log(
  `  Consecutive same target (overdose risk): ${stats.doctorConsecutiveSameTarget}/${stats.doctorActions} (${((stats.doctorConsecutiveSameTarget / (stats.doctorActions || 1)) * 100).toFixed(1)}%)`
);

console.log("\n── SNIPER ──");
console.log(
  `  Total shots: ${stats.sniperTotal} (avg ${(stats.sniperTotal / stats.games).toFixed(2)}/game)`
);
console.log(
  `  Hit BLUE: ${stats.sniperHitBlue} (${((stats.sniperHitBlue / (stats.sniperTotal || 1)) * 100).toFixed(1)}%)`
);
console.log(
  `  Hit RED (friendly fire): ${stats.sniperHitRed} (${((stats.sniperHitRed / (stats.sniperTotal || 1)) * 100).toFixed(1)}%)`
);

console.log("\n── CIVILIAN ──");
const civRevealTotal = stats.civVotedRevealedRed + stats.civDidNotVoteRevealedRed;
console.log(
  `  Voted revealed red: ${stats.civVotedRevealedRed}/${civRevealTotal} (${((stats.civVotedRevealedRed / (civRevealTotal || 1)) * 100).toFixed(1)}%)`
);
const civChatTotal = stats.civVoteMatchesChat + stats.civVoteMismatchesChat;
console.log(
  `  Chat-vote consistency: ${stats.civVoteMatchesChat}/${civChatTotal} (${((stats.civVoteMatchesChat / (civChatTotal || 1)) * 100).toFixed(1)}%)`
);

console.log("\n── CHAT QUALITY ──");
console.log(`  Dead speaker in dayChat: ${stats.deadSpeakerInChat}`);
console.log(`  Empty chat rounds: ${stats.emptyChatRounds}/${stats.chatRounds}`);

console.log("\n── ISSUES (first 30) ──");
if (issues.length === 0) {
  console.log("  No issues found!");
} else {
  console.log(`  Total issues: ${issues.length}`);
  for (const issue of issues.slice(0, 30)) {
    console.log(`  ⚠ ${issue}`);
  }
  if (issues.length > 30) console.log(`  ... and ${issues.length - 30} more`);
}
})();
