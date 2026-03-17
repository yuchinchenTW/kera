import { alivePlayers, getPlayer } from "../state.js";
import { Roles, Faction, roleMeta } from "../roles.js";
import { clamp, isHard, randomChoice, shuffled, getGamePhase, rolePriorCounts, ensureAdvancedMemory } from "./utils.js";
import { analyzeVotingPatterns, analyzeChatBehavior, factionProb, publicPoliceConfirmed } from "./analysis.js";
import { ensureBeliefs } from "./memory.js";
import { getWeight } from "./learned_weights.js";

export function pickTargetBySuspicion(state, actor, filterFn = () => true) {
  let best = null;
  let bestScore = -1;
  for (const target of alivePlayers(state)) {
    if (target.id === actor.id) continue;
    if (!filterFn(target)) continue;
    const score = actor.aiMemory?.suspicion?.[target.id] ?? 0.5;
    if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
      bestScore = score;
      best = target;
    }
  }
  return best;
}

export function pickPoliceSmartTarget(state, actor) {
  let best = null;
  let bestScore = -Infinity;
  const hard = isHard(state);
  const diffScaleMap = { easy: 0.6, normal: 1, hard: 1.3, nightmare: 1.6 };
  const diffScale = diffScaleMap[state.difficulty || "normal"] ?? 1;

  // Hard+: gather contextual info for smarter investigation
  const chatBehavior = hard ? analyzeChatBehavior(state) : null;
  const maxSpoken = chatBehavior ? Math.max(1, ...Object.values(chatBehavior.speakCount || {})) : 1;
  const votePatterns = hard ? analyzeVotingPatterns(state) : null;

  // Track confirmed reds (dead reds + currently revealed red)
  const knownReds = new Set();
  if (state.policeRevealedRed !== null) knownReds.add(state.policeRevealedRed);
  for (const p of state.players) {
    if (!p.alive && p.faction === Faction.RED) knownReds.add(p.id);
  }

  // Hard+: use investigation history to skip already-investigated targets
  const investigatedIds = new Set();
  if (hard) {
    const results = actor.aiMemory?.investigationResults || [];
    for (const r of results) investigatedIds.add(r.targetId);
  }

  // Hard+: survival analysis — count how many nights each player has survived
  const dayNum = state.dayNumber || 1;
  const blueNightDeaths = state.players.filter(
    (p) => !p.alive && p.deathCause && p.deathCause !== "VOTE_EXECUTION" && p.faction === Faction.BLUE
  ).length;

  // Hard+: identify saved players (confirmed blue by action)
  const savedIds = new Set(hard ? (state.lastNightSavedIds || []) : []);

  // Hard+: arson-marked = confirmed blue (arsonist targets blues)
  const arsonMarkedIds = new Set();
  if (hard) {
    for (const p of state.players) {
      if (p.alive && p.status.arsonMarked) arsonMarkedIds.add(p.id);
    }
  }

  // Hard+: count remaining reds for urgency scaling
  const rolePriors = hard ? rolePriorCounts(state.theme || "GOOD_VS_EVIL") : null;
  const totalRedSlots = rolePriors
    ? Object.entries(rolePriors).reduce((sum, [r, c]) => sum + (roleMeta(r).faction === Faction.RED ? c : 0), 0)
    : 6;
  const deadReds = state.players.filter((p) => !p.alive && p.faction === Faction.RED).length;
  const redsRemaining = Math.max(0, totalRedSlots - deadReds);
  // Urgency multiplier: finding the last red is critical
  const urgency = hard && redsRemaining <= 2 ? 1.3 : 1.0;

  // Hard+: accusation reversal — targets accused by known reds may be blue
  const accusedByRed = new Set();
  if (hard) {
    const chatMem = actor.aiMemory?.chatMemory || [];
    for (const m of chatMem) {
      if (knownReds.has(m.speakerId) && m.accusedId !== undefined) {
        accusedByRed.add(m.accusedId);
      }
    }
  }

  // Hard+: red execution opposers — didn't vote for red when red was executed
  const redExecOpposers = {};
  if (hard) {
    const voteExecReds = state.players.filter((p) => !p.alive && p.deathCause === "VOTE_EXECUTION" && p.faction === Faction.RED);
    for (const dead of voteExecReds) {
      for (const round of (state.history?.votes || [])) {
        if (!round.order || !round.tally) continue;
        const tv = round.tally[dead.id] || 0;
        const mv = Math.max(0, ...Object.values(round.tally));
        if (tv > 0 && tv === mv) {
          for (const entry of round.order) {
            if (entry.targetId !== dead.id) {
              redExecOpposers[entry.actorId] = (redExecOpposers[entry.actorId] || 0) + 1;
            }
          }
        }
      }
    }
  }

  // Hard+: vote pressure — who received the most votes last round
  const lastRound = (state.history?.votes || []).length > 0
    ? (state.history.votes[state.history.votes.length - 1]) : null;
  const lastTally = lastRound ? (lastRound.tally || {}) : {};
  const maxLastVotes = Math.max(1, ...Object.values(lastTally));

  // Phase-based strategy
  const gamePhase = hard ? getGamePhase(state) : "mid";

  for (const t of alivePlayers(state)) {
    if (t.id === actor.id || t.role === Roles.POLICE.id) continue;

    // Skip already-revealed red — no need to investigate again
    if (state.policeRevealedRed === t.id) continue;

    // Skip already confirmed by police
    if (state.policeConfirmed?.[t.id]) continue;

    // Skip already investigated (we know their result)
    if (hard && investigatedIds.has(t.id)) continue;

    const killerProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.KILLER.id] ?? 0;
    const redProb = factionProb(actor, t.id, Faction.RED) ?? 0;
    const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0;

    const likelyBluePower =
      (actor.aiMemory?.roleProbs?.[t.id]?.[Roles.DOCTOR.id] ?? 0) > 0.6 ||
      (actor.aiMemory?.roleProbs?.[t.id]?.[Roles.AGENT?.id] ?? 0) > 0.6;
    if (likelyBluePower && state.rng() < 0.8) continue;

    const P = (feat, def) => getWeight("POLICE", "night", feat, def);
    let score = killerProb * P("killerProb", 2.0) + redProb * P("redProb", 1.0);

    if (hard) {
      // Phase-based information value:
      if (gamePhase === "early") {
        if (redProb > 0.3 && redProb < 0.6) score += P("infoValueEarly", 0.2);
      } else if (gamePhase === "late") {
        if (redProb > 0.6) score += P("infoValueLate", 0.2);
      } else {
        if (redProb > 0.4 && redProb < 0.7) score += 0.15;
      }

      // Bonus: voted together with known reds — suspicious alliance pattern
      if (votePatterns) {
        let redAllyCount = 0;
        for (const redId of knownReds) {
          redAllyCount += votePatterns.votedTogether[t.id]?.[redId] || 0;
        }
        score += Math.min(redAllyCount * P("redAllyVote", 0.08), 0.2);
      }

      // Bonus: defended a known red in chat
      const chatMem = actor.aiMemory?.chatMemory || [];
      for (const m of chatMem) {
        if (m.speakerId === t.id && knownReds.has(m.defendedId)) {
          score += P("redDefended", 0.12);
          break;
        }
      }

      // Bonus: silent players may hide red identity
      if (chatBehavior) {
        const speakRatio = (chatBehavior.speakCount[t.id] || 0) / maxSpoken;
        if (speakRatio < 0.15 && redProb > 0.35) score += P("silentRedLean", 0.1);
      }

      // Sniper/kidnapper probability — also high-value red targets to expose
      const sniperProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.SNIPER?.id] ?? 0;
      const kidnapProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.KIDNAPPER?.id] ?? 0;
      score += sniperProb * P("sniperProb", 0.8) + kidnapProb * P("kidnapProb", 0.5);

      // Survival analysis: active players who survive many nights are suspicious.
      if (dayNum >= 3 && chatBehavior) {
        const speakRatio = (chatBehavior.speakCount[t.id] || 0) / maxSpoken;
        if (speakRatio > 0.4 && blueNightDeaths >= 2) {
          score += P("survivalSusp", 0.12);
        }
      }

      // Post-reveal red ally priority
      if (knownReds.size > 0 && votePatterns) {
        let maxAllyScore = 0;
        for (const redId of knownReds) {
          const together = votePatterns.votedTogether[t.id]?.[redId] || 0;
          maxAllyScore = Math.max(maxAllyScore, together);
        }
        if (maxAllyScore >= 2) score += P("postRevealAlly", 0.15);
      }

      // Bonus: red execution opposers
      if (redExecOpposers[t.id]) {
        score += Math.min(redExecOpposers[t.id] * P("redExecOpposer", 0.1), 0.25);
      }

      // Bonus: vote pressure
      if (lastRound) {
        const tVotes = lastTally[t.id] || 0;
        if (tVotes > 0) {
          const voteRatio = tVotes / maxLastVotes;
          if (voteRatio > 0.5 && redProb > 0.3 && redProb < 0.8) {
            score += voteRatio * P("votePressure", 0.2);
          }
        }
      }

      // Saved target avoidance: doctor-saved players are confirmed blue
      if (savedIds.has(t.id)) score += P("savedAvoid", -0.3);

      // Arson-marked avoidance
      if (arsonMarkedIds.has(t.id)) score += P("arsonAvoid", -0.25);

      // Accusation reversal: targets accused by known reds are likely blue
      if (accusedByRed.has(t.id)) score += P("accusedByRedAvoid", -0.15);

      // Kidnap risk: if someone was kidnapped this/last night, investigating the kidnapper
      // triggers hostage execution. Deprioritize high-kidnapper-probability targets.
      const hasActiveHostage = (state.lastNightSummary || []).some(
        (e) => typeof e === "string" && e.includes("kidnapped")
      );
      if (hasActiveHostage) {
        const kidnapProb2 = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.KIDNAPPER?.id] ?? 0;
        if (kidnapProb2 > 0.2) score -= kidnapProb2 * 0.5;
      }

      // Urgency: when few reds remain, amplify scores to prioritize high-value targets
      score *= urgency;
    }

    // Day 1: more jitter since we have less info
    const jitter = dayNum <= 1 ? 0.18 : 0.1;
    score = clamp(score + (state.rng() - 0.5) * jitter * diffScale, 0, 4);
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

