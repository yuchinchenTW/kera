import { getPlayer, alivePlayers } from "./state.js";
import { Roles, Faction, Theme, roleListFromTheme, roleMeta } from "./roles.js";

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

function rolePriorCounts(themeId) {
  const list = roleListFromTheme(themeId);
  const counts = {};
  for (const r of list) counts[r] = (counts[r] || 0) + 1;
  return counts;
}

function isHard(state) {
  return state.difficulty === "hard" || state.difficulty === "nightmare";
}

// ─── Behavioral Analysis ───────────────────────────────────────────────────

function ensureAdvancedMemory(p) {
  if (!p.aiMemory) p.aiMemory = { suspicion: {}, roleProbs: {} };
  if (!p.aiMemory.roleProbs) p.aiMemory.roleProbs = {};
  if (!p.aiMemory.suspicion) p.aiMemory.suspicion = {};
  if (!p.aiMemory.voteHistory) p.aiMemory.voteHistory = {};
  if (!p.aiMemory.defenseHistory) p.aiMemory.defenseHistory = {};
  if (!p.aiMemory.selfThreat) p.aiMemory.selfThreat = 0;
  if (!p.aiMemory.chatActivity) p.aiMemory.chatActivity = {};
}

/**
 * Analyze voting patterns across all historical rounds.
 * Returns per-player signals: consistency, mutual voting pairs, etc.
 */
