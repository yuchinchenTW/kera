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
        // Hard+: predict who killers will target (active speakers, police candidates)
        // and protect them instead of just highest blue prob
        let best = null;
        let bestScore = -Infinity;
        const chatInfo = hard ? analyzeChatBehavior(state) : null;
        const maxSpoken = chatInfo ? Math.max(1, ...Object.values(chatInfo.speakCount || {})) : 1;
        for (const t of alivePlayers(state)) {
          if (t.id === actor.id) continue;
          const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
          const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
          let score = blueProb - redProb;
          if (hard) {
            // Killers target active speakers and police — mirror their logic
            const policeProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.POLICE.id] ?? 0;
            score += policeProb * 0.4;
            const speakRatio = (chatInfo?.speakCount[t.id] || 0) / maxSpoken;
            score += speakRatio * 0.25;
            // If someone was saved last night, they're likely targeted again
            for (const entry of state.lastNightSummary || []) {
              if (typeof entry === "string" && entry.includes(t.name) && entry.includes("saved")) {
                score += 0.3;
              }
            }
          }
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
          // Hard+: same logic as agent — predict killer targets
          let best = null;
          let bestScore = -Infinity;
          const fiendChat = hard ? analyzeChatBehavior(state) : null;
          const fiendMaxSpoken = fiendChat ? Math.max(1, ...Object.values(fiendChat.speakCount || {})) : 1;
          for (const t of shuffled(alivePlayers(state), state.rng)) {
            if (t.id === actor.id) continue;
            const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
            const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
            let score = blueProb - redProb;
            if (hard) {
              const policeProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.POLICE.id] ?? 0;
              score += policeProb * 0.4;
              const speakRatio = (fiendChat?.speakCount[t.id] || 0) / fiendMaxSpoken;
              score += speakRatio * 0.25;
            }
            if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
              bestScore = score;
              best = t;
            }
          }
          const target = best || pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "FIEND_PROTECT", targetId: target.id });
        } else {
          // CHARGE mode: Hard+ pick highest red-prob, not just suspicion
          let best = null;
          let bestScore = -Infinity;
          for (const t of alivePlayers(state)) {
            if (t.id === actor.id) continue;
            const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
            const killerProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.KILLER.id] ?? 0;
            const score = hard ? (killerProb * 2 + redProb) : redProb;
            if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
              bestScore = score;
              best = t;
            }
          }
          const target = best || pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
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
        // Hard+: only shoot when confidence is high enough (avoid wasting on uncertainty)
        if (hard) {
          const bestTarget = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (bestTarget) {
            const confidence = actor.aiMemory?.suspicion?.[bestTarget.id] ?? 0.5;
            // Day 1: need 70% confidence, Day 3+: 50% is enough
            const threshold = clamp(0.75 - (state.dayNumber || 1) * 0.08, 0.4, 0.75);
            if (confidence >= threshold) {
              actions.push({ actorId: actor.id, type: "COWBOY_GAMBLE", targetId: bestTarget.id });
            }
            // else: skip — hold the shot for a better opportunity
          }
        } else {
          const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "COWBOY_GAMBLE", targetId: target.id });
        }
        break;
      }
      case Roles.KIDNAPPER.id: {
        // Hard+: kidnap high-value blue targets to disable them (doctor, police, agent)
        // instead of targeting high-suspicion (which is red-leaning = your own team)
        let best = null;
        let bestScore = -Infinity;
        for (const t of shuffled(alivePlayers(state), state.rng)) {
          if (t.id === actor.id) continue;
          if (t.role === Roles.KILLER.id) continue; // never kidnap allies
          if (actor.lastKidnapTarget !== null && t.id === actor.lastKidnapTarget) continue;
          let score;
          if (hard) {
            const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
            const policeProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.POLICE.id] ?? 0;
            const doctorProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.DOCTOR.id] ?? 0;
            const agentProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.AGENT?.id] ?? 0;
            // Prioritize disabling doctor (prevents saves) and police (prevents investigation)
            score = blueProb + doctorProb * 0.8 + policeProb * 0.6 + agentProb * 0.4;
          } else {
            const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
            score = redProb + (actor.aiMemory?.suspicion?.[t.id] ?? 0.5);
          }
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
        // Hard+: prioritize finishing pending conversions (bite count tracking)
        // and avoid likely-protected targets
        if (hard) {
          let best = null;
          let bestScore = -Infinity;
          for (const t of shuffled(alivePlayers(state), state.rng)) {
            if (t.id === actor.id) continue;
            if (t.role === Roles.ZOMBIE.id) continue; // biting zombie = death
            const zombieProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.ZOMBIE.id] ?? 0;
            let score = 1 - zombieProb; // prefer non-zombies
            // Huge bonus: if target has pending conversion, finish them off
            if (t.status?.pendingZombieConversion) score += 1.0;
            // Bonus: if target was bitten before (zombieBites > 0), easier to convert
            if ((t.status?.zombieBites || 0) > 0) score += 0.5;
            // Penalty: likely protected by agent/doctor
            const doctorProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.DOCTOR.id] ?? 0;
            const agentProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.AGENT?.id] ?? 0;
            score -= (doctorProb + agentProb) * 0.3;
            if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
              bestScore = score;
              best = t;
            }
          }
          const target = best || pickZombieTarget(state, actor);
          if (target) actions.push({ actorId: actor.id, type: "ZOMBIE_BITE", targetId: target.id });
        } else {
          const target = pickZombieTarget(state, actor);
          if (target) actions.push({ actorId: actor.id, type: "ZOMBIE_BITE", targetId: target.id });
        }
        break;
      }
      case Roles.RIOT_POLICE.id: {
        if (state.usage.riotGrenades < (Roles.RIOT_POLICE.maxGrenades || 0)) {
          if (hard) {
            // Hard+: save grenades for confirmed/high-confidence red targets
            // Also consider smoking the revealed red to block their night action
            const remaining = (Roles.RIOT_POLICE.maxGrenades || 0) - state.usage.riotGrenades;
            let best = null;
            let bestScore = -Infinity;
            for (const t of alivePlayers(state)) {
              if (t.id === actor.id) continue;
              const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
              const killerProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.KILLER.id] ?? 0;
              let score = killerProb * 2 + redProb;
              // Big bonus for police-revealed red
              if (state.policeRevealedRed === t.id) score += 0.8;
              if (score > bestScore) {
                bestScore = score;
                best = t;
              }
            }
            // Only use if confidence is high enough, or few grenades left (use it or lose it)
            const confThreshold = remaining <= 1 ? 0.3 : 0.5;
            if (best && bestScore >= confThreshold) {
              actions.push({ actorId: actor.id, type: "RIOT_SMOKE", targetId: best.id });
            }
          } else {
            const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
            if (target) actions.push({ actorId: actor.id, type: "RIOT_SMOKE", targetId: target.id });
          }
        }
        break;
      }
      case Roles.ARSONIST.id: {
        const marked = state.players.filter((p) => p.status.arsonMarked && p.alive).length;
        if (hard) {
          // Hard+: be patient — mark more before igniting for bigger impact
          // Ignite when 3+ marked, or 2+ if self-threat is high (about to die)
          const selfThreat = actor.aiMemory?.selfThreat ?? 0;
          const igniteThreshold = selfThreat > 0.5 ? 1 : 3;
          if (marked >= igniteThreshold) {
            actions.push({ actorId: actor.id, type: "ARSON_IGNITE" });
          } else if (state.usage.arsonMarks < (Roles.ARSONIST.maxMarks || 4)) {
            // Mark high-value blue targets (police, doctor, agent)
            let best = null;
            let bestScore = -Infinity;
            for (const t of shuffled(alivePlayers(state), state.rng)) {
              if (t.id === actor.id || t.role === Roles.KILLER.id) continue;
              if (t.status.arsonMarked) continue; // already marked
              const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
              const policeProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.POLICE.id] ?? 0;
              const doctorProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.DOCTOR.id] ?? 0;
              const score = blueProb + policeProb * 0.5 + doctorProb * 0.4;
              if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
                bestScore = score;
                best = t;
              }
            }
            const target = best || pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id && !t.status.arsonMarked);
            if (target) actions.push({ actorId: actor.id, type: "ARSON_MARK", targetId: target.id });
          } else {
            // All marks used, ignite whatever we have
            if (marked > 0) actions.push({ actorId: actor.id, type: "ARSON_IGNITE" });
          }
        } else {
          const doIgnite = marked >= 2 || state.rng() > 0.65;
          if (doIgnite) {
            actions.push({ actorId: actor.id, type: "ARSON_IGNITE" });
          } else {
            const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
            if (target) actions.push({ actorId: actor.id, type: "ARSON_MARK", targetId: target.id });
          }
        }
        break;
      }
      case Roles.VINE_DEMON.id: {
        // Hard+: seed targets most likely to be touched by blue actions
        // (police investigation target, agent protection target, etc.)
        if (hard) {
          let best = null;
          let bestScore = -Infinity;
          for (const t of shuffled(alivePlayers(state), state.rng)) {
            if (t.id === actor.id || t.role === Roles.KILLER.id) continue;
            // High suspicion targets are likely to be investigated by police
            const suspicion = actor.aiMemory?.suspicion?.[t.id] ?? 0.5;
            // High blue prob targets are likely to be protected by agent
            const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
            // Best seed target: someone both suspicious AND likely blue (police will investigate)
            const score = suspicion * 0.6 + blueProb * 0.4;
            if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
              bestScore = score;
              best = t;
            }
          }
          const target = best || pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "VINE_SEED", targetId: target.id });
        } else {
          const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "VINE_SEED", targetId: target.id });
        }
        break;
      }
      case Roles.NIGHTMARE_DEMON.id: {
        // Hard+: prioritize unknown roles for intel, avoid re-scouting known roles
        // Attack civilians/brats for kills, attack unknowns for role info
        if (hard) {
          let best = null;
          let bestScore = -Infinity;
          const knownRoles = actor.aiMemory?.grudgeKnownRole || {};
          for (const t of shuffled(alivePlayers(state), state.rng)) {
            if (t.id === actor.id || t.role === Roles.KILLER.id) continue;
            const civProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.CIVILIAN.id] ?? 0;
            const bratProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.BRAT.id] ?? 0;
            // Civilians/brats die instantly — high value kill
            let score = (civProb + bratProb) * 1.5;
            // Unknown role intel is also valuable
            const maxRoleProb = Math.max(...Object.values(actor.aiMemory?.roleProbs?.[t.id] || {}), 0);
            const uncertainty = 1 - maxRoleProb; // high uncertainty = more info gain
            score += uncertainty * 0.4;
            if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
              bestScore = score;
              best = t;
            }
          }
          const target = best || pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "NIGHTMARE_ATTACK", targetId: target.id });
        } else {
          const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "NIGHTMARE_ATTACK", targetId: target.id });
        }
        break;
      }
      case Roles.EXORCIST.id: {
        if ((actor.exorcistMistakes || 0) >= 3) break;
        const maxChains = Math.max(0, actor.maxChains ?? Roles.EXORCIST.maxChain);
        if (maxChains <= 0) break;
        if (hard) {
          // Hard+: be careful with chains — only strike high-confidence red targets
          // Mistakes reduce maxChains, so avoid uncertain targets
          const mistakes = actor.exorcistMistakes || 0;
          const cautionLevel = mistakes * 0.15; // more mistakes = more cautious
          const candidates = shuffled(alivePlayers(state), state.rng)
            .filter((t) => t.id !== actor.id)
            .map((t) => ({
              player: t,
              redProb: factionProb(actor, t.id, Faction.RED) ?? 0.5,
              killerProb: actor.aiMemory?.roleProbs?.[t.id]?.[Roles.KILLER.id] ?? 0,
            }))
            .sort((a, b) => (b.killerProb * 2 + b.redProb) - (a.killerProb * 2 + a.redProb));
          const minConfidence = 0.4 + cautionLevel; // 0.4 base, up to 0.85 with 3 mistakes
          const picks = [];
          for (const c of candidates) {
            if (picks.length >= maxChains) break;
            if (c.redProb >= minConfidence) {
              picks.push(c.player);
            }
          }
          // If no confident targets, still strike the top 1 (use it or lose it)
          if (picks.length === 0 && candidates.length > 0 && candidates[0].redProb > 0.3) {
            picks.push(candidates[0].player);
          }
          for (const t of picks) {
            actions.push({ actorId: actor.id, type: "EXORCIST_STRIKE", targetId: t.id });
          }
        } else {
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
        }
        break;
      }
      case Roles.NECROMANCER.id: {
        if (actor.souls >= 2) {
          if (hard) {
            // Hard+: save souls for 3+ when possible (instant kill, harder to block)
            // Only use at 2 if self-threat is high (about to die, use it now)
            const selfThreat = actor.aiMemory?.selfThreat ?? 0;
            const useAt2 = selfThreat > 0.4 || state.rng() < 0.25;
            if (actor.souls >= 3 || useAt2) {
              // Target high-value blue: police > doctor > agent
              let best = null;
              let bestScore = -Infinity;
              for (const t of alivePlayers(state)) {
                if (t.id === actor.id || t.role === Roles.KILLER.id) continue;
                const policeProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.POLICE.id] ?? 0;
                const doctorProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.DOCTOR.id] ?? 0;
                const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
                const score = policeProb * 0.5 + doctorProb * 0.4 + blueProb;
                if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
                  bestScore = score;
                  best = t;
                }
              }
              const target = best || pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
              if (target) actions.push({ actorId: actor.id, type: "NECROMANCER_CURSE", targetId: target.id });
            }
            // else: hold souls, wait for 3+
          } else {
            const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
            if (target) actions.push({ actorId: actor.id, type: "NECROMANCER_CURSE", targetId: target.id });
          }
        }
        break;
      }
      case Roles.PURIFIER.id: {
        if (hard) {
          // Hard+: prioritize cleansing necromancers (wipe souls) and high-threat red
          // Also consider cleansing arsonist-marked allies to protect them
          let best = null;
          let bestScore = -Infinity;
          for (const t of alivePlayers(state)) {
            if (t.id === actor.id) continue;
            const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
            const necroProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.NECROMANCER.id] ?? 0;
            const killerProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.KILLER.id] ?? 0;
            let score = killerProb * 1.5 + redProb + necroProb * 1.0;
            // Bonus: revealed red — cleanse to block their night action
            if (state.policeRevealedRed === t.id) score += 0.6;
            if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
              bestScore = score;
              best = t;
            }
          }
          const target = best || pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "PURIFY", targetId: target.id });
        } else {
          const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "PURIFY", targetId: target.id });
        }
        break;
      }
      case Roles.GRUDGE_BEAST.id: {
        const leaderChoice = sharedGrudgeTarget && sharedGrudgeTarget.alive ? sharedGrudgeTarget : null;
        if (state.grudgeState.berserk) {
          // Berserk: vote to kill
          if (hard && !leaderChoice) {
            // Hard+: prioritize killing the faction that triggered berserk
            // If killers triggered it, hunt killers; if police triggered it, hunt police
            const triggerFaction = state.grudgeState.triggerFaction;
            let best = null;
            let bestScore = -Infinity;
            for (const t of shuffled(alivePlayers(state), state.rng)) {
              if (t.role === Roles.GRUDGE_BEAST.id) continue;
              let score = actor.aiMemory?.suspicion?.[t.id] ?? 0.5;
              if (triggerFaction === Faction.RED) {
                // Hunt killers — boost killer probability
                const killerProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.KILLER.id] ?? 0;
                score += killerProb * 1.0;
              } else if (triggerFaction === Faction.BLUE) {
                // Hunt police — boost police probability
                const policeProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.POLICE.id] ?? 0;
                score += policeProb * 1.0;
              }
              // Also factor in chat activity — active talkers are more threatening
              const chatInfo = analyzeChatBehavior(state);
              const maxSpoken = Math.max(1, ...Object.values(chatInfo.speakCount || {}));
              const speakRatio = (chatInfo.speakCount[t.id] || 0) / maxSpoken;
              score += speakRatio * 0.2;
              if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
                bestScore = score;
                best = t;
              }
            }
            const target = best || pickTargetBySuspicion(state, actor, (t) => t.role !== Roles.GRUDGE_BEAST.id);
            if (target) actions.push({ actorId: actor.id, type: "GRUDGE_KILL_VOTE", targetId: target.id });
          } else {
            const target =
              leaderChoice ||
              pickTargetBySuspicion(state, actor, (t) => t.role !== Roles.GRUDGE_BEAST.id);
            if (target) actions.push({ actorId: actor.id, type: "GRUDGE_KILL_VOTE", targetId: target.id });
          }
        } else {
          // Judging mode: pick who to judge
          if (hard && !leaderChoice) {
            // Hard+: strategically judge RED targets (reveals info to police, safe for grudge)
            // Avoid judging civilians (random grudge beast dies!)
            // Prefer high red-prob targets (judging red = info to police, no penalty)
            let best = null;
            let bestScore = -Infinity;
            for (const t of shuffled(alivePlayers(state), state.rng)) {
              if (t.id === actor.id || t.role === Roles.GRUDGE_BEAST.id) continue;
              const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
              const civProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.CIVILIAN.id] ?? 0;
              // Judging red = safe + useful; judging civilian = grudge beast dies
              let score = redProb * 1.5 - civProb * 1.0;
              // Blue non-civilian is medium risk (info goes to killers)
              const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
              score -= blueProb * 0.3;
              if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
                bestScore = score;
                best = t;
              }
            }
            const target = best || pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
            if (target) actions.push({ actorId: actor.id, type: "GRUDGE_JUDGE", targetId: target.id });
          } else {
            const target =
              leaderChoice ||
              pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
            if (target) actions.push({ actorId: actor.id, type: "GRUDGE_JUDGE", targetId: target.id });
          }
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

    // Hard+: Brat strategy — follow the majority, don't stand out
    // Before revealed: blend in by voting with the crowd
    if (hard && actor.role === Roles.BRAT.id && !actor.status.bratRevealed) {
      // Follow police reveal if available
      if (state.policeRevealedRed !== null) {
        const redTarget = getPlayer(state, state.policeRevealedRed);
        if (redTarget?.alive) {
          votes.push({ actorId: actor.id, type: "VOTE_EXECUTE", targetId: redTarget.id });
          return;
        }
      }
      // Otherwise vote with whoever has the most votes so far in this round
      if (votes.length > 0) {
        const tally = {};
        for (const v of votes) tally[v.targetId] = (tally[v.targetId] || 0) + 1;
        let topTarget = null;
        let topCount = 0;
        for (const [tid, cnt] of Object.entries(tally)) {
          if (cnt > topCount) { topCount = cnt; topTarget = Number(tid); }
        }
        if (topTarget !== null && topTarget !== actor.id) {
          votes.push({ actorId: actor.id, type: "VOTE_EXECUTE", targetId: topTarget });
          return;
        }
      }
      // Fallback: random safe vote
    }

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