export function pickGroupTarget(state, actors, filterFn = () => true) {
  const candidates = alivePlayers(state).filter((p) => filterFn(p));
  let best = null;
  let bestScore = -Infinity;
  for (const target of candidates) {
    let total = 0;
    let count = 0;
    for (const actor of actors) {
      if (!actor.aiMemory || actor.id === target.id) continue;
      const s = actor.aiMemory.suspicion?.[target.id];
      if (s !== undefined) {
        total += s;
        count += 1;
      }
    }
    if (count === 0) continue;
    const avg = total / count;
    if (avg > bestScore || (avg === bestScore && state.rng() < 0.5)) {
      bestScore = avg;
      best = target;
    }
  }
  return best;
}

export function pickZombieTarget(state, actor) {
  let best = null;
  let bestScore = -Infinity;
  for (const t of shuffled(alivePlayers(state), state.rng)) {
    if (t.id === actor.id) continue;
    const zombieProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.ZOMBIE.id] ?? 0;
    const notZombieProb = 1 - zombieProb;
    const score = notZombieProb;
    if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

// ─── Hard+ Terrorist Smart Targeting ──────────────────────────────────────

/**
 * Hard+ terrorist target selection: pick the highest-value BLUE target.
 * - Terrorist is RED, suicide bomb kills self + target (if target is blue).
 * - Bombing a red = only self dies (net loss). Must avoid red targets.
 * - Prioritize police > doctor > agent > active blue civilians.
 */
export function pickTerroristSmartTarget(state, actor) {
  const chatBehavior = analyzeChatBehavior(state);
  const maxSpoken = Math.max(1, ...Object.values(chatBehavior.speakCount || {}));
  const votePatterns = analyzeVotingPatterns(state);
  let best = null;
  let bestScore = -Infinity;

  // Terrorist does NOT know who other reds are (different role = no shared info).
  // Use public info only: policeRevealedRed, dead player factions, AI suspicion.
  const knownReds = new Set();
  if ((state.policePublicRevealedRed ?? null) !== null) knownReds.add((state.policePublicRevealedRed ?? null));
  for (const p of state.players) {
    if (!p.alive && p.faction === Faction.RED) knownReds.add(p.id);
  }

  // Estimate likely killer target tonight (avoid overlap — both killing same blue is wasteful)
  // Use observable signals: high blue prob + active speaker = likely killer target
  let likelyKillerTarget = null;
  let likelyKillerScore = -Infinity;
  for (const t of alivePlayers(state)) {
    if (t.id === actor.id) continue;
    const bp = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
    const rp = factionProb(actor, t.id, Faction.RED) ?? 0.5;
    if (rp > 0.6) continue; // likely red, killers won't target
    const sr = (chatBehavior.speakCount[t.id] || 0) / maxSpoken;
    const ks = bp + sr * 0.3;
    if (ks > likelyKillerScore) { likelyKillerScore = ks; likelyKillerTarget = t.id; }
  }

  for (const t of alivePlayers(state)) {
    if (t.id === actor.id) continue;

    const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
    const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
    const policeProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.POLICE.id] ?? 0;
    const doctorProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.DOCTOR.id] ?? 0;
    const agentProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.AGENT?.id] ?? 0;

    // Base: prefer blue targets (bombing red = only self dies)
    let score = blueProb * 1.5;

    // Heavy penalty for uncertain targets — bombing unknown is risky
    score -= redProb * 2.0;

    // High-value role bonuses — police are the biggest threat to red team
    score += policeProb * 1.2;
    score += doctorProb * 0.8;
    score += agentProb * 0.6;

    // Active speakers who are blue = high-influence targets worth bombing
    const speakRatio = (chatBehavior.speakCount[t.id] || 0) / maxSpoken;
    if (blueProb > 0.5) score += speakRatio * 0.3;

    // Police-confirmed red? NEVER bomb — guaranteed only self dies
    if (publicPoliceConfirmed(state, actor)?.[t.id]) score -= 3.0;

    // Voted together with known reds = possibly red ally, avoid
    if (votePatterns) {
      let redAllyCount = 0;
      for (const redId of knownReds) {
        redAllyCount += votePatterns.votedTogether[t.id]?.[redId] || 0;
      }
      score -= Math.min(redAllyCount * 0.1, 0.3);
    }

    // Saved by doctor last night = confirmed blue, high-value target
    if ((state.lastNightSavedIds || []).includes(t.id)) {
      score += 0.4; // confirmed blue = very worth bombing
    }

    // Avoid overlap with killer's likely target — don't waste 2 red actions on 1 blue
    if (t.id === likelyKillerTarget) {
      score -= 0.35;
    }

    // Bonus: target who accused known reds in chat (actively hunting red team)
    const chatMem = actor.aiMemory?.chatMemory || [];
    for (const m of chatMem) {
      if (m.speakerId === t.id) {
        for (const redId of knownReds) {
          if (m.accusedId === redId) { score += 0.15; break; }
        }
      }
    }

    score += (state.rng() - 0.5) * 0.1;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