function analyzeVotingPatterns(state) {
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
 * Track chat activity: who mentions whom, who defends/accuses whom.
 */
function analyzeChatBehavior(state) {
  const chats = state.dayChat || [];
  const speakCount = {};
  const mentionedBy = {}; // mentionedBy[targetId] = [speakerId, ...]

  for (const line of chats) {
    for (const p of state.players) {
      if (!p) continue;
      if (line.startsWith(p.name + ":")) {
        speakCount[p.id] = (speakCount[p.id] || 0) + 1;
      }
      // Track mentions
      if (line.includes(p.name) && !line.startsWith(p.name + ":")) {
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
function computeSelfThreat(state, actor) {
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
  // Am I the police-revealed red?
  if (state.policeRevealedRed === actor.id) threat += 0.5;
  return clamp(threat, 0, 1);
}

// ─── Enhanced Belief System ────────────────────────────────────────────────

function ensureBeliefs(state) {
  const living = alivePlayers(state).map((p) => p.id);
  const diffScaleMap = { easy: 0.6, normal: 1, hard: 1.3, nightmare: 1.6 };
  const diffScale = diffScaleMap[state.difficulty || "normal"] ?? 1;
  const hard = isHard(state);
  const revealedRed = state.policeRevealedRed;
  const lastVoteHist = state.history?.votes?.[state.history.votes.length - 1] || null;
  const mentionMax = lastVoteHist?.mentions ? Math.max(1, ...Object.values(lastVoteHist.mentions)) : 1;
  const flipSet = new Set(lastVoteHist?.flips || []);
  const firstVoterId = lastVoteHist?.order?.[0]?.actorId ?? null;
  const lastVoterId = lastVoteHist?.order?.[lastVoteHist.order.length - 1]?.actorId ?? null;
  const lastTally = lastVoteHist?.tally || {};
  const rolePriors = rolePriorCounts(state.theme || Theme.GOOD_VS_EVIL.id);
  const allRoles = Object.keys(rolePriors);
  const totalPrior = Math.max(1, Object.values(rolePriors).reduce((a, b) => a + b, 0));

  // Hard+ behavioral analysis
  const votePatterns = hard ? analyzeVotingPatterns(state) : null;
  const chatBehavior = hard ? analyzeChatBehavior(state) : null;

  // Identify dead players and their death correlations
  const recentDeaths = state.players.filter((p) => !p.alive && p.deathCause);

  for (const p of alivePlayers(state)) {
    if (p.isHuman) continue;
    ensureAdvancedMemory(p);

    // Update self-threat
    if (hard) {
      p.aiMemory.selfThreat = computeSelfThreat(state, p);
    }

    for (const targetId of living) {
      if (targetId === p.id) continue;
      // 初始化或衰減到先驗
      if (!p.aiMemory.roleProbs[targetId]) p.aiMemory.roleProbs[targetId] = {};
      const decay = 0.9;
      for (const role of allRoles) {
        const prior = (rolePriors[role] || 0) / totalPrior;
        const prev = p.aiMemory.roleProbs[targetId][role] ?? prior;
        const blended = prior * (1 - decay) + prev * decay;
        p.aiMemory.roleProbs[targetId][role] = blended;
      }
      // likelihood bumps
      let redBoost = 0;
      let blueBoost = 0;
      if (lastVoteHist?.mentions && lastVoteHist.mentions[targetId]) {
        const weight = (lastVoteHist.mentions[targetId] || 0) / mentionMax;
        redBoost += 0.05 * weight * diffScale;
      }
      if (flipSet.has(targetId)) redBoost += 0.15 * diffScale;
      if (targetId === lastVoterId) redBoost += 0.15 * diffScale;
      if (targetId === firstVoterId) redBoost -= 0.05 * diffScale;
      const tallyScore = lastTally[targetId] || 0;
      const maxTally = Math.max(1, ...Object.values(lastTally || {}));
      if (tallyScore && maxTally > 0) {
        const bandwagon = tallyScore / maxTally;
        redBoost += 0.08 * bandwagon * diffScale;
      }
      if (revealedRed && targetId === revealedRed && p.faction === Faction.BLUE) {
        redBoost += 0.6 * diffScale;
      }

      // ── Hard+ behavioral signals (no cheating, purely observable) ──

      if (hard && votePatterns) {
        // Signal 1: Vote consistency — someone who always votes the same person is suspicious
        const targetVoteGraph = votePatterns.voteGraph[targetId];
        if (targetVoteGraph && votePatterns.rounds >= 2) {
          const targets = Object.keys(targetVoteGraph);
          const totalVotes = Object.values(targetVoteGraph).reduce((a, b) => a + b, 0);
          // If they always vote the same person, slight blue boost (consistent = less suspicious)
          if (targets.length === 1 && totalVotes >= 2) {
            blueBoost += 0.03 * diffScale;
          }
        }

        // Signal 2: Mutual voting pairs — two people never voting each other = potential allies
        const togetherCount = votePatterns.votedTogether[targetId]?.[p.id] || 0;
        if (votePatterns.rounds >= 2 && togetherCount >= 2) {
          // They vote with me a lot — could be same faction
          blueBoost += 0.05 * diffScale;
        }

        // Signal 3: Someone who voted for a player who turned out innocent (died blue) — less reliable
        for (const dead of recentDeaths) {
          if (dead.faction === Faction.BLUE && dead.deathCause === "VOTE_EXECUTION") {
            const votedForInnocent = votePatterns.voteGraph[targetId]?.[dead.id] || 0;
            if (votedForInnocent > 0) {
              redBoost += 0.1 * diffScale;
            }
          }
          // Someone who defended a dead red player — suspicious
          if (dead.faction === Faction.RED) {
            const defenseCount = p.aiMemory.defenseHistory[targetId]?.[dead.id] || 0;
            if (defenseCount > 0) {
              redBoost += 0.12 * diffScale;
            }
          }
        }
      }

      if (hard && chatBehavior) {
        // Signal 4: Silence analysis — people who never speak are slightly more suspicious
        const spoken = chatBehavior.speakCount[targetId] || 0;
        const maxSpoken = Math.max(1, ...Object.values(chatBehavior.speakCount));
        if (spoken === 0 && maxSpoken > 0) {
          redBoost += 0.04 * diffScale;
        }
      }

      // 不使用真實陣營偏置，避免作弊。
      // 應用到角色分布
      for (const role of allRoles) {
        const meta = roleMeta(role);
        let mult = 1;
        if (meta.faction === Faction.RED) mult += redBoost;
        if (meta.faction === Faction.BLUE) mult += blueBoost;
        p.aiMemory.roleProbs[targetId][role] = clamp(p.aiMemory.roleProbs[targetId][role] * Math.max(0.01, mult), 0.0001, 1);
      }
      // normalize
      const sum = Object.values(p.aiMemory.roleProbs[targetId]).reduce((a, b) => a + b, 0) || 1;
      for (const role of allRoles) {
        p.aiMemory.roleProbs[targetId][role] = p.aiMemory.roleProbs[targetId][role] / sum;
      }
      // 對舊邏輯的兼容：用紅方機率總和作為 suspicion。
      const redProb = Object.entries(p.aiMemory.roleProbs[targetId]).reduce(
        (acc, [r, prob]) => acc + (roleMeta(r).faction === Faction.RED ? prob : 0),
        0
      );
      p.aiMemory.suspicion[targetId] = clamp(redProb, 0.01, 0.99);
    }
  }
}

// ─── Target Selection Helpers ──────────────────────────────────────────────

function pickTargetBySuspicion(state, actor, filterFn = () => true) {
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

function factionProb(actor, targetId, faction) {
  const probs = actor.aiMemory?.roleProbs?.[targetId];
  if (!probs) return null;
  let sum = 0;
  for (const [role, prob] of Object.entries(probs)) {
    if (roleMeta(role).faction === faction) sum += prob;
  }
  return sum;
}

function pickPoliceSmartTarget(state, actor) {
  let best = null;
  let bestScore = -Infinity;
  const diffScaleMap = { easy: 0.6, normal: 1, hard: 1.3, nightmare: 1.6 };
  const diffScale = diffScaleMap[state.difficulty || "normal"] ?? 1;
  for (const t of alivePlayers(state)) {
    if (t.id === actor.id || t.role === Roles.POLICE.id) continue;
    const killerProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.KILLER.id] ?? 0;
    const redProb = factionProb(actor, t.id, Faction.RED) ?? 0;
    const likelyBluePower =
      (actor.aiMemory?.roleProbs?.[t.id]?.[Roles.DOCTOR.id] ?? 0) > 0.6 ||
      (actor.aiMemory?.roleProbs?.[t.id]?.[Roles.AGENT?.id] ?? 0) > 0.6;
    if (likelyBluePower && state.rng() < 0.8) continue;
    let score = killerProb * 2 + redProb;
    score = clamp(score + (state.rng() - 0.5) * 0.1 * diffScale, 0, 3);
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

function randomChoice(list, rng) {
  if (!list.length) return null;
  const idx = Math.floor(rng() * list.length);
  return list[idx];
}

function shuffled(list, rng) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickGroupTarget(state, actors, filterFn = () => true) {
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

function pickZombieTarget(state, actor) {
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

// ─── Hard+ Killer Smart Targeting ──────────────────────────────────────────

/**
 * Hard+ killer target selection: avoid likely protected targets, prioritize threats.
 * - Avoids players likely protected by doctor (high blue prob + high police/doctor prob)
 * - Prioritizes active speakers (threats who influence votes)
 * - Considers who is most dangerous to red team
 */
function pickKillerSmartTarget(state, actor) {
  const chatBehavior = analyzeChatBehavior(state);
  const maxSpoken = Math.max(1, ...Object.values(chatBehavior.speakCount || {}));
  let best = null;
  let bestScore = -Infinity;

  for (const t of shuffled(alivePlayers(state), state.rng)) {
    if (t.role === Roles.KILLER.id) continue;
    if (t.id === actor.id) continue;

    const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
    const policeProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.POLICE.id] ?? 0;
    const doctorProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.DOCTOR.id] ?? 0;
    const agentProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.AGENT?.id] ?? 0;

    // Base: prefer blue targets
    let score = blueProb;

    // Bonus: police are high-value targets
    score += policeProb * 0.5;

    // Bonus: active speakers are threats (they influence votes)
    const speakRatio = (chatBehavior.speakCount[t.id] || 0) / maxSpoken;
    score += speakRatio * 0.3;

    // Penalty: likely protected by doctor/agent — avoid wasting a kill
    const protectionLikelihood = doctorProb * 0.4 + agentProb * 0.3;
    score -= protectionLikelihood * 0.6;

    // Penalty: same person was killed last night and survived → likely protected
    const lastSummary = state.lastNightSummary || [];
    for (const entry of lastSummary) {
      if (typeof entry === "string" && entry.includes(t.name) && entry.includes("saved")) {
        score -= 0.4;
      }
    }

    if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

// ─── Night Actions ─────────────────────────────────────────────────────────

export function buildAiNightActions(state, opts = {}) {
  const includeHuman = opts.includeHuman === true;
  const humanChoice = opts.humanChoice || null;
  const humanActionsRaw = opts.humanActions || null;
  const human = state.players.find((p) => p.isHuman);
  const hard = isHard(state);
  ensureBeliefs(state);
  const actions = [];

  const humanActionList = [];
  if (Array.isArray(humanActionsRaw)) {
    for (const a of humanActionsRaw) {
      if (a && typeof a.actorId === "number") humanActionList.push(a);
    }
  } else if (humanActionsRaw && typeof humanActionsRaw === "object") {
    for (const [actorIdStr, a] of Object.entries(humanActionsRaw)) {
      if (!a) continue;
      const actorId = a.actorId ?? Number(actorIdStr);
      humanActionList.push({ ...a, actorId });
    }
  }

  const pickHumanTarget = (actionType) => {
    const candidates = humanActionList.filter(
      (a) => a.type === actionType && typeof a.targetId === "number"
    );
    if (!candidates.length) return null;
    const choiceIdx = Math.floor(state.rng() * candidates.length);
    return getPlayer(state, candidates[choiceIdx].targetId) || null;
  };

  // Pre-pick a shared killer target to avoid split votes.
  const killerActors = alivePlayers(state).filter((p) => p.role === Roles.KILLER.id && (!p.isHuman || includeHuman));
  const humanKillerTarget = pickHumanTarget("KILLER_VOTE");
  let sharedKillerTarget = humanKillerTarget;
  if (!sharedKillerTarget) {
    // Hard+: use smart targeting instead of simple group suspicion
    if (hard && killerActors.length > 0) {
      sharedKillerTarget = pickKillerSmartTarget(state, killerActors[0]);
    } else {
      sharedKillerTarget =
        state.rng() < 0.6
          ? pickGroupTarget(state, killerActors, (t) => t.role !== Roles.KILLER.id)
          : null;
    }
  }
  // Pre-pick a shared police target to avoid split votes.
  const policeActors = alivePlayers(state).filter((p) => p.role === Roles.POLICE.id && (!p.isHuman || includeHuman));
  const humanPoliceTarget = pickHumanTarget("POLICE_INVESTIGATE");
  let sharedPoliceTarget =
    humanPoliceTarget ||
    pickGroupTarget(
      state,
      policeActors,
      (t) => t.role !== Roles.POLICE.id
    );
  if (!sharedPoliceTarget) {
    sharedPoliceTarget = randomChoice(
      alivePlayers(state).filter((t) => t.role !== Roles.POLICE.id),
      state.rng
    );
  }
  if (
    humanChoice &&
    human?.role === Roles.POLICE.id &&
    typeof humanChoice.targetId === "number" &&
    state.rng() < 0.75
  ) {
    sharedPoliceTarget = getPlayer(state, humanChoice.targetId) || sharedPoliceTarget;
  }
  // Pre-pick shared grudge target (follow human if present, else group).
  const grudgeActors = alivePlayers(state).filter((p) => p.role === Roles.GRUDGE_BEAST.id && (!p.isHuman || includeHuman));
  const humanGrudgeTarget =
    pickHumanTarget("GRUDGE_JUDGE") ||
    pickHumanTarget("GRUDGE_KILL_VOTE");
  let sharedGrudgeTarget = humanGrudgeTarget;
  if (
    !sharedGrudgeTarget &&
    humanChoice &&
    human?.role === Roles.GRUDGE_BEAST.id &&
    typeof humanChoice.targetId === "number"
  ) {
    sharedGrudgeTarget = getPlayer(state, humanChoice.targetId) || null;
  }
  if (!sharedGrudgeTarget) {
    sharedGrudgeTarget = pickGroupTarget(
      state,
      grudgeActors,
      (t) => t.role !== Roles.GRUDGE_BEAST.id
    );
  }

  for (const actor of alivePlayers(state)) {
    if (actor.isHuman && !includeHuman) continue;
    switch (actor.role) {
      case Roles.POLICE.id: {
        const target =
          sharedPoliceTarget ||
          pickPoliceSmartTarget(state, actor) ||
          pickTargetBySuspicion(state, actor, (t) => t.role !== Roles.POLICE.id);
        if (target) actions.push({ actorId: actor.id, type: "POLICE_INVESTIGATE", targetId: target.id });
        break;
      }
      case Roles.KILLER.id: {
        let target = sharedKillerTarget;
        if (!target) {
          if (hard) {
            target = pickKillerSmartTarget(state, actor);
          }
          if (!target) {
            let best = null;
            let bestScore = -Infinity;
            for (const t of shuffled(alivePlayers(state), state.rng)) {
              if (t.role === Roles.KILLER.id) continue;
              const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0;
              const priority = blueProb + (actor.aiMemory?.suspicion?.[t.id] ?? 0.5);
              if (priority > bestScore || (priority === bestScore && state.rng() < 0.5)) {
                bestScore = priority;
                best = t;
              }
            }
            target = best;
          }
        }
        if (target) actions.push({ actorId: actor.id, type: "KILLER_VOTE", targetId: target.id });
        break;
      }
      case Roles.DOCTOR.id: {
        if (state.usage.doctorInjections < (Roles.DOCTOR.maxInjections || 0)) {
          let target = actor;
          // Hard+: self-protect decision based on self-threat level
          const selfThreat = actor.aiMemory?.selfThreat ?? 0;
          const selfProtectChance = hard
            ? clamp(0.15 + selfThreat * 0.6, 0.15, 0.7) // high threat = more self-protect
            : 0.3;
          if (state.rng() > selfProtectChance) {
            // Protect someone else
            let best = null;
            let bestScore = -Infinity;
            for (const t of shuffled(alivePlayers(state), state.rng)) {
              if (t.id === actor.id) continue;
              const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
              const specialProb =
                (actor.aiMemory?.roleProbs?.[t.id]?.[Roles.POLICE.id] ?? 0) +
                (actor.aiMemory?.roleProbs?.[t.id]?.[Roles.DOCTOR.id] ?? 0) +
                (actor.aiMemory?.roleProbs?.[t.id]?.[Roles.AGENT?.id] ?? 0);
              let score = blueProb + specialProb;
              // Hard+: boost score for players who spoke a lot (killers target active players)
              if (hard) {
                const chatBehavior = analyzeChatBehavior(state);
                const maxSpoken = Math.max(1, ...Object.values(chatBehavior.speakCount || {}));
                const speakRatio = (chatBehavior.speakCount[t.id] || 0) / maxSpoken;
                score += speakRatio * 0.2;
              }
              if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
                bestScore = score;
                best = t;
              }
            }
            target = best || actor;
          }
          if (target) actions.push({ actorId: actor.id, type: "DOCTOR_INJECT", targetId: target.id });
        }
        break;
      }
      case Roles.SNIPER.id: {
        if (state.usage.sniperShots < (Roles.SNIPER.maxShots || 0)) {
          // Hard+: conservative early, aggressive late (more info = better aim)
          let activateChance = 0.6;
          if (hard) {
            const dayNum = state.dayNumber || 1;
            // Day 1: 30%, Day 2: 45%, Day 3+: 65%+
            activateChance = clamp(0.15 + dayNum * 0.15, 0.2, 0.75);
          }
          if (state.rng() < activateChance) {
            const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
            if (target) actions.push({ actorId: actor.id, type: "SNIPER_SHOT", targetId: target.id });
          }
        }
        break;
      }
      case Roles.AGENT.id: {
        let best = null;
        let bestScore = -Infinity;
        for (const t of alivePlayers(state)) {
          if (t.id === actor.id) continue;
          const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
          const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
          const score = blueProb - redProb;
          if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
            bestScore = score;
            best = t;
          }
        }
        const target = best || pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
        if (target) actions.push({ actorId: actor.id, type: "AGENT_PROTECT", targetId: target.id });
        break;
      }
      case Roles.HEAVENLY_FIEND.id: {
        if (actor.status.fiendMode === "ABSORB") {
          let best = null;
          let bestScore = -Infinity;
          for (const t of shuffled(alivePlayers(state), state.rng)) {
            if (t.id === actor.id) continue;
            const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
            const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
            const score = blueProb - redProb;
            if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
              bestScore = score;
              best = t;
            }
          }
          const target = best || pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "FIEND_PROTECT", targetId: target.id });
        } else {
          const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "FIEND_SHOOT", targetId: target.id });
        }
        break;
      }
      case Roles.TERRORIST.id: {
        // Hard+: terrorist triggers when self-threat is high (about to be voted out = suicide bomb)
        let triggerChance = 0.65;
        if (hard) {
          const selfThreat = actor.aiMemory?.selfThreat ?? 0;
          // Low threat = hold bomb (20%), high threat = use it (80%)
          triggerChance = clamp(0.1 + selfThreat * 0.8, 0.1, 0.85);
        }
        if (state.rng() < triggerChance) {
          const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "TERROR_BOMB", targetId: target.id });
        }
        break;
      }
      case Roles.COWBOY.id: {
        const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
        if (target) actions.push({ actorId: actor.id, type: "COWBOY_GAMBLE", targetId: target.id });
        break;
      }
      case Roles.KIDNAPPER.id: {
        let best = null;
        let bestScore = -Infinity;
        for (const t of shuffled(alivePlayers(state), state.rng)) {
          if (t.id === actor.id) continue;
          if (actor.lastKidnapTarget !== null && t.id === actor.lastKidnapTarget) continue;
          const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
          const score = redProb + (actor.aiMemory?.suspicion?.[t.id] ?? 0.5);
          if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
            bestScore = score;
            best = t;
          }
        }
        const target = best || pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
        if (target) actions.push({ actorId: actor.id, type: "KIDNAP", targetId: target.id });
        break;
      }
      case Roles.ZOMBIE.id: {
        const target = pickZombieTarget(state, actor);
        if (target) actions.push({ actorId: actor.id, type: "ZOMBIE_BITE", targetId: target.id });
        break;
      }
      case Roles.RIOT_POLICE.id: {
        if (state.usage.riotGrenades < (Roles.RIOT_POLICE.maxGrenades || 0)) {
          const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "RIOT_SMOKE", targetId: target.id });
        }
        break;
      }
      case Roles.ARSONIST.id: {
        const marked = state.players.filter((p) => p.status.arsonMarked && p.alive).length;
        const doIgnite = marked >= 2 || state.rng() > 0.65;
        if (doIgnite) {
          actions.push({ actorId: actor.id, type: "ARSON_IGNITE" });
        } else {
          const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "ARSON_MARK", targetId: target.id });
        }
        break;
      }
      case Roles.VINE_DEMON.id: {
        const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
        if (target) actions.push({ actorId: actor.id, type: "VINE_SEED", targetId: target.id });
        break;
      }
      case Roles.NIGHTMARE_DEMON.id: {
        const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
        if (target) actions.push({ actorId: actor.id, type: "NIGHTMARE_ATTACK", targetId: target.id });
        break;
      }
      case Roles.EXORCIST.id: {
        if ((actor.exorcistMistakes || 0) >= 3) break;
        const maxChains = Math.max(0, actor.maxChains ?? Roles.EXORCIST.maxChain);
        if (maxChains <= 0) break;
        const ordered = shuffled(alivePlayers(state), state.rng)
          .filter((t) => t.id !== actor.id)
          .sort((a, b) => {
          const sa = actor.aiMemory?.suspicion?.[a.id] ?? 0.5;
          const sb = actor.aiMemory?.suspicion?.[b.id] ?? 0.5;
          return sb - sa;
        });
        const picks = ordered.slice(0, maxChains);
        for (const t of picks) {
          actions.push({ actorId: actor.id, type: "EXORCIST_STRIKE", targetId: t.id });
        }
        break;
      }
      case Roles.NECROMANCER.id: {
        if (actor.souls >= 2) {
          const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "NECROMANCER_CURSE", targetId: target.id });
        }
        break;
      }
      case Roles.PURIFIER.id: {
        const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
        if (target) actions.push({ actorId: actor.id, type: "PURIFY", targetId: target.id });
        break;
      }
      case Roles.GRUDGE_BEAST.id: {
        const leaderChoice = sharedGrudgeTarget && sharedGrudgeTarget.alive ? sharedGrudgeTarget : null;
        if (state.grudgeState.berserk) {
          const target =
            leaderChoice ||
            pickTargetBySuspicion(state, actor, (t) => t.role !== Roles.GRUDGE_BEAST.id);
          if (target) actions.push({ actorId: actor.id, type: "GRUDGE_KILL_VOTE", targetId: target.id });
        } else {
          const target =
            leaderChoice ||
            pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "GRUDGE_JUDGE", targetId: target.id });
        }
        break;
      }
      default:
        break;
    }
  }
  return actions;
}