// Bilingual chat templates. Each returns "EN||ZH" so the client can pick by locale.
const CHAT_TEMPLATES = {
  accuse: [
    (s, t) => `${s}: I think ${t} is suspicious.||${s}：我覺得 ${t} 很可疑。`,
    (s, t) => `${s}: ${t} feels off to me.||${s}：${t} 給我的感覺不太對勁。`,
    (s, t) => `${s}: Something about ${t} doesn't add up.||${s}：${t} 的行為有矛盾。`,
    (s, t) => `${s}: We should look into ${t}.||${s}：我們應該注意 ${t}。`,
    (s, t) => `${s}: ${t} has been acting weird.||${s}：${t} 一直表現得很奇怪。`,
    (s, t) => `${s}: I don't trust ${t} at all.||${s}：我完全不信任 ${t}。`,
  ],
  defend: [
    (s, t) => `${s}: I think ${t} is on our side.||${s}：我覺得 ${t} 是自己人。`,
    (s, t) => `${s}: ${t} seems fine to me.||${s}：${t} 看起來沒問題。`,
    (s, t) => `${s}: Leave ${t} alone, they're not the problem.||${s}：別針對 ${t} 了，問題不在他。`,
    (s, t) => `${s}: ${t} has been helpful so far.||${s}：${t} 到目前為止一直有在幫忙。`,
  ],
  wonder: [
    (s, t) => `${s}: What does everyone think about ${t}?||${s}：大家覺得 ${t} 怎麼樣？`,
    (s, t) => `${s}: I'm not sure about ${t} yet.||${s}：我對 ${t} 還拿不定主意。`,
    (s, t) => `${s}: Anyone have thoughts on ${t}?||${s}：有人注意到 ${t} 嗎？`,
    (s, t) => `${s}: ${t} is hard to read...||${s}：${t} 讓人看不透⋯`,
  ],
  voteRef: [
    (s, t, extra) => `${s}: ${t} voted for ${extra} last time, that's suspicious.||${s}：${t} 上次投了 ${extra}，很可疑。`,
    (s, t, extra) => `${s}: Why did ${t} switch their vote to ${extra}?||${s}：${t} 為什麼臨時改投 ${extra}？`,
    (s, t, extra) => `${s}: ${t} keeps targeting ${extra}, are they allies?||${s}：${t} 一直針對 ${extra}，他們是同夥嗎？`,
  ],
  deathRef: [
    (s, t, dead) => `${s}: ${t} defended ${dead} before they died... think about that.||${s}：${t} 在 ${dead} 死前幫他說話⋯大家想想。`,
    (s, t, dead) => `${s}: Ever since ${dead} died, ${t} has been quiet.||${s}：自從 ${dead} 死了之後，${t} 就不太說話了。`,
    (s, t, dead) => `${s}: After ${dead} died, I started watching ${t} more closely.||${s}：${dead} 死後我就一直在觀察 ${t}。`,
  ],
  bluff: [
    (s, t) => `${s}: I'm pretty sure ${t} is the killer.||${s}：我很確定 ${t} 就是殺手。`,
    (s, t) => `${s}: ${t} is definitely suspicious, I've been watching them.||${s}：${t} 絕對有問題，我一直在觀察他。`,
    (s, t) => `${s}: We need to vote ${t} out today!||${s}：今天一定要把 ${t} 投出去！`,
    (s, t) => `${s}: Trust me on this, ${t} is not who they seem.||${s}：相信我，${t} 不是表面看起來那樣。`,
  ],
  deflect: [
    (s) => `${s}: I'm not sure who to suspect right now.||${s}：我現在還不確定該懷疑誰。`,
    (s) => `${s}: Let's think about this carefully.||${s}：大家冷靜想想吧。`,
    (s) => `${s}: I want to hear what others think first.||${s}：我想先聽聽其他人的想法。`,
    (s) => `${s}: This is getting complicated...||${s}：事情越來越複雜了⋯`,
  ],
  policeReveal: [
    (s, t) => `${s}: I investigated ${t} and they're RED!||${s}：我查了 ${t}，他是紅方！`,
    (s, t) => `${s}: ${t} is confirmed red, we need to vote them out.||${s}：${t} 確認是紅方，必須投掉。`,
  ],
  policeClear: [
    (s, t) => `${s}: I checked ${t}, they're clean.||${s}：我查了 ${t}，他是好人。`,
    (s, t) => `${s}: ${t} is confirmed blue, leave them alone.||${s}：${t} 確認是藍方，別投他。`,
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

// ─── Faction Private Chat Generation ───────────────────────────────────────

const FACTION_CHAT = {
  killer: {
    // Discuss who to kill tonight
    targetPlan: [
      (s, t) => `${s}: Let's go for ${t} tonight.||${s}：今晚殺 ${t} 吧。`,
      (s, t) => `${s}: I think we should take out ${t}.||${s}：我覺得該除掉 ${t}。`,
      (s, t) => `${s}: ${t} is getting dangerous, target them.||${s}：${t} 越來越危險了，鎖定他。`,
    ],
    // Warn about threats
    threat: [
      (s, t) => `${s}: Watch out for ${t}, they might be police.||${s}：小心 ${t}，可能是警察。`,
      (s, t) => `${s}: ${t} is asking too many questions...||${s}：${t} 問太多問題了⋯`,
      (s, t) => `${s}: I think ${t} is onto us.||${s}：我覺得 ${t} 懷疑我們了。`,
    ],
    // Coordinate voting strategy
    voteStrategy: [
      (s, t) => `${s}: Vote separately today, don't all target the same person.||${s}：今天分散投票，別都投同一個人。`,
      (s, t) => `${s}: Let's frame ${t} in chat and vote them out.||${s}：白天帶風向指控 ${t}，把他投出去。`,
      (s, t) => `${s}: If they suspect one of us, the others should defend.||${s}：如果有人被懷疑，其他人幫忙辯護。`,
    ],
    // React to events
    react: [
      (s) => `${s}: We need to be careful, they're getting close.||${s}：要小心了，他們越來越接近真相。`,
      (s) => `${s}: Good, that went well last night.||${s}：不錯，昨晚很順利。`,
      (s) => `${s}: Things are getting tight, stay calm.||${s}：局勢越來越緊，大家冷靜。`,
      (s, t) => `${s}: ${t} is protected, don't waste a kill on them.||${s}：${t} 有人保護，別浪費機會。`,
    ],
    // Avoid doctor
    avoidProtected: [
      (s, t) => `${s}: ${t} was saved last night, skip them.||${s}：${t} 昨晚被救了，跳過他。`,
      (s, t) => `${s}: Someone is protecting ${t}, pick another target.||${s}：有人在保 ${t}，換目標吧。`,
    ],
  },
  police: {
    // Share investigation results
    shareIntel: [
      (s, t) => `${s}: I checked ${t}, they're RED.||${s}：我查了 ${t}，是紅方。`,
      (s, t) => `${s}: ${t} is confirmed blue, they're clean.||${s}：${t} 確認是藍方，沒問題。`,
      (s, t) => `${s}: Investigation result: ${t} is suspicious.||${s}：查驗結果：${t} 有嫌疑。`,
    ],
    // Discuss who to investigate
    investigatePlan: [
      (s, t) => `${s}: Let's check ${t} tonight.||${s}：今晚查 ${t} 吧。`,
      (s, t) => `${s}: We should investigate ${t}, they've been quiet.||${s}：應該查查 ${t}，他一直很安靜。`,
      (s, t) => `${s}: ${t} voted strangely, worth checking.||${s}：${t} 投票很奇怪，值得查。`,
    ],
    // Coordinate vote
    voteCoordinate: [
      (s, t) => `${s}: We all vote ${t} today, agreed?||${s}：今天大家都投 ${t}，同意嗎？`,
      (s, t) => `${s}: Focus fire on ${t}, don't split votes.||${s}：集火投 ${t}，別分散。`,
      (s) => `${s}: Let's not reveal too much in public chat.||${s}：公開發言別透露太多。`,
    ],
    // Analysis
    analysis: [
      (s, t) => `${s}: ${t} defended a known red last round.||${s}：${t} 上回合幫已知紅方說話。`,
      (s, t) => `${s}: ${t} keeps voting with the killers.||${s}：${t} 一直跟殺手投一樣的人。`,
      (s) => `${s}: We're losing people, need to be more aggressive.||${s}：我們一直在死人，要積極一點。`,
      (s) => `${s}: Who should we protect tonight?||${s}：今晚要保護誰？`,
    ],
  },
  grudge: {
    // Discuss judgment target
    judgePlan: [
      (s, t) => `${s}: Let's judge ${t}, I think they're red.||${s}：審判 ${t} 吧，我覺得他是紅方。`,
      (s, t) => `${s}: Don't judge ${t}, might be civilian — dangerous for us.||${s}：別審判 ${t}，可能是平民，會害到我們。`,
      (s, t) => `${s}: ${t} is worth judging, could reveal useful info.||${s}：${t} 值得審判，可能有有用的情報。`,
    ],
    // Berserk coordination
    berserkPlan: [
      (s, t) => `${s}: We're berserk now. Target ${t}.||${s}：我們狂暴了，鎖定 ${t}。`,
      (s, t) => `${s}: Let's hunt down ${t} tonight.||${s}：今晚獵殺 ${t}。`,
      (s) => `${s}: Focus on one faction, don't split.||${s}：專注打一個陣營，別分散。`,
    ],
    // Survival strategy
    survival: [
      (s) => `${s}: We need to stay alive, be careful with judgments.||${s}：我們要活下去，審判要謹慎。`,
      (s) => `${s}: If we judge wrong, one of us dies.||${s}：如果審判錯了，我們會死一個。`,
      (s) => `${s}: Let's lay low in public and not draw attention.||${s}：公開場合低調點，別引起注意。`,
    ],
  },
};

/**
 * Generate private faction chat lines for AI players.
 * Hard+: strategic discussions about targets, threats, coordination.
 * Normal/Easy: no faction chat.
 */
export function generateFactionChat(state) {
  if (!isHard(state)) return;

  const alive = alivePlayers(state);

  // ── Killer Chat ──
  const killers = alive.filter((p) => p.role === Roles.KILLER.id && !p.isHuman);
  if (killers.length > 0) {
    state.killerChat = state.killerChat || [];
    const speaker = randomChoice(killers, state.rng);
    if (speaker) {
      ensureAdvancedMemory(speaker);
      const nonKillers = alive.filter((t) => t.role !== Roles.KILLER.id);

      // Check if someone was saved last night
      const savedTarget = (state.lastNightSummary || []).find(
        (e) => typeof e === "string" && e.includes("saved")
      );

      const roll = state.rng();
      let line = null;

      if (savedTarget && state.rng() < 0.5) {
        // Warn about protected target
        const protectedName = nonKillers.find((t) =>
          typeof savedTarget === "string" && savedTarget.includes(t.name)
        );
        if (protectedName) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.killer.avoidProtected);
          line = tmpl(speaker.name, protectedName.name);
        }
      }

      if (!line) {
        // Pick highest-value target to discuss
        let bestTarget = null;
        let bestScore = -Infinity;
        for (const t of nonKillers) {
          const blueProb = factionProb(speaker, t.id, Faction.BLUE) ?? 0.5;
          const policeProb = speaker.aiMemory?.roleProbs?.[t.id]?.[Roles.POLICE.id] ?? 0;
          const score = blueProb + policeProb * 0.5;
          if (score > bestScore) { bestScore = score; bestTarget = t; }
        }
        const target = bestTarget || randomChoice(nonKillers, state.rng);

        if (roll < 0.35 && target) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.killer.targetPlan);
          line = tmpl(speaker.name, target.name);
        } else if (roll < 0.55 && target) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.killer.threat);
          line = tmpl(speaker.name, target.name);
        } else if (roll < 0.75 && target) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.killer.voteStrategy);
          line = tmpl(speaker.name, target.name);
        } else {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.killer.react);
          line = target ? tmpl(speaker.name, target.name) : tmpl(speaker.name);
        }
      }

      if (line) {
        state.killerChat.push(line);
        state.privateLogs.killer = state.privateLogs.killer || [];
        state.privateLogs.killer.push(line);
      }

      // Second killer may respond (50% chance)
      const otherKillers = killers.filter((k) => k.id !== speaker.id);
      if (otherKillers.length > 0 && state.rng() < 0.5) {
        const responder = randomChoice(otherKillers, state.rng);
        const target = randomChoice(nonKillers, state.rng);
        const roll2 = state.rng();
        let reply = null;
        if (roll2 < 0.4 && target) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.killer.targetPlan);
          reply = tmpl(responder.name, target.name);
        } else if (roll2 < 0.7) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.killer.react);
          reply = target ? tmpl(responder.name, target.name) : tmpl(responder.name);
        } else if (target) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.killer.threat);
          reply = tmpl(responder.name, target.name);
        }
        if (reply) {
          state.killerChat.push(reply);
          state.privateLogs.killer.push(reply);
        }
      }
    }
  }

  // ── Police Chat ──
  const police = alive.filter((p) => p.role === Roles.POLICE.id && !p.isHuman);
  if (police.length > 0) {
    state.policeChat = state.policeChat || [];
    const speaker = randomChoice(police, state.rng);
    if (speaker) {
      ensureAdvancedMemory(speaker);
      const nonPolice = alive.filter((t) => t.role !== Roles.POLICE.id);
      const roll = state.rng();
      let line = null;

      // If police have revealed a red, coordinate around it
      const revealedRed = state.policeRevealedRed !== null ? getPlayer(state, state.policeRevealedRed) : null;
      if (revealedRed?.alive && state.rng() < 0.5) {
        const tmpl = pickTemplate(state.rng, FACTION_CHAT.police.voteCoordinate);
        line = tmpl(speaker.name, revealedRed.name);
      }

      if (!line) {
        // Find most suspicious target to discuss
        let suspect = null;
        let highSusp = -1;
        for (const t of nonPolice) {
          const s = speaker.aiMemory?.suspicion?.[t.id] ?? 0.5;
          if (s > highSusp) { highSusp = s; suspect = t; }
        }
        const target = suspect || randomChoice(nonPolice, state.rng);

        if (roll < 0.3 && target) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.police.shareIntel);
          line = tmpl(speaker.name, target.name);
        } else if (roll < 0.55 && target) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.police.investigatePlan);
          line = tmpl(speaker.name, target.name);
        } else if (roll < 0.75 && target) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.police.voteCoordinate);
          line = tmpl(speaker.name, target.name);
        } else {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.police.analysis);
          line = target ? tmpl(speaker.name, target.name) : tmpl(speaker.name);
        }
      }

      if (line) {
        state.policeChat.push(line);
        state.privateLogs.police = state.privateLogs.police || [];
        state.privateLogs.police.push(line);
      }

      // Second police may respond
      const otherPolice = police.filter((p) => p.id !== speaker.id);
      if (otherPolice.length > 0 && state.rng() < 0.5) {
        const responder = randomChoice(otherPolice, state.rng);
        const target = randomChoice(nonPolice, state.rng);
        let reply = null;
        const roll2 = state.rng();
        if (roll2 < 0.4 && target) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.police.investigatePlan);
          reply = tmpl(responder.name, target.name);
        } else if (roll2 < 0.7 && target) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.police.analysis);
          reply = tmpl(responder.name, target.name);
        } else {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.police.analysis);
          reply = tmpl(responder.name);
        }
        if (reply) {
          state.policeChat.push(reply);
          state.privateLogs.police.push(reply);
        }
      }
    }
  }

  // ── Grudge Chat ──
  const grudge = alive.filter((p) => p.role === Roles.GRUDGE_BEAST.id && !p.isHuman);
  if (grudge.length > 0) {
    state.grudgeChat = state.grudgeChat || [];
    const speaker = randomChoice(grudge, state.rng);
    if (speaker) {
      ensureAdvancedMemory(speaker);
      const nonGrudge = alive.filter((t) => t.role !== Roles.GRUDGE_BEAST.id);
      const roll = state.rng();
      let line = null;

      const target = randomChoice(nonGrudge, state.rng);

      if (state.grudgeState.berserk) {
        if (roll < 0.6 && target) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.grudge.berserkPlan);
          line = tmpl(speaker.name, target.name);
        } else {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.grudge.berserkPlan);
          line = tmpl(speaker.name);
        }
      } else {
        if (roll < 0.4 && target) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.grudge.judgePlan);
          line = tmpl(speaker.name, target.name);
        } else if (roll < 0.7) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.grudge.survival);
          line = tmpl(speaker.name);
        } else if (target) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.grudge.judgePlan);
          line = tmpl(speaker.name, target.name);
        }
      }

      if (line) {
        state.grudgeChat.push(line);
        state.privateLogs.grudge = state.privateLogs.grudge || [];
        state.privateLogs.grudge.push(line);
      }
    }
  }
}

