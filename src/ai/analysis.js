import { alivePlayers, getPlayer } from "../state.js";
import { Roles, Faction, roleMeta } from "../roles.js";
import { clamp, isHard, ensureAdvancedMemory, rolePriorCounts, mentionedPlayerIds } from "./utils.js";

export function analyzeVotingPatterns(state) {
  const voteHist = state.history?.votes || [];
  // who voted for whom, how many times
  const voteGraph = {}; // voteGraph[actorId][targetId] = count
  const votedTogether = {}; // votedTogether[a][b] = times a and b voted for the same target
  const beenVotedFor = {}; // beenVotedFor[targetId] = total times targeted

  for (const round of voteHist) {
    const targetByActor = {};
    for (const entry of round.order || []) {
      const { actorId, targetId } = entry;
      if (!voteGraph[actorId]) voteGraph[actorId] = {};
      voteGraph[actorId][targetId] = (voteGraph[actorId][targetId] || 0) + 1;
      beenVotedFor[targetId] = (beenVotedFor[targetId] || 0) + 1;
      targetByActor[actorId] = targetId;
    }
    // Detect vote-together pairs (actors who voted for the same target)
    const actors = Object.keys(targetByActor);
    for (let i = 0; i < actors.length; i++) {
      for (let j = i + 1; j < actors.length; j++) {
        const a = actors[i], b = actors[j];
        if (targetByActor[a] === targetByActor[b]) {
          if (!votedTogether[a]) votedTogether[a] = {};
          if (!votedTogether[b]) votedTogether[b] = {};
          votedTogether[a][b] = (votedTogether[a][b] || 0) + 1;
          votedTogether[b][a] = (votedTogether[b][a] || 0) + 1;
        }
      }
    }
  }

  return { voteGraph, votedTogether, beenVotedFor, rounds: voteHist.length };
}

/**
 * Returns the publicly-known revealed red player ID.
 * Police can always see policeRevealedRed (it's their own intel).
 * Other roles only see it after police announced it in public chat (policePublicRevealedRed).
 */
export function publicRevealedRed(state, actor) {
  // Police always know their own investigation results
  if (actor && actor.role === Roles.POLICE.id) return state.policeRevealedRed ?? null;
  // Others only know if it was publicly announced
  return state.policePublicRevealedRed ?? null;
}

/**
 * Returns policeConfirmed data gated by public visibility.
 * Police always see their own confirmations; other roles only see them
 * once the police reveal has been made public (policePublicRevealedRed is set).
 */
export function publicPoliceConfirmed(state, actor) {
  if (actor && actor.role === Roles.POLICE.id) return state.policeConfirmed ?? null;
  const ids = publicRedIds(state);
  if (!ids.size) return null;
  return Object.fromEntries([...ids].map((id) => [id, true]));
}

/**
 * Every red that has been claimed in public (real police reveals and fake claims alike).
 * This is the only "confirmed red" knowledge a non-police player may act on.
 */
export function publicRedIds(state) {
  const ids = new Set(state.policePublicRedIds || []);
  if (state.policePublicRevealedRed != null) ids.add(state.policePublicRevealedRed);
  return ids;
}

/** Record a public red claim so it stays known even after later claims replace the "current" one. */
export function recordPublicRedClaim(state, targetId) {
  state.policePublicRevealedRed = targetId;
  state.policePublicRedIds = state.policePublicRedIds || [];
  if (!state.policePublicRedIds.includes(targetId)) state.policePublicRedIds.push(targetId);
}

/** Mirrors view.js visibility: who may an actor know the true faction of? */
export function canSeeFaction(actor, target) {
  if (!actor || !target) return false;
  if (actor.id === target.id || !target.alive) return true;
  const shared = [Roles.POLICE.id, Roles.KILLER.id, Roles.GRUDGE_BEAST.id];
  return shared.includes(actor.role) && actor.role === target.role;
}