// ─── Voting ────────────────────────────────────────────────────────────────

export function buildAiVoteActions(state, humanVoteTargetId = null, opts = {}) {
  const includeHuman = opts.includeHuman === true;
  const hard = isHard(state);
  ensureBeliefs(state);
  const chatMentions = {};
  const chats = state.dayChat || [];
  for (const line of chats) {
    for (const player of state.players) {
      if (!player) continue;
      const name = player.name;
      if (line.includes(name)) {
        chatMentions[player.id] = (chatMentions[player.id] || 0) + 1;
      }
    }
  }
  const maxMention = Math.max(1, ...Object.values(chatMentions));
  const chatWeight = (id) => (chatMentions[id] || 0) / maxMention;

  // Hard+: behavioral analysis for vote scoring
  const votePatterns = hard ? analyzeVotingPatterns(state) : null;

  const votes = [];
  const aiVoters = alivePlayers(state).filter(
    (p) => (includeHuman || !p.isHuman) && !(p.role === Roles.BRAT.id && p.status.bratRevived)
  );
  const randomVoteChance = { easy: 0.8, normal: 0.6, hard: 0.2, nightmare: 0.05 };
  const chaosVoteChance = randomVoteChance[state.difficulty || "normal"] ?? 0.6;

  // Hard+: Killers pre-coordinate to scatter votes (avoid all voting the same target)
  const killerVoteTargets = new Set();

  aiVoters.forEach((actor, idx) => {
    // force at least one vote by making the last AI always vote
    const abstainChance = idx === aiVoters.length - 1 ? 0 : 0.05;
    if (state.rng() < abstainChance) return;
    const roll = state.rng();
    const jitter = (val) => clamp(val + (state.rng() - 0.5) * 0.3, 0, 1);
    const everyone = alivePlayers(state).filter((t) => t.id !== actor.id && t.alive && t.id !== humanVoteTargetId);
    // if police found a red, only police use it to focus vote
    if (state.policeRevealedRed !== null && actor.role === Roles.POLICE.id) {
      const redTarget = getPlayer(state, state.policeRevealedRed);
      if (redTarget?.alive) {
        votes.push({ actorId: actor.id, type: "VOTE_EXECUTE", targetId: redTarget.id });
        return;
      }
    }
    if (state.policeRevealedRed !== null && actor.faction === Faction.BLUE && actor.role !== Roles.POLICE.id) {
      const redTarget = getPlayer(state, state.policeRevealedRed);
      const followPoliceChance = { easy: 0.5, normal: 0.7, hard: 0.95, nightmare: 0.98 };
      const chance = followPoliceChance[state.difficulty || "normal"] ?? 0.7;
      if (redTarget?.alive && state.rng() < chance) {
        votes.push({ actorId: actor.id, type: "VOTE_EXECUTE", targetId: redTarget.id });
        return;
      }
    }
    const pruned =
      actor.role === Roles.KILLER.id
        ? everyone.filter((t) => t.role !== Roles.KILLER.id)
        : everyone;
    const candidates = pruned.length ? pruned : everyone;

    // Hard+ 紅方策略投票
    if (hard && actor.faction === Faction.RED) {
      const redTargetId = state.policeRevealedRed;
      const exposedRed =
        redTargetId !== null ? getPlayer(state, redTargetId) : null;

      // Only sell out exposed teammates (police-confirmed), not hidden allies
      if (exposedRed?.alive && exposedRed.id !== actor.id) {
        // Check if teammate is likely to die anyway (many votes against them)
        const lastTally = state.history?.votes?.[state.history.votes.length - 1]?.tally || {};
        const exposedVotes = lastTally[exposedRed.id] || 0;
        const aliveCount = alivePlayers(state).length;
        const likelyToDie = exposedVotes >= aliveCount * 0.3;
        // Sell out when they're likely dead anyway (ride the wave), or occasionally to build trust
        const sellChance = likelyToDie ? 0.7 : 0.3;
        if (state.rng() < sellChance) {
          votes.push({ actorId: actor.id, type: "VOTE_EXECUTE", targetId: exposedRed.id });
          return;
        }
      }

      // Hard+ killer vote scatter: avoid all killers voting same non-exposed target
      if (actor.role === Roles.KILLER.id && killerVoteTargets.size > 0) {
        const scatterCandidates = candidates.filter((t) => !killerVoteTargets.has(t.id));
        if (scatterCandidates.length > 0 && state.rng() < 0.6) {
          const target = randomChoice(scatterCandidates, state.rng);
          if (target) {
            killerVoteTargets.add(target.id);
            votes.push({ actorId: actor.id, type: "VOTE_EXECUTE", targetId: target.id });
            return;
          }
        }
      }
    }

    let target = null;
    if (roll < chaosVoteChance) {
      target = randomChoice(candidates, state.rng);
    } else {
      let best = null;
      let bestScore = -Infinity;
      for (const t of candidates) {
        const redProb = actor.aiMemory?.suspicion?.[t.id] ?? 0.5;
        const base = jitter(redProb);
        const chatBonus = actor.role !== Roles.POLICE.id ? chatWeight(t.id) * 0.05 : 0;
        let s = clamp(base + chatBonus, 0, 1);

        // Hard+: behavioral voting bonuses
        if (hard && votePatterns) {
          // Bonus: players who voted together with known-dead reds are suspicious
          for (const dead of state.players.filter((dp) => !dp.alive && dp.faction === Faction.RED)) {
            const togetherCount = votePatterns.votedTogether[t.id]?.[dead.id] || 0;
            if (togetherCount > 0) {
              s += 0.08 * togetherCount;
            }
          }
          // Penalty: players who voted together with me are less suspicious
          const withMe = votePatterns.votedTogether[t.id]?.[actor.id] || 0;
          if (withMe > 0 && actor.faction === Faction.BLUE) {
            s -= 0.05 * withMe;
          }
        }

        s = clamp(s, 0, 1);
        if (s > bestScore || (s === bestScore && state.rng() < 0.5)) {
          bestScore = s;
          best = t;
        }
      }
      target = best || randomChoice(candidates, state.rng);
    }
    if (target) {
      if (hard && actor.role === Roles.KILLER.id) killerVoteTargets.add(target.id);
      votes.push({ actorId: actor.id, type: "VOTE_EXECUTE", targetId: target.id });
    }
  });

  if (votes.length === 0 && aiVoters.length > 0) {
    const actor = aiVoters[0];
    const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id && t.alive);
    if (target) votes.push({ actorId: actor.id, type: "VOTE_EXECUTE", targetId: target.id });
  }
  return votes;
}