// ─── Hard+ Killer Smart Targeting ──────────────────────────────────────────

/**
 * Hard+ killer target selection: avoid likely protected targets, prioritize threats.
 * - Avoids players likely protected by doctor (high blue prob + high police/doctor prob)
 * - Prioritizes active speakers (threats who influence votes)
 * - Considers who is most dangerous to red team
 */
export function pickKillerSmartTarget(state, actor) {
  const chatBehavior = analyzeChatBehavior(state);
  const maxSpoken = Math.max(1, ...Object.values(chatBehavior.speakCount || {}));
  const votePatterns = analyzeVotingPatterns(state);
  let best = null;
  let bestScore = -Infinity;

  // Pre-compute: who correctly voted to execute reds (dangerous to red team)
  const correctVoters = new Set();
  const voteExecutedReds = state.players.filter((p) => !p.alive && p.deathCause === "VOTE_EXECUTION" && p.faction === Faction.RED);
  for (const dead of voteExecutedReds) {
    for (const round of (state.history?.votes || [])) {
      if (!round.order || !round.tally) continue;
      const theirVotes = round.tally[dead.id] || 0;
      const maxVotes = Math.max(0, ...Object.values(round.tally));
      if (theirVotes > 0 && theirVotes === maxVotes) {
        for (const entry of round.order) {
          if (entry.targetId === dead.id) correctVoters.add(entry.actorId);
        }
      }
    }
  }

  // Pre-compute: who accused reds in chat (threat to red team)
  const redAccuserCount = {};
  const knownDeadReds = new Set();
  for (const p of state.players) {
    if (!p.alive && p.faction === Faction.RED) knownDeadReds.add(p.id);
  }
  if ((state.policePublicRevealedRed ?? null) !== null) knownDeadReds.add((state.policePublicRevealedRed ?? null));
  for (const p of state.players) {
    if (!p.aiMemory?.chatMemory) continue;
    for (const m of p.aiMemory.chatMemory) {
      if (m.accusedId !== null && knownDeadReds.has(m.accusedId)) {
        redAccuserCount[m.speakerId] = (redAccuserCount[m.speakerId] || 0) + 1;
      }
    }
  }

  // Pre-compute: arson-marked targets (will die on ignition — don't waste kill)
  const arsonMarkedIds = new Set();
  for (const p of state.players) {
    if (p.alive && p.status.arsonMarked) arsonMarkedIds.add(p.id);
  }

  // Pre-compute: saved last night
  const savedLastNight = new Set(state.lastNightSavedIds || []);

  // Pre-compute: heavily voted targets (might be voted out — lower priority for night kill)
  const heavilyVoted = new Set();
  if (votePatterns && votePatterns.rounds > 0) {
    for (const [tid, count] of Object.entries(votePatterns.beenVotedFor)) {
      if (count / votePatterns.rounds >= 2.5) heavilyVoted.add(Number(tid));
    }
  }

  // Pre-compute: players defended by publicly-claimed police in chat (likely doctor-protected)
  // Uses roleClaims (public info) instead of speaker.role (hidden info) to avoid info leak
  const killerBlueDefended = new Set();
  for (const p of state.players) {
    if (!p.aiMemory?.chatMemory) continue;
    for (const m of p.aiMemory.chatMemory) {
      if (m.defendedId === null) continue;
      // Only treat as police if they publicly claimed the role
      const claimedPolice = state.roleClaims?.[m.speakerId] === Roles.POLICE.id;
      if (claimedPolice) {
        killerBlueDefended.add(m.defendedId);
      }
    }
  }

  // Pre-compute: doctor protection prediction — who would doctor protect tonight?
  // Doctor faces overdose dilemma: protecting same target twice risks empty injection.
  // So doctor is LESS likely to re-protect saved targets, not more.
  const doctorProtectScore = {};
  for (const t of alivePlayers(state)) {
    if (t.role === Roles.KILLER.id) continue;
    let dp = 0;
    if (savedLastNight.has(t.id)) dp -= 0.2; // doctor avoids repeat → overdose risk
    if (correctVoters.has(t.id)) dp += 0.2;
    if (redAccuserCount[t.id]) dp += 0.15;
    if (killerBlueDefended.has(t.id)) dp += 0.3; // police confirmed = doctor priority
    const sp = (chatBehavior.speakCount[t.id] || 0) / maxSpoken;
    if (sp > 0.5) dp += 0.1; // active speakers get protected
    doctorProtectScore[t.id] = dp;
  }

  for (const t of shuffled(alivePlayers(state), state.rng)) {
    if (t.role === Roles.KILLER.id) continue;
    if (t.id === actor.id) continue;

    // Avoid grudge beasts: night-killing them triggers berserk → catastrophic for red
    const grudgeProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.GRUDGE_BEAST?.id] ?? 0;
    if (grudgeProb > 0.3) continue; // skip high-probability grudge targets entirely

    const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
    const policeProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.POLICE.id] ?? 0;
    const doctorProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.DOCTOR.id] ?? 0;
    const agentProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.AGENT?.id] ?? 0;

    // Base: prefer blue targets
    const W = (feat, def) => getWeight("KILLER", "night", feat, def);
    let score = blueProb * W("blueProb", 1.0);

    // ── #1 PRIORITY: publicly-claimed police must die ──
    // A police who has revealed intel is the single biggest threat to red.
    // This overrides ALL other considerations (protection, saves, etc.)
    const claimedPolice = state.roleClaims?.[t.id] === Roles.POLICE.id;
    if (claimedPolice) {
      score += 1.5; // massive bonus — killing revealed police is always worth it
    }

    // Bonus: police probability from beliefs
    score += policeProb * W("policeProb", 0.8);

    // Bonus: doctor is high-value — every night save wastes a kill
    score += doctorProb * W("doctorProb", 0.6);

    // Bonus: active speakers are threats (they influence votes)
    const speakRatio = (chatBehavior.speakCount[t.id] || 0) / maxSpoken;
    score += speakRatio * W("speakRatio", 0.3);

    // Bonus: correct voters are dangerous — they identify reds successfully
    if (correctVoters.has(t.id)) score += W("correctVoter", 0.4);

    // Bonus: red accusers are threats — they call out reds in chat
    if (redAccuserCount[t.id]) score += Math.min(redAccuserCount[t.id] * W("redAccuser", 0.15), 0.4);

    // Penalty: arson-marked targets will die on ignition — wasted kill
    if (arsonMarkedIds.has(t.id) && arsonMarkedIds.size >= 2) score += W("arsonMarked", -0.4);

    // Penalty: heavily voted targets may be voted out — save the kill
    if (heavilyVoted.has(t.id)) score += W("heavilyVoted", -0.3);

    // Doctor protection — less relevant if target is confirmed police (must kill regardless)
    if (!claimedPolice) {
      const dpScore = doctorProtectScore[t.id] || 0;
      score -= dpScore * Math.abs(W("doctorProtect", 0.6));
    }

    // Penalty: likely protected by agent (but not for confirmed police — worth the risk)
    if (!claimedPolice) {
      score += agentProb * W("agentProb", -0.3);
    }

    // Bonus: saved last night — doctor faces overdose dilemma if they protect again.
    if (savedLastNight.has(t.id)) {
      score += W("savedLastNight", 0.25);
    }
    // Target type rotation after successful kill
    if (state.killerLastTarget !== undefined && t.id !== state.killerLastTarget) {
      const lastTargetPlayer = getPlayer(state, state.killerLastTarget);
      if (lastTargetPlayer && !lastTargetPlayer.alive) {
        const lastSpeakRatio = (chatBehavior.speakCount[state.killerLastTarget] || 0) / maxSpoken;
        if (lastSpeakRatio > 0.5 && speakRatio < 0.3) score += 0.15;
        if (lastSpeakRatio < 0.3 && speakRatio > 0.5) score += 0.15;
      }
    }

    if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