/** Belief-based headcount an actor may legitimately reason about (no true faction reads). */
export function estimateFactionCounts(state, actor) {
  let red = 0;
  let blue = 0;
  for (const t of alivePlayers(state)) {
    if (canSeeFaction(actor, t)) {
      if (t.faction === Faction.RED) red += 1;
      else if (t.faction === Faction.BLUE) blue += 1;
      continue;
    }
    const pr = factionProb(actor, t.id, Faction.RED);
    const pb = factionProb(actor, t.id, Faction.BLUE);
    if (pr === null || pb === null) {
      red += 0.3; // rough prior: about a third of a table is red
      blue += 0.7;
    } else {
      red += pr;
      blue += pb;
    }
  }
  return { red, blue };
}

/**
 * Track chat activity: who mentions whom, who defends/accuses whom.
 */
export function analyzeChatBehavior(state) {
  const chats = state.dayChat || [];
  const speakCount = {};
  const mentionedBy = {}; // mentionedBy[targetId] = [speakerId, ...]

  for (const line of chats) {
    // Skip tagged lines — vote-phase and last words shouldn't count as active chat behavior
    if (line.startsWith("[VOTE] ") || line.startsWith("[LAST] ")) continue;
    const mentioned = mentionedPlayerIds(line, state.players);
    for (const p of state.players) {
      if (!p) continue;
      if (line.startsWith(p.name + ":")) {
        speakCount[p.id] = (speakCount[p.id] || 0) + 1;
      }
      // Track mentions
      if (mentioned.has(p.id) && !line.startsWith(p.name + ":")) {
        if (!mentionedBy[p.id]) mentionedBy[p.id] = [];
        for (const speaker of state.players) {
          if (speaker && line.startsWith(speaker.name + ":") && speaker.id !== p.id) {
            mentionedBy[p.id].push(speaker.id);
          }
        }
      }
    }
  }
  return { speakCount, mentionedBy };
}

/**
 * Compute self-threat level: how suspicious am I to others?
 */
export function computeSelfThreat(state, actor) {
  let threat = 0;
  const voteHist = state.history?.votes || [];
  const lastRound = voteHist[voteHist.length - 1];
  if (lastRound) {
    // How many votes did I receive last round?
    const tally = lastRound.tally || {};
    const myVotes = tally[actor.id] || 0;
    const maxVotes = Math.max(1, ...Object.values(tally));
    threat += (myVotes / maxVotes) * 0.4;
    // Was I mentioned a lot in chat?
    const mentions = lastRound.mentions || {};
    const myMentions = mentions[actor.id] || 0;
    const maxMention = Math.max(1, ...Object.values(mentions));
    threat += (myMentions / maxMention) * 0.2;
  }
  // Am I the publicly-revealed red? (only know if police announced it)
  if ((state.policePublicRevealedRed ?? null) === actor.id) threat += 0.5;
  return clamp(threat, 0, 1);
}

// ─── Advanced: Logical Deduction Chains ──────────────────────────────────