// ─── Chat Generation ───────────────────────────────────────────────────────

// Chat templates categorized by type for more human-like variety
const CHAT_TEMPLATES = {
  accuse: [
    (s, t) => `${s}: I think ${t} is suspicious.`,
    (s, t) => `${s}: ${t} feels off to me.`,
    (s, t) => `${s}: Something about ${t} doesn't add up.`,
    (s, t) => `${s}: We should look into ${t}.`,
    (s, t) => `${s}: ${t} has been acting weird.`,
    (s, t) => `${s}: I don't trust ${t} at all.`,
  ],
  defend: [
    (s, t) => `${s}: I think ${t} is on our side.`,
    (s, t) => `${s}: ${t} seems fine to me.`,
    (s, t) => `${s}: Leave ${t} alone, they're not the problem.`,
    (s, t) => `${s}: ${t} has been helpful so far.`,
  ],
  wonder: [
    (s, t) => `${s}: What does everyone think about ${t}?`,
    (s, t) => `${s}: I'm not sure about ${t} yet.`,
    (s, t) => `${s}: Anyone have thoughts on ${t}?`,
    (s, t) => `${s}: ${t} is hard to read...`,
  ],
  // Hard+ vote reference
  voteRef: [
    (s, t, extra) => `${s}: ${t} voted for ${extra} last time, that's suspicious.`,
    (s, t, extra) => `${s}: Why did ${t} switch their vote to ${extra}?`,
    (s, t, extra) => `${s}: ${t} keeps targeting ${extra}, are they allies?`,
  ],
  // Hard+ death reference
  deathRef: [
    (s, t, dead) => `${s}: ${t} defended ${dead} before they died... think about that.`,
    (s, t, dead) => `${s}: Ever since ${dead} died, ${t} has been quiet.`,
    (s, t, dead) => `${s}: After ${dead} died, I started watching ${t} more closely.`,
  ],
  // Hard+ red deception
  bluff: [
    (s, t) => `${s}: I'm pretty sure ${t} is the killer.`,
    (s, t) => `${s}: ${t} is definitely suspicious, I've been watching them.`,
    (s, t) => `${s}: We need to vote ${t} out today!`,
    (s, t) => `${s}: Trust me on this, ${t} is not who they seem.`,
  ],
  // Hard+ red strategic silence (say nothing useful)
  deflect: [
    (s) => `${s}: I'm not sure who to suspect right now.`,
    (s) => `${s}: Let's think about this carefully.`,
    (s) => `${s}: I want to hear what others think first.`,
    (s) => `${s}: This is getting complicated...`,
  ],
  // Hard+ strategic police reveal
  policeReveal: [
    (s, t) => `${s}: I investigated ${t} and they're RED!`,
    (s, t) => `${s}: ${t} is confirmed red, we need to vote them out.`,
  ],
  policeClear: [
    (s, t) => `${s}: I checked ${t}, they're clean.`,
    (s, t) => `${s}: ${t} is confirmed blue, leave them alone.`,
  ],
};