export function pickCowboySmartTarget(state, actor) {
  const chatBehavior = analyzeChatBehavior(state);
  const maxSpoken = Math.max(1, ...Object.values(chatBehavior.speakCount || {}));
  const votePatterns = analyzeVotingPatterns(state);
  let best = null;
  let bestScore = -Infinity;

  // Identify who was saved last night (likely blue — doctor protects blue)
  const savedLastNight = new Set(state.lastNightSavedIds || []);

  // Identify confirmed reds for vote-pattern cross-referencing
  const confirmedReds = new Set();
  if ((state.policePublicRevealedRed ?? null) !== null) confirmedReds.add((state.policePublicRevealedRed ?? null));
  for (const p of state.players) {
    if (!p.alive && p.faction === Faction.RED) confirmedReds.add(p.id);
  }

  // Red execution opposers — didn't vote for red when red was executed
  const redExecOpposers = {};
  const voteExecutedReds = state.players.filter((p) => !p.alive && p.deathCause === "VOTE_EXECUTION" && p.faction === Faction.RED);
  for (const dead of voteExecutedReds) {
    for (const round of (state.history?.votes || [])) {
      if (!round.order || !round.tally) continue;
      const theirVotes = round.tally[dead.id] || 0;
      const maxVotes = Math.max(0, ...Object.values(round.tally));
      if (theirVotes > 0 && theirVotes === maxVotes) {
        for (const entry of round.order) {
          if (entry.targetId !== dead.id) {
            redExecOpposers[entry.actorId] = (redExecOpposers[entry.actorId] || 0) + 1;
          }
        }
      }
    }
  }

  // Blue evidence: arson-marked, accused by reds
  const arsonMarkedIds = new Set();
  for (const p of state.players) {
    if (p.alive && p.status.arsonMarked) arsonMarkedIds.add(p.id);
  }
  const accusedByRedIds = new Set();
  for (const p of state.players) {
    if (!p.aiMemory?.chatMemory) continue;
    for (const m of p.aiMemory.chatMemory) {
      if (m.accusedId === null) continue;
      const speaker = getPlayer(state, m.speakerId);
      if (!speaker) continue;
      const isKnownRed = (!speaker.alive && speaker.faction === Faction.RED) ||
        (publicPoliceConfirmed(state, actor)?.[m.speakerId] === true);
      if (isKnownRed) accusedByRedIds.add(m.accusedId);
    }
  }

  for (const t of shuffled(alivePlayers(state), state.rng)) {
    if (t.id === actor.id) continue;

    // Base: prefer high-suspicion (red) targets
    const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
    let score = redProb;

    // Bonus: killer is the WIN CONDITION — killing a killer is the most valuable action
    const killerProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.KILLER.id] ?? 0;
    score += killerProb * 0.8;

    // Bonus: sniper kills blue every night
    const sniperProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.SNIPER?.id] ?? 0;
    score += sniperProb * 0.4;

    // Bonus: other dangerous red roles
    const kidnapperProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.KIDNAPPER?.id] ?? 0;
    score += kidnapperProb * 0.3;

    // Penalty: high blue probability — avoid friendly fire
    const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
    score -= blueProb * 0.3;

    // Bonus: police revealed this player as red — confirmed target
    if ((state.policePublicRevealedRed ?? null) === t.id) score += 0.6;

    // Penalty: saved by doctor = confirmed blue
    if (savedLastNight.has(t.id)) score -= 0.5;

    // Penalty: arson-marked = likely blue (arsonist targets blues)
    if (arsonMarkedIds.has(t.id)) score -= 0.2;

    // Penalty: accused by known reds = likely blue
    if (accusedByRedIds.has(t.id)) score -= 0.15;

    // Penalty: grudge beast — night-killing them triggers berserk
    const cowboyGrudgeProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.GRUDGE_BEAST?.id] ?? 0;
    if (cowboyGrudgeProb > 0.2) score -= 1.0;

    // Bonus: opposed red execution = suspicious
    if (redExecOpposers[t.id]) {
      score += Math.min(redExecOpposers[t.id] * 0.12, 0.3);
    }

    // Bonus: voted together with confirmed reds — suspicious ally pattern
    let redAllyScore = 0;
    for (const redId of confirmedReds) {
      const together = votePatterns.votedTogether[t.id]?.[redId] || 0;
      if (together > 0) redAllyScore += 0.08 * together;
    }
    score += Math.min(redAllyScore, 0.25);

    // Bonus: defended a confirmed red in chat — suspicious
    const chatMem = actor.aiMemory?.chatMemory || [];
    for (const m of chatMem) {
      if (m.speakerId === t.id && confirmedReds.has(m.defendedId)) {
        score += 0.15;
        break;
      }
    }

    // Bonus: quiet + red-leaning = hiding
    const speakRatio = (chatBehavior.speakCount[t.id] || 0) / maxSpoken;
    if (speakRatio < 0.2 && redProb > 0.4) score += 0.1;

    if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