// ─── Last Words Generation ─────────────────────────────────────────────────

const LAST_WORDS_TEMPLATES = {
  // Blue player dies — try to leave useful intel
  blueAccuse: [
    (name, t) => `Watch out for ${t}...||小心 ${t}⋯`,
    (name, t) => `I'm sure ${t} is the killer.||我確定 ${t} 是殺手。`,
    (name, t) => `${t} did this to me. Don't let them get away.||是 ${t} 害我的，別放過他。`,
    (name, t) => `Vote ${t} next, trust me.||下次投 ${t}，相信我。`,
    (name, t) => `I've been watching ${t}... they're not clean.||我一直在觀察 ${t}⋯他不乾淨。`,
  ],
  blueDefend: [
    (name, t) => `Protect ${t}, they're one of us.||保護 ${t}，他是自己人。`,
    (name, t) => `${t} is innocent, I'm certain.||${t} 是無辜的，我很確定。`,
    (name, t) => `Don't vote ${t}, I checked them.||別投 ${t}，我查過了。`,
  ],
  blueGeneral: [
    (name) => `Don't trust the quiet ones...||別相信那些沉默的人⋯`,
    (name) => `Think about who voted for me.||想想誰投了我。`,
    (name) => `The truth will come out.||真相會大白的。`,
    (name) => `I did my best for the team.||我為大家盡力了。`,
  ],
  // Police dies — reveal investigation results
  policeReveal: [
    (name, t) => `I confirmed ${t} is RED!||我確認 ${t} 是紅方！`,
    (name, t) => `My investigation: ${t} is suspicious.||我的調查結果：${t} 有問題。`,
    (name, t) => `${t} is clean, protect them.||${t} 是好人，保護他。`,
  ],
  // Red player dies — mislead or frame innocents
  redBluff: [
    (name, t) => `I know ${t} is the killer...||我知道 ${t} 是殺手⋯`,
    (name, t) => `${t} betrayed me.||${t} 出賣了我。`,
    (name, t) => `Look into ${t}, something's off.||去查 ${t} 吧，有問題。`,
    (name, t) => `Don't trust ${t}.||別相信 ${t}。`,
  ],
  redProtectAlly: [
    (name, t) => `${t} is definitely clean.||${t} 絕對沒問題。`,
    (name, t) => `I trust ${t} with my life.||我用命擔保 ${t}。`,
  ],
  redDeflect: [
    (name) => `I was wrongly accused...||我是被冤枉的⋯`,
    (name) => `You got the wrong person.||你們抓錯人了。`,
    (name) => `This was a mistake, you'll see.||這是個錯誤，你們會明白的。`,
    (name) => `I'm innocent...||我是無辜的⋯`,
  ],
  // Green player dies
  greenGrudge: [
    (name) => `You'll pay for this...||你們會付出代價的⋯`,
    (name) => `The beasts will avenge me.||怨獸們會替我報仇。`,
    (name, t) => `${t} will regret this.||${t} 會後悔的。`,
  ],
  greenZombie: [
    (name) => `The infection spreads...||感染在蔓延⋯`,
    (name) => `It's too late to stop it.||已經來不及阻止了。`,
  ],
  // Generic (any role, low-info fallback)
  generic: [
    (name) => `...||⋯`,
    (name) => `Good luck everyone.||大家加油吧。`,
    (name) => `I have nothing to say.||我沒什麼好說的。`,
  ],
};