export function applyDeductionChains(state, p) {
  const hard = isHard(state);
  if (!hard) return;
  ensureAdvancedMemory(p);
  const living = alivePlayers(state).map((pl) => pl.id);
  const votePatterns = analyzeVotingPatterns(state);
  const diffScaleMap = { easy: 0.6, normal: 1, hard: 1.3, nightmare: 1.6 };
  const diffScale = diffScaleMap[state.difficulty || "normal"] ?? 1;

  // Trust propagation: If police confirmed A is blue, and A consistently defends B, B gets blue boost
  const confirmedBlues = new Set();
  const confirmedReds = new Set();
  const pubRevealed = publicRevealedRed(state, p);
  if (pubRevealed !== null) confirmedReds.add(pubRevealed);
  // Scan chat memory for defense patterns from confirmed blues
  for (const targetId of living) {
    if (targetId === p.id) continue;
    // Check if this target is confirmed blue via police clearing in chat
    const playerObj = getPlayer(state, targetId);
    if (!playerObj) continue;
    // A player we are >80% sure is blue counts as confirmed for trust propagation
    const blueProb = factionProb(p, targetId, Faction.BLUE) ?? 0.5;
    if (blueProb > 0.8) confirmedBlues.add(targetId);
    const redProb = factionProb(p, targetId, Faction.RED) ?? 0.5;
    if (redProb > 0.8) confirmedReds.add(targetId);
  }

  for (const targetId of living) {
    if (targetId === p.id) continue;
    let trustBoost = 0;
    let suspBoost = 0;

    // Trust propagation from confirmed blues
    for (const blueId of confirmedBlues) {
      if (blueId === targetId) continue;
      const defenses = p.aiMemory.chatMemory.filter(
        (m) => m.speakerId === blueId && m.defendedId === targetId
      );
      if (defenses.length > 0) {
        trustBoost += 0.04 * defenses.length * diffScale;
      }
    }

    // Suspicion propagation from confirmed reds
    for (const redId of confirmedReds) {
      if (redId === targetId) continue;
      const togetherCount = votePatterns.votedTogether[targetId]?.[redId] || 0;
      if (togetherCount > 0) {
        suspBoost += 0.06 * togetherCount * diffScale;
      }
      // Also check if target defended the confirmed red
      const redDefenses = p.aiMemory.chatMemory.filter(
        (m) => m.speakerId === targetId && m.defendedId === redId
      );
      if (redDefenses.length > 0) {
        suspBoost += 0.05 * redDefenses.length * diffScale;
      }
    }

    // Death pattern analysis: if killers target active speakers, boost protection instinct
    const chatBehavior = analyzeChatBehavior(state);
    const maxSpoken = Math.max(1, ...Object.values(chatBehavior.speakCount || {}));
    const recentDeaths = state.players.filter((pl) => !pl.alive && pl.deathCause && pl.deathCause !== "VOTE_EXECUTION");
    let killersTargetActive = 0;
    let killersTargetQuiet = 0;
    for (const dead of recentDeaths) {
      if (dead.faction === Faction.BLUE) {
        const deadSpeak = (chatBehavior.speakCount[dead.id] || 0) / maxSpoken;
        if (deadSpeak > 0.5) killersTargetActive++;
        else killersTargetQuiet++;
      }
    }
    const targetSpeak = (chatBehavior.speakCount[targetId] || 0) / maxSpoken;
    if (killersTargetActive > killersTargetQuiet && targetSpeak > 0.5) {
      // Active speakers are targeted — slightly boost blue (they're threats to red)
      trustBoost += 0.02 * diffScale;
    }

    // Elimination logic: if few killer slots remain and someone is highly suspected
    const rolePriors = rolePriorCounts(state.theme || "GOOD_VS_EVIL");
    const killerSlots = rolePriors[Roles.KILLER.id] || 2;
    const deadReds = state.players.filter((pl) => !pl.alive && pl.faction === Faction.RED).length;
    const remainingKillers = Math.max(0, killerSlots - deadReds);
    if (remainingKillers <= 1) {
      const redProb = factionProb(p, targetId, Faction.RED) ?? 0.5;
      if (redProb > 0.7) {
        suspBoost += 0.1 * diffScale; // Focus votes on the likely last killer
      }
    }

    // Apply boosts to role probs
    if (trustBoost > 0 || suspBoost > 0) {
      const allRoles = Object.keys(p.aiMemory.roleProbs[targetId] || {});
      for (const role of allRoles) {
        const meta = roleMeta(role);
        let mult = 1;
        if (meta.faction === Faction.BLUE) mult += trustBoost;
        if (meta.faction === Faction.RED) mult += suspBoost;
        p.aiMemory.roleProbs[targetId][role] = clamp(
          p.aiMemory.roleProbs[targetId][role] * Math.max(0.01, mult), 0.0001, 1
        );
      }
      // re-normalize
      const sum = Object.values(p.aiMemory.roleProbs[targetId]).reduce((a, b) => a + b, 0) || 1;
      for (const role of allRoles) {
        p.aiMemory.roleProbs[targetId][role] = p.aiMemory.roleProbs[targetId][role] / sum;
      }
      // re-compute suspicion
      const newRedProb = Object.entries(p.aiMemory.roleProbs[targetId]).reduce(
        (acc, [r, prob]) => acc + (roleMeta(r).faction === Faction.RED ? prob : 0), 0
      );
      p.aiMemory.suspicion[targetId] = clamp(newRedProb, 0.01, 0.99);
    }
  }
}

export function factionProb(actor, targetId, faction) {
  const probs = actor.aiMemory?.roleProbs?.[targetId];
  if (!probs) return null;
  let sum = 0;
  for (const [role, prob] of Object.entries(probs)) {
    if (roleMeta(role).faction === faction) sum += prob;
  }
  return sum;
}