export function pickSniperSmartTarget(state, actor) {
  const chatBehavior = analyzeChatBehavior(state);
  const maxSpoken = Math.max(1, ...Object.values(chatBehavior.speakCount || {}));
  let best = null;
  let bestScore = -Infinity;

  // Sniper can't see red allies — must rely on accumulated evidence.
  // Conserve bullets early; only shoot when there's positive blue evidence.
  ensureBeliefs(state);
  const dayNum = state.dayNumber || 1;

  // Calculate suspicion threshold — skip the top 1/3 most suspicious (likely red allies)
  const candidates = alivePlayers(state).filter((t) => t.id !== actor.id);
  const suspValues = candidates.map((t) => actor.aiMemory?.suspicion?.[t.id] ?? 0.5);
  const sortedSusp = suspValues.slice().sort((a, b) => a - b);
  const suspThreshold = sortedSusp[Math.floor(sortedSusp.length * 2 / 3)] ?? 0.5;

  // Identify confirmed-blue signals: saved by doctor, accused by known reds
  const confirmedBluish = new Set(state.lastNightSavedIds || []);
  // Players accused by known reds are likely blue
  const knownRedIds = new Set();
  if ((state.policePublicRevealedRed ?? null) !== null) knownRedIds.add((state.policePublicRevealedRed ?? null));
  for (const p of state.players) {
    if (!p.alive && p.faction === Faction.RED) knownRedIds.add(p.id);
  }
  for (const p of state.players) {
    if (!p?.aiMemory?.chatMemory) continue;
    for (const m of p.aiMemory.chatMemory) {
      if (knownRedIds.has(m.speakerId) && m.accusedId !== null) {
        confirmedBluish.add(m.accusedId);
      }
    }
  }

  for (const t of shuffled(alivePlayers(state), state.rng)) {
    if (t.id === actor.id) continue;

    const suspicion = actor.aiMemory?.suspicion?.[t.id] ?? 0.5;
    const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
    const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;

    // Skip targets in the top 1/3 of suspicion — they might be red allies
    if (suspicion >= suspThreshold) continue;

    // Base: inverse suspicion (low = confident blue = good target)
    let score = (1.0 - suspicion);

    // Strong bonus: confirmed blue through game mechanics
    if (confirmedBluish.has(t.id)) score += 0.5;

    // Bonus: belief spread — when blueProb >> redProb, we're more confident
    score += (blueProb - redProb) * 0.3;

    // Bonus: police are the biggest threat to red team
    const policeProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.POLICE.id] ?? 0;
    score += policeProb * 0.6;

    // Bonus: active speakers influence votes against red — prioritize silencing them
    const speakRatio = (chatBehavior.speakCount[t.id] || 0) / maxSpoken;
    score += speakRatio * 0.15;

    // Penalty: likely protected by doctor/agent — don't waste precious bullets
    const doctorProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.DOCTOR.id] ?? 0;
    const agentProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.AGENT?.id] ?? 0;
    score -= (doctorProb * 0.4 + agentProb * 0.3) * 0.5;

    // Penalty: target was saved last night — likely still protected
    if ((state.lastNightSavedIds || []).includes(t.id)) {
      score -= 0.7;
    }

    // Penalty: grudge beast — night-killing them triggers berserk
    const sniperGrudgeProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.GRUDGE_BEAST?.id] ?? 0;
    if (sniperGrudgeProb > 0.2) score -= 1.5; // heavily avoid

    if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
      bestScore = score;
      best = t;
    }
  }

  // Fallback: if threshold filtered everyone out, pick lowest-suspicion candidate
  if (!best && candidates.length > 0) {
    let fallback = null;
    let lowestSusp = Infinity;
    for (const t of shuffled(candidates, state.rng)) {
      const s = actor.aiMemory?.suspicion?.[t.id] ?? 0.5;
      if (s < lowestSusp) { lowestSusp = s; fallback = t; }
    }
    best = fallback;
  }

  return best;
}