/**
 * Generate strategic last words for a dying AI player.
 * Hard+: uses role knowledge and suspicion to leave impactful messages.
 * Normal/Easy: generic or simple messages.
 */
export function generateLastWords(state, playerId) {
  const player = getPlayer(state, playerId);
  if (!player || player.alive) return "";
  if (player.noLastWords) return "";
  if (player.isHuman) return "";
  const hard = isHard(state);

  // Easy/Normal: mostly generic, occasionally accuse highest suspicion
  if (!hard) {
    if (state.rng() < 0.5) return "";  // 50% say nothing
    const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.generic);
    return tmpl(player.name);
  }

  // ── Hard+ strategic last words ──
  const alive = alivePlayers(state).filter((p) => p.id !== player.id);
  ensureAdvancedMemory(player);

  // Find highest suspicion target
  let mostSuspicious = null;
  let highestSusp = -1;
  // Find most trusted target (lowest suspicion)
  let mostTrusted = null;
  let lowestSusp = 2;
  for (const t of alive) {
    const s = player.aiMemory?.suspicion?.[t.id] ?? 0.5;
    if (s > highestSusp) { highestSusp = s; mostSuspicious = t; }
    if (s < lowestSusp) { lowestSusp = s; mostTrusted = t; }
  }

  // ── BLUE faction dying ──
  if (player.faction === Faction.BLUE) {
    // Police: reveal investigation intel
    if (player.role === Roles.POLICE.id) {
      // If there's a revealed red, reinforce it
      if (state.policeRevealedRed !== null) {
        const redTarget = getPlayer(state, state.policeRevealedRed);
        if (redTarget?.alive) {
          const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.policeReveal);
          return tmpl(player.name, redTarget.name);
        }
      }
      // Otherwise accuse most suspicious
      if (mostSuspicious && highestSusp > 0.5) {
        const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.policeReveal);
        return tmpl(player.name, mostSuspicious.name);
      }
    }

    // Doctor/Agent: defend who they were protecting or accuse likely killer
    if (player.role === Roles.DOCTOR.id || player.role === Roles.AGENT.id) {
      if (mostTrusted && state.rng() < 0.4) {
        const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.blueDefend);
        return tmpl(player.name, mostTrusted.name);
      }
    }

    // General blue: accuse most suspicious if confidence is high
    if (mostSuspicious && highestSusp > 0.55) {
      const roll = state.rng();
      if (roll < 0.6) {
        const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.blueAccuse);
        return tmpl(player.name, mostSuspicious.name);
      }
      if (roll < 0.8) {
        const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.blueGeneral);
        return tmpl(player.name);
      }
    }
    // Low confidence: generic
    const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.blueGeneral);
    return tmpl(player.name);
  }

  // ── RED faction dying ──
  if (player.faction === Faction.RED) {
    const roll = state.rng();
    // 35%: frame an innocent blue player
    if (roll < 0.35) {
      const innocents = alive.filter((t) => t.faction !== Faction.RED);
      const frameTarget = innocents.length > 0
        ? randomChoice(innocents, state.rng)
        : mostSuspicious;
      if (frameTarget) {
        const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.redBluff);
        return tmpl(player.name, frameTarget.name);
      }
    }
    // 20%: subtly defend a killer ally
    if (roll < 0.55) {
      const allies = alive.filter((t) => t.role === Roles.KILLER.id);
      if (allies.length > 0) {
        const ally = randomChoice(allies, state.rng);
        const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.redProtectAlly);
        return tmpl(player.name, ally.name);
      }
    }
    // 45%: deflect (claim innocence)
    const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.redDeflect);
    return tmpl(player.name);
  }

  // ── GREEN faction dying ──
  if (player.faction === Faction.GREEN) {
    if (player.role === Roles.GRUDGE_BEAST.id) {
      if (mostSuspicious && state.rng() < 0.5) {
        const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.greenGrudge);
        return tmpl(player.name, mostSuspicious.name);
      }
      const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.greenGrudge);
      return tmpl(player.name);
    }
    if (player.role === Roles.ZOMBIE.id) {
      const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.greenZombie);
      return tmpl(player.name);
    }
  }

  // Fallback
  const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.generic);
  return tmpl(player.name);
}