function pickTemplate(rng, templates) {
  return templates[Math.floor(rng() * templates.length)];
}

export function generateChatLines(state, maxLines = 6) {
  const lines = [];
  const living = alivePlayers(state).filter((p) => !p.isHuman);
  const hard = isHard(state);
  const redFound = state.policeRevealedRed !== null ? getPlayer(state, state.policeRevealedRed) : null;
  const voteHist = state.history?.votes || [];
  const lastRound = voteHist[voteHist.length - 1];
  const recentDeaths = state.players.filter((p) => !p.alive && p.deathCause);

  // Shuffle speakers for natural order variety
  const speakers = shuffled(living, state.rng);

  for (const speaker of speakers) {
    if (lines.length >= maxLines) break;

    // Hard+: some speakers skip (not everyone talks every round)
    if (hard && state.rng() < 0.15) continue;

    const allCandidates = alivePlayers(state).filter((t) => t.id !== speaker.id);
    const isRedSpeaker = speaker.faction === Faction.RED;

    // ── Police strategic reveal ──
    if (speaker.role === Roles.POLICE.id && redFound?.alive && state.rng() < 0.8) {
      const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.policeReveal);
      lines.push(tmpl(speaker.name, redFound.name));
      continue;
    }

    // ── Hard+ RED deception strategies ──
    if (hard && isRedSpeaker) {
      const deceptionRoll = state.rng();

      // 20%: Strategic deflection (say nothing useful)
      if (deceptionRoll < 0.2) {
        const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.deflect);
        lines.push(tmpl(speaker.name));
        continue;
      }

      // 25%: Bluff — aggressively accuse an innocent
      if (deceptionRoll < 0.45) {
        const innocents = allCandidates.filter((t) => t.faction !== Faction.RED);
        const bluffTarget = randomChoice(innocents.length ? innocents : allCandidates, state.rng);
        if (bluffTarget) {
          const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.bluff);
          lines.push(tmpl(speaker.name, bluffTarget.name));
          continue;
        }
      }

      // 15%: Defend a red ally subtly
      if (deceptionRoll < 0.6) {
        const allies = allCandidates.filter((t) => t.role === Roles.KILLER.id);
        const defendAlly = randomChoice(allies, state.rng);
        if (defendAlly) {
          const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.defend);
          lines.push(tmpl(speaker.name, defendAlly.name));
          continue;
        }
      }
      // else: fall through to normal chat
    }

    // ── Hard+ vote/death references ──
    if (hard && state.rng() < 0.35 && lastRound) {
      // Reference someone's voting behavior
      const flips = lastRound.flips || [];
      if (flips.length > 0 && state.rng() < 0.5) {
        const flipperId = randomChoice(flips, state.rng);
        const flipper = getPlayer(state, flipperId);
        if (flipper?.alive) {
          const voteTarget = lastRound.order?.find((e) => e.actorId === flipperId);
          const votedFor = voteTarget ? getPlayer(state, voteTarget.targetId) : null;
          if (votedFor) {
            const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.voteRef);
            lines.push(tmpl(speaker.name, flipper.name, votedFor.name));
            continue;
          }
        }
      }
      // Reference a recent death
      if (recentDeaths.length > 0 && state.rng() < 0.4) {
        const dead = randomChoice(recentDeaths, state.rng);
        const suspect = randomChoice(allCandidates, state.rng);
        if (dead && suspect) {
          const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.deathRef);
          // Some templates use 2 args, some 3
          lines.push(tmpl(speaker.name, suspect.name, dead.name));
          continue;
        }
      }
    }

    // ── Standard chat (improved with template variety) ──
    const target =
      state.rng() < 0.5
        ? randomChoice(allCandidates, state.rng)
        : pickTargetBySuspicion(
            state,
            speaker,
            (t) => t.alive && t.id !== speaker.id
          );
    const useTarget = target;
    const suspicion = speaker.aiMemory?.suspicion?.[useTarget?.id] ?? 0.5;
    const tone = suspicion > 0.7 ? "accuse" : suspicion < 0.3 ? "defend" : "wonder";
    const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES[tone]);
    const tName = (tone === "defend" && !useTarget)
      ? randomChoice(allCandidates, state.rng)?.name ?? "someone"
      : useTarget?.name ?? "someone";
    lines.push(tmpl(speaker.name, tName));
  }
  return lines;
}
